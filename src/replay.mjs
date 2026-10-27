/**
 * Re-issuing requests with the browser's own session.
 *
 * This is the capability that motivates the whole tool. A plain HTTP client
 * cannot reach an authenticated endpoint, because the session lives in an
 * HttpOnly cookie the operator cannot (and should not have to) extract. Driving
 * `fetch` from inside the page solves that without ever exposing the credential:
 * the browser attaches the cookie itself.
 *
 * The constraint that follows: the request must be issued from a page on the
 * TARGET ORIGIN, otherwise the cookie is not in scope and a same-site
 * protection may strip it. `ensureTargetOrigin` handles that, and it is
 * deliberately loud about navigating, because silently issuing a credentialed
 * request from the wrong origin produces a confusing 401/403 that looks like an
 * authorisation finding.
 */

import { readFile } from 'node:fs/promises';
import { httpResponse, transportFailure, redactHeaders, sleep, ui } from './util.mjs';

/** Read a JSONL capture produced by `record`. */
export async function loadCapture(path) {
  const text = await readFile(path, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`capture ${path} line ${i + 1} is not valid JSON: ${e.message}`);
      }
    });
}

/**
 * Pick captured requests.
 * @param {object[]} entries
 * @param {{index?: number, urlContains?: string, method?: string, apiOnly?: boolean}} sel
 */
export function selectRequests(entries, sel = {}) {
  let out = entries;
  if (sel.apiOnly) out = out.filter((e) => ['XHR', 'Fetch'].includes(e.resourceType));
  if (sel.urlContains) out = out.filter((e) => (e.url || '').includes(sel.urlContains));
  if (sel.method) {
    const m = sel.method.toUpperCase();
    out = out.filter((e) => (e.method || '').toUpperCase() === m);
  }
  if (sel.index !== undefined) {
    const pick = out[sel.index];
    if (!pick) {
      throw new Error(
        `no request at index ${sel.index} (selector matched ${out.length} request(s))`,
      );
    }
    return [pick];
  }
  return out;
}

/** Current page URL. */
export async function currentUrl(cdp, sessionId) {
  const { result } = await cdp.send(
    'Runtime.evaluate',
    { expression: 'location.href', returnByValue: true },
    sessionId,
  );
  return result.value;
}

/**
 * Make sure the page sits on `targetUrl`'s origin so credentialed fetches carry
 * that origin's cookies.
 */
export async function ensureTargetOrigin(cdp, sessionId, targetUrl, { timeout = 30_000 } = {}) {
  const want = new URL(targetUrl).origin;
  let have = null;
  try {
    have = new URL(await currentUrl(cdp, sessionId)).origin;
  } catch {
    have = null;
  }
  if (have === want) return { navigated: false, origin: want };

  ui.warn(
    `page is on ${have || 'an unknown origin'}, request targets ${want} — navigating first so the ` +
      `target's cookies are in scope (issuing it from the wrong origin would fake an auth failure)`,
  );

  const loaded = cdp.waitFor('Page.loadEventFired', { timeout, sessionId });
  await cdp.send('Page.navigate', { url: `${want}/` }, sessionId);
  await loaded.catch(() => ui.warn('navigation did not reach load; continuing anyway'));
  return { navigated: true, origin: want };
}

/**
 * Issue a request from inside the page and normalise the outcome.
 *
 * @returns {Promise<import('./util.mjs').ProbeResult & {finalUrl?: string, redirected?: boolean}>}
 */
