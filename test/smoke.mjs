/**
 * End-to-end smoke test.
 *
 * It spins up a local HTTP server that behaves like an authenticated app, drives
 * a real Chrome against it, and then asserts the three claims this tool makes:
 *
 *   1. `record` captures requests together with their response bodies.
 *   2. `replay` re-issues a request carrying the page's own session cookie --
 *      proven by hitting an endpoint that answers 401 without it.
 *   3. a request that never reaches HTTP is reported as a TRANSPORT failure and
 *      is never confused with an HTTP status.
 *
 * Run: node test/smoke.mjs
 */

import { createServer } from 'node:http';
import { strict as assert } from 'node:assert';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { attachToNewPage } from '../src/cdp.mjs';
import { launchChrome, closeChrome } from '../src/chrome.mjs';
import { NetworkRecorder } from '../src/recorder.mjs';
import { fetchFromPage } from '../src/replay.mjs';
import { uniquePath, sessionDir, sleep, RateLimiter } from '../src/util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_MARKER = 'SMOKE_PAGE_MARKER';
const API_MARKER = 'SMOKE_API_PAYLOAD';
const COOKIE = 'session=smoke-secret-value';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`  FAIL  ${name}\n        ${e.message}\n`);
  }
}

/** A local app: sets a session cookie, then guards an API with it. */
function startTargetServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `${COOKIE}; Path=/; SameSite=Lax`,
      });
      res.end(`<!doctype html><title>smoke target</title>
        <h1>${PAGE_MARKER}</h1>
        <script>
          // A late XHR, to prove --settle captures post-load traffic.
          setTimeout(() => { fetch('/api/data').then(r => r.text()); }, 300);
        </script>`);
      return;
    }

    if (url.pathname === '/api/data') {
      const authed = (req.headers.cookie || '').includes('smoke-secret-value');
      if (!authed) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthenticated', hadCookie: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ payload: API_MARKER, hadCookie: true }));
      return;
    }

    if (url.pathname === '/api/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: body }));
      });
      return;
    }

    res.writeHead(404).end('nope');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function main() {
  process.stdout.write('cdp-probe smoke test\n\n');

  /* --- part 0: pure unit checks that need no browser ------------------- */
  await check('uniquePath() never returns the same path twice', async () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(await uniquePath('t', 'json'));
    assert.equal(seen.size, 200, 'uniquePath collided');
    const dir = await sessionDir();
    for (const p of seen) assert.ok(p.startsWith(dir), 'path escaped the session dir');
  });

  await check('RateLimiter paces to roughly the configured rate', async () => {
    const limiter = new RateLimiter(20, 1); // 20/s, no burst
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) await limiter.take();
    const elapsed = Date.now() - t0;
    // 6 tokens at 20/s with burst 1 => ~5 gaps of 50ms => ~250ms
    assert.ok(elapsed >= 180, `too fast: ${elapsed}ms (limiter is not limiting)`);
    assert.ok(elapsed < 2000, `far too slow: ${elapsed}ms`);
  });

  /* --- part 1: real browser against the local target ------------------- */
  const { server, port } = await startTargetServer();
  const base = `http://127.0.0.1:${port}`;
  process.stdout.write(`\n  target server on ${base}\n\n`);

  let chrome = null;
  let cdp = null;
  try {
    const profile = join(await sessionDir(), 'smoke-profile');
    chrome = await launchChrome({ headless: true, profile });
    process.stdout.write(`  chrome: ${chrome.browser} (port ${chrome.port})\n\n`);

    const attached = await attachToNewPage(chrome.wsUrl, { url: 'about:blank' });
    cdp = attached.cdp;
    const { sessionId } = attached;

    const recorder = new NetworkRecorder(cdp, sessionId, { captureBodies: true });
    await recorder.start();

    const loaded = cdp.waitFor('Page.loadEventFired', { timeout: 30_000, sessionId }).catch(() => {});
    await cdp.send('Page.navigate', { url: base + '/' }, sessionId);
    await loaded;
    await sleep(1500); // let the late XHR land

    await recorder.stop();
    const entries = await recorder.drain();
    const summary = recorder.summary();

    await check('record() captured the document request', () => {
      const doc = entries.find((e) => e.url === base + '/' && e.resourceType === 'Document');
      assert.ok(doc, 'no Document entry captured');
      assert.equal(doc.status, 200, `document status was ${doc.status}`);
    });

    await check('record() captured a late XHR with its response body', () => {
      const api = entries.find((e) => e.url.endsWith('/api/data'));
      assert.ok(api, 'the /api/data XHR was not captured (did --settle miss it?)');
      assert.equal(api.status, 200, `api status was ${api.status}`);
      assert.ok(
        api.body && api.body.includes(API_MARKER),
        `response body missing or wrong: ${JSON.stringify(api.body)?.slice(0, 120)}`,
      );
    });

    await check('record() keeps transport failures separate from HTTP statuses', () => {
      assert.equal(typeof summary.transportFailures, 'number');
      for (const e of entries) {
        if (e.transportFailed) {
          assert.equal(e.status, null, 'a transport-failed entry must not carry a status');
          assert.ok(e.errorText, 'a transport failure must record Chrome errorText');
        }
      }
    });

    await check('replay() carries the page session cookie (401 becomes 200)', async () => {
      const r = await fetchFromPage(cdp, sessionId, { url: `${base}/api/data` });
      assert.equal(r.transport, false, `transport failure: ${r.error}`);
      assert.equal(r.status, 200, `expected 200 with the cookie, got ${r.status}`);
      assert.ok(r.body.includes(API_MARKER), 'body did not contain the API marker');
      // r.body is already the response text, so compare against the raw JSON
      // quotes -- JSON.stringify()ing it would escape them and never match.
      assert.ok(r.body.includes('"hadCookie":true'), `server did not observe the cookie: ${r.body}`);
    });

    await check('replay() sends a request body for POST', async () => {
      const r = await fetchFromPage(cdp, sessionId, {
        url: `${base}/api/echo`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"hello":"smoke"}',
      });
      assert.equal(r.status, 200, `status ${r.status}`);
      assert.ok(r.body.includes('hello'), `echo body wrong: ${r.body}`);
    });

    await check('replay() reports an unreachable port as TRANSPORT, not as a status', async () => {
      const r = await fetchFromPage(cdp, sessionId, {
        url: 'http://127.0.0.1:1/definitely-not-listening',
        timeoutMs: 5000,
      });
      assert.equal(r.ok, false, 'an unreachable host must not report ok:true');
      assert.equal(r.transport, true, 'an unreachable host must be flagged transport:true');
      assert.equal(r.status, null, 'a transport failure must not invent a status');
      assert.ok(r.error, 'a transport failure must carry a reason');
    });

    await check('replay() still reports a real 4xx as an HTTP response', async () => {
      const r = await fetchFromPage(cdp, sessionId, { url: `${base}/nope` });
      assert.equal(r.transport, false, 'a 404 is a response, not a transport failure');
      assert.equal(r.status, 404);
    });

    await cdp.close();
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (chrome) await closeChrome(chrome.proc).catch(() => {});
    server.close();
    await rm(await sessionDir(), { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`\nsmoke test crashed: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});