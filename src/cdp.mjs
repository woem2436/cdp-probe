/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Why hand-rolled instead of a library: this tool exists to be run on a machine
 * where installing packages may be impossible (restricted registry, air-gapped
 * host, locked-down CI). Node >= 22.4 ships a global `WebSocket`, so the whole
 * protocol client fits in one file with no dependencies.
 */

import { ui } from './util.mjs';

const REQUIRED_NODE = '22.4.0';

function assertWebSocket() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This tool needs a global WebSocket, which Node provides from v${REQUIRED_NODE}. ` +
        `You are on ${process.version}. Upgrade Node, or run with --experimental-websocket on older builds.`,
    );
  }
}

/** Decode a WebSocket frame payload to a string regardless of how it arrived. */
function frameToString(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (data && typeof data.text === 'function') return data.text();
  return String(data);
}

export class CDP {
  /** @param {string} wsUrl browser-level or target-level websocket endpoint */
  constructor(wsUrl, { timeout = 30_000 } = {}) {
    this.wsUrl = wsUrl;
    this.timeout = timeout;
    this._nextId = 0;
    this._pending = new Map();
    this._listeners = new Map();
    this._ws = null;
    this._closed = false;
  }

  async connect() {
    assertWebSocket();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this._ws = ws;
      const onOpen = () => {
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = (ev) => {
        ws.removeEventListener('open', onOpen);
        reject(new Error(`could not connect to ${this.wsUrl}: ${ev?.message || 'websocket error'}`));
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('message', (ev) => this._onMessage(frameToString(ev.data)));
      ws.addEventListener('close', () => {
        this._closed = true;
        for (const [, p] of this._pending) {
          p.reject(new Error('CDP connection closed before the command completed'));
        }
        this._pending.clear();
      });
    });
    return this;
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // CDP sends only JSON; ignore anything else rather than crashing
    }

    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(
          `${p.method} failed: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`,
        );
        err.cdpError = msg.error;
        err.method = p.method;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
      for (const fn of this._listeners.get(key) || []) {
        try {
          fn(msg.params, msg.sessionId, msg);
        } catch (e) {
          ui.warn(`listener for ${msg.method} threw: ${e.message}`);
        }
      }
      for (const fn of this._listeners.get('*') || []) {
        try {
          fn(msg.params, msg.sessionId, msg);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Send a CDP command.
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] attach to a flattened session when given
   */
  send(method, params = {}, sessionId = undefined) {
    if (this._closed) return Promise.reject(new Error(`cannot send ${method}: connection closed`));
    const id = ++this._nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          reject(new Error(`${method} timed out after ${this.timeout}ms`));
        }
      }, this.timeout);
      this._pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this._ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(method, fn, sessionId = null) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this._listeners.has(key)) this._listeners.set(key, new Set());
    this._listeners.get(key).add(fn);
    return () => this._listeners.get(key)?.delete(fn);
  }

  /** Resolve with the first matching event, or reject on timeout. */
  waitFor(method, { predicate = () => true, timeout = this.timeout, sessionId = null } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on(
        method,
        (params, sid, full) => {
          if (!predicate(params, sid, full)) return;
          clearTimeout(timer);
          off();
          resolve(params);
        },
        sessionId,
      );
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${timeout}ms waiting for ${method}`));
      }, timeout);
    });
  }

  /**
   * Open a new page target and attach to it.
   * @returns {Promise<{sessionId: string, targetId: string}>}
   */
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    return { sessionId, targetId };
  }

  async close() {
    if (this._closed) return;
    try {
      this._ws?.close();
    } catch {
      /* ignore */
    }
    this._closed = true;
  }
}

/**
 * Connect to a page target and turn on the domains this tool needs.
 * @returns {Promise<{cdp: CDP, sessionId: string, targetId: string}>}
 */
export async function attachToNewPage(wsUrl, { url = 'about:blank', timeout = 30_000 } = {}) {
  const cdp = await new CDP(wsUrl, { timeout }).connect();
  const { sessionId, targetId } = await cdp.newPage(url);

  await Promise.all([
    cdp.send('Page.enable', {}, sessionId),
    cdp.send('Runtime.enable', {}, sessionId),
  ]);

  return { cdp, sessionId, targetId };
}