/**
 * Shared primitives.
 *
 * The design rules in this file are not stylistic. Each one exists because of a
 * specific way a probe harness lies to its operator. They are documented inline
 * so the next person does not have to rediscover them.
 */

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * 1. Transport failure is NOT the same thing as a rejected request.
 *
 * This is the single most damaging bug a probe harness can have. If a
 * connection reset (dead proxy, dropped tunnel, TLS failure) is reported the
 * same way as "the server said no", the operator records conclusions that the
 * target never produced. Real example: a batch of requests where every single
 * one returned HTTP 000 because the local proxy was returning 502 to CONNECT;
 * the summary printed them as "REJECTED" and two batches of results had to be
 * thrown away after the fact.
 *
 * So: a probe either produced an HTTP response (`ok: true`) or it did not
 * (`ok: false`, `transport: true`). There is no third "rejected" state that
 * can be confused with either.
 * ------------------------------------------------------------------ */

export class TransportError extends Error {
  constructor(message, { code, url, cause } = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.url = url;
    this.transport = true;
    if (cause) this.cause = cause;
  }
}

/**
 * A normalised probe result.
 *
 * @typedef {object} ProbeResult
 * @property {boolean}  ok          true only if an HTTP response was received
 * @property {boolean}  transport   true if the request never reached HTTP
 * @property {number|null} status   HTTP status, or null when transport failed
 * @property {object}   headers     response headers (lowercased keys)
 * @property {string}   body        response body text ('' when transport failed)
 * @property {number}   ms          wall-clock duration
 * @property {string}   url
 * @property {string}   method
 * @property {string|null} error    human-readable failure reason, else null
 * @property {number}   attempts    how many tries it took
 */

export function transportFailure({ url, method, ms, error, code }) {
  return {
    ok: false,
    transport: true,
    status: null,
    headers: {},
    body: '',
    ms,
    url,
    method,
    error: error || 'transport failure',
    code: code ?? null,
    attempts: 1,
  };
}

export function httpResponse({ url, method, ms, status, headers, body }) {
  return {
    ok: true,
    transport: false,
    status,
    headers: headers || {},
    body: body ?? '',
    ms,
    url,
    method,
    error: null,
    attempts: 1,
  };
}

/* ------------------------------------------------------------------ *
 * 2. Never share a temporary path between concurrent runs.
 *
 * Real example: a long probe batch was moved to a background job while a second
 * batch started. Both wrote the body to the same fixed filename. The second
 * batch's HTTP client read the file while it was being rewritten, aborted
 * before sending, and produced `000` for every request -- which looked exactly
 * like the target rejecting everything. Hours went into "the server is blocking
 * us" before the shared path was found.
 *
 * Every path this tool creates is unique, including the process id and random
 * bytes, so two runs can never collide.
 * ------------------------------------------------------------------ */

let _sessionDir = null;

/** A per-process temp directory, created once, unique across runs. */
export async function sessionDir() {
  if (_sessionDir) return _sessionDir;
  const base = join(tmpdir(), 'cdp-probe');
  await mkdir(base, { recursive: true });
  _sessionDir = await mkdtemp(join(base, `run-${process.pid}-`));
  return _sessionDir;
}

/** A unique file path. Never returns a path another call can also return. */
export async function uniquePath(prefix = 'f', ext = 'tmp') {
  const dir = await sessionDir();
  return join(dir, `${prefix}-${randomBytes(6).toString('hex')}.${ext}`);
}

/** Write to a unique path and return it. */
export async function writeUnique(contents, prefix = 'f', ext = 'tmp') {
  const p = await uniquePath(prefix, ext);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, contents);
  return p;
}

/* ------------------------------------------------------------------ *
 * 3. Pace requests by default.
 *
 * Most disclosure programmes cap automated traffic (a common ceiling is 5
 * requests/second against a single host, counted across all tools and threads).
 * A tool that can only go flat out will eventually get its operator banned, so
 * the limiter defaults to a compliant rate and has to be explicitly raised.
 * ------------------------------------------------------------------ */

export class RateLimiter {
  /**
   * @param {number} perSecond  sustained requests per second (default 5)
   * @param {number} burst      how many may fire back-to-back (default = rate)
   */
  constructor(perSecond = 5, burst = null) {
    this.rate = perSecond > 0 ? perSecond : Infinity;
    this.capacity = burst ?? Math.max(1, Math.ceil(perSecond));
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  async take() {
    if (this.rate === Infinity) return;
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.last) / 1000) * this.rate,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      await sleep(Math.ceil((deficit / this.rate) * 1000) + 1);
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 4. Do not print credentials by accident.
 *
 * Captures and logs are pasted into bug reports and issue threads. Headers that
 * carry a live session are redacted unless the caller explicitly opts in, so
 * the default output is safe to share.
 * ------------------------------------------------------------------ */

const SENSITIVE = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-auth-token',
  'x-api-key',
  'x-csrf-token',
  'x-xsrf-token',
]);

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Small output helpers, kept consistent so stdout stays parseable.
 * ------------------------------------------------------------------ */

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CDP_PROBE_NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const ui = {
  info: (m) => process.stderr.write(`${paint(36, 'info')}  ${m}\n`),
  warn: (m) => process.stderr.write(`${paint(33, 'warn')}  ${m}\n`),
  error: (m) => process.stderr.write(`${paint(31, 'error')} ${m}\n`),
  ok: (m) => process.stderr.write(`${paint(32, 'ok')}    ${m}\n`),
  step: (m) => process.stderr.write(`${paint(90, '·')} ${m}\n`),
};

/**
 * Render a ProbeResult on one line, in a form that cannot hide a transport
 * failure behind a status-looking string.
 */
export function describeResult(r) {
  if (!r.ok) {
    return `TRANSPORT-FAIL (${r.error}) after ${r.attempts} attempt(s)`;
  }
  const len = r.body ? `${r.body.length}b` : 'empty';
  return `HTTP ${r.status} (${len}, ${r.ms}ms)`;
}

/** Truncate for terminal display without pretending the rest does not exist. */
export function clip(s, n = 400) {
  if (typeof s !== 'string') s = String(s);
  return s.length <= n ? s : `${s.slice(0, n)}… [+${s.length - n} chars]`;
}

/** JSON with sorted keys, for stable diffs. */
export function stableStringify(v) {
  return JSON.stringify(
    v,
    (_k, val) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
        : val,
    2,
  );
}