export async function fetchFromPage(
  cdp,
  sessionId,
  {
    url,
    method = 'GET',
    headers = {},
    body = null,
    credentials = 'include',
    redirect = 'follow',
    timeoutMs = 60_000,
  },
) {
  const spec = JSON.stringify({ url, method, headers, body, credentials, redirect });

  const expression = `(async () => {
    const req = ${spec};
    const started = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ${Math.max(1000, timeoutMs)});
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === null || req.body === undefined ? undefined : req.body,
        credentials: req.credentials,
        redirect: req.redirect,
        signal: ctrl.signal,
      });
      const text = await res.text();
      const hdrs = {};
      res.headers.forEach((v, k) => { hdrs[k] = v; });
      clearTimeout(timer);
      return JSON.stringify({
        ok: true, status: res.status, statusText: res.statusText, type: res.type,
        redirected: res.redirected, finalUrl: res.url, headers: hdrs, body: text,
        ms: Math.round(performance.now() - started),
      });
    } catch (e) {
      clearTimeout(timer);
      return JSON.stringify({
        ok: false, transport: true,
        error: String((e && e.message) || e),
        name: String((e && e.name) || 'Error'),
        ms: Math.round(performance.now() - started),
      });
    }
  })()`;

  const started = Date.now();
  let raw;
  try {
    const { result, exceptionDetails } = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (exceptionDetails) {
      throw new Error(exceptionDetails.text || 'evaluation threw');
    }
    raw = result.value;
  } catch (e) {
    // The CDP call itself failed (page navigated away, tab closed, protocol
    // timeout). That is a transport failure, not a server verdict.
    return transportFailure({
      url,
      method,
      ms: Date.now() - started,
      error: `page evaluation failed: ${e.message}`,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return transportFailure({
      url,
      method,
      ms: Date.now() - started,
      error: `could not parse in-page result: ${String(raw).slice(0, 200)}`,
    });
  }

  if (!parsed.ok) {
    return transportFailure({
      url,
      method,
      ms: parsed.ms ?? Date.now() - started,
      error: `${parsed.name}: ${parsed.error}`,
      code: parsed.name,
    });
  }

  const res = httpResponse({
    url: parsed.finalUrl || url,
    method,
    ms: parsed.ms ?? Date.now() - started,
    status: parsed.status,
    headers: parsed.headers,
    body: parsed.body,
  });
  res.redirected = parsed.redirected;
  res.responseType = parsed.type;
  return res;
}

/**
 * Render a captured request as a runnable curl command.
 *
 * Disclosure programmes routinely ask for the request in a replayable form, and
 * a captured entry is often richer than what the reporter would retype by hand.
 * The session cookie is deliberately NOT included: use `--include-cookies` if a
 * programme explicitly asks for it, and think about where that file ends up.
 */
export function toCurl(entry, { includeCookies = false } = {}) {
  const parts = ['curl -sS -i'];
  parts.push(`-X ${entry.method}`);
  for (const [k, v] of Object.entries(entry.requestHeaders || {})) {
    const lk = k.toLowerCase();
    if (!includeCookies && ['cookie', 'authorization'].includes(lk)) continue;
    if (lk.startsWith(':')) continue; // HTTP/2 pseudo-headers are not real headers
    parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }
  if (entry.postData) parts.push(`--data-raw ${shellQuote(entry.postData)}`);
  parts.push(shellQuote(entry.url));
  return parts.join(' \\\n  ');
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a batch of probes with pacing and retry-on-transport-failure only.
 *
 * Retrying a request that got an HTTP response would be wrong: it duplicates
 * state-changing requests and inflates the target's logs. Retrying one that
 * never reached HTTP is correct and necessary, because local proxies drop
 * connections transiently.
 */
export async function runProbes(items, fn, { limiter, retries = 3, onResult } = {}) {
  const results = [];
  for (const item of items) {
    let r;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      if (limiter) await limiter.take();
      r = await fn(item);
      r.attempts = attempt;
      if (!r.transport) break;
      if (attempt <= retries) {
        const backoff = 500 * attempt;
        ui.warn(
          `transport failure (${r.error}); retrying in ${backoff}ms ` +
            `[${attempt}/${retries}] — this is NOT the target rejecting anything`,
        );
        await sleep(backoff);
      }
    }
    results.push(r);
    if (onResult) onResult(r, item);
  }
  return results;
}

export { redactHeaders };