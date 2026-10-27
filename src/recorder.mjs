/**
 * Network recording.
 *
 * Captures every request the page makes together with its response body, and
 * writes one JSON object per line. JSONL rather than a single JSON array so a
 * long capture stays greppable and half-written files remain usable.
 *
 * Note on `loadingFailed`: it is recorded as an explicit transport failure with
 * Chrome's own `errorText`, kept separate from any HTTP status. A request that
 * never got a response must never look like a request that got a bad one.
 */

import { writeFile } from 'node:fs/promises';
import { redactHeaders, ui } from './util.mjs';

const DEFAULT_MAX_BODY = 2_000_000; // 2 MB per body

export class NetworkRecorder {
  /**
   * @param {import('./cdp.mjs').CDP} cdp
   * @param {string} sessionId
   */
  constructor(cdp, sessionId, opts = {}) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.captureBodies = opts.captureBodies !== false;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
    this.resourceTypes = opts.resourceTypes ?? null; // e.g. ['XHR','Fetch','Document']

    /** @type {Map<string, object>} */
    this.byRequestId = new Map();
    /** @type {object[]} */
    this.entries = [];
    this._unsubs = [];
    this._inflightBodies = new Set();
  }

  async start() {
    const sid = this.sessionId;
    this._unsubs.push(
      this.cdp.on('Network.requestWillBeSent', (p) => this._onRequest(p), sid),
      this.cdp.on('Network.responseReceived', (p) => this._onResponse(p), sid),
      this.cdp.on('Network.loadingFinished', (p) => this._onFinished(p), sid),
      this.cdp.on('Network.loadingFailed', (p) => this._onFailed(p), sid),
    );
    await this.cdp.send('Network.enable', { maxTotalBufferSize: 200_000_000 }, sid);
    return this;
  }

  async stop() {
    for (const off of this._unsubs) off();
    this._unsubs = [];
    // let outstanding body reads settle
    await Promise.allSettled([...this._inflightBodies]);
  }

  _wanted(type) {
    return !this.resourceTypes || this.resourceTypes.includes(type);
  }

  _onRequest(p) {
    const type = p.type || 'Other';
    if (!this._wanted(type)) return;

    // A redirect reuses the requestId; keep the earlier hop as its own entry.
    if (p.redirectResponse) {
      const prev = this.byRequestId.get(p.requestId);
      if (prev) {
        prev.status = p.redirectResponse.status;
        prev.responseHeaders = redactHeaders(p.redirectResponse.headers);
        prev.redirectedTo = p.request?.url;
        prev.transportFailed = false;
      }
    }

    const entry = {
      id: this.entries.length,
      requestId: p.requestId,
      url: p.request?.url,
      method: p.request?.method,
      resourceType: type,
      requestHeaders: p.request?.headers || {},
      postData: p.request?.postData ?? null,
      hasPostData: Boolean(p.request?.hasPostData),
      documentURL: p.documentURL,
      initiator: p.initiator?.type || null,
      wallTime: p.wallTime ?? null,
      startedAt: Date.now(),
      status: null,
      responseHeaders: {},
      mimeType: null,
      body: null,
      bodyTruncated: false,
      transportFailed: false,
      errorText: null,
      finishedAt: null,
      ms: null,
    };

    this.byRequestId.set(p.requestId, entry);
    this.entries.push(entry);
  }

  _onResponse(p) {
    const entry = this.byRequestId.get(p.requestId);
    if (!entry) return;
    entry.status = p.response.status;
    entry.responseHeaders = redactHeaders(p.response.headers);
    entry.mimeType = p.response.mimeType || null;
    entry.fromCache = Boolean(p.response.fromDiskCache || p.response.fromPrefetchCache);
    entry.remoteIPAddress = p.response.remoteIPAddress || null;
    entry.protocol = p.response.protocol || null;
  }

  _onFinished(p) {
    const entry = this.byRequestId.get(p.requestId);
    if (!entry) return;
    entry.finishedAt = Date.now();
    entry.ms = entry.finishedAt - entry.startedAt;
    entry.encodedDataLength = p.encodedDataLength ?? null;

    if (!this.captureBodies) return;
    const bodySize = p.encodedDataLength ?? 0;
    if (bodySize > this.maxBodyBytes) {
      entry.bodyTruncated = true;
      entry.body = `[body omitted: ${bodySize} bytes exceeds --max-body-bytes ${this.maxBodyBytes}]`;
      return;
    }

    const task = this.cdp
      .send('Network.getResponseBody', { requestId: p.requestId }, this.sessionId)
      .then((r) => {
        entry.body = r.base64Encoded
          ? `[base64, ${r.body.length} chars] ${r.body.slice(0, 200)}…`
          : r.body;
        if (r.base64Encoded) entry.bodyBase64 = true;
      })
      .catch((e) => {
        // Not fatal: bodies expire, and redirects/204s have none. Record why
        // instead of leaving `null`, which would be indistinguishable from
        // "capture disabled".
        entry.body = null;
        entry.bodyUnavailable = e.message;
      })
      .finally(() => this._inflightBodies.delete(task));

    this._inflightBodies.add(task);
  }

  _onFailed(p) {
    const entry = this.byRequestId.get(p.requestId);
    if (!entry) return;
    entry.finishedAt = Date.now();
    entry.ms = entry.finishedAt - entry.startedAt;
    entry.transportFailed = true;
    entry.errorText = p.errorText || 'unknown transport failure';
    entry.blockedReason = p.blockedReason || null;
    entry.canceled = Boolean(p.canceled);
  }

  /** @returns {object[]} entries with bodies, once outstanding reads settle */
  async drain() {
    await Promise.allSettled([...this._inflightBodies]);
    return this.entries;
  }

  async writeJsonl(path) {
    const rows = await this.drain();
    await writeFile(path, rows.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    return rows.length;
  }

  summary() {
    const byHost = new Map();
    let transportFailures = 0;
    for (const e of this.entries) {
      if (e.transportFailed) transportFailures += 1;
      let host;
      try {
        host = new URL(e.url).host;
      } catch {
        host = '(unparseable)';
      }
      byHost.set(host, (byHost.get(host) || 0) + 1);
    }
    return {
      total: this.entries.length,
      transportFailures,
      hosts: [...byHost.entries()].sort((a, b) => b[1] - a[1]),
      apis: this.entries
        .filter((e) => ['XHR', 'Fetch'].includes(e.resourceType))
        .map((e) => ({
          method: e.method,
          url: e.url,
          status: e.transportFailed ? `TRANSPORT-FAIL(${e.errorText})` : e.status,
        })),
    };
  }
}

/** Print a compact summary so the operator can see what was captured. */
export function printSummary(summary) {
  ui.info(`captured ${summary.total} request(s); ${summary.transportFailures} transport failure(s)`);
  ui.info('hosts:');
  for (const [host, n] of summary.hosts.slice(0, 20)) {
    process.stderr.write(`        ${String(n).padStart(5)}  ${host}\n`);
  }
  if (summary.apis.length) {
    ui.info(`API-ish requests (${summary.apis.length}):`);
    for (const a of summary.apis.slice(0, 40)) {
      const status = typeof a.status === 'string' ? a.status : a.status ?? '-';
      process.stderr.write(`        ${String(status).padEnd(24)} ${a.method} ${a.url}\n`);
    }
    if (summary.apis.length > 40) {
      process.stderr.write(`        … and ${summary.apis.length - 40} more\n`);
    }
  }
}