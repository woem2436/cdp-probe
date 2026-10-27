#!/usr/bin/env node
/**
 * cdp-probe — zero-dependency Chrome DevTools Protocol CLI for authorized web
 * security testing.
 *
 * Run `cdp-probe help` for usage. Authorized targets only: this tool sends real
 * requests with your real session.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { CDP, attachToNewPage } from '../src/cdp.mjs';
import { launchChrome, closeChrome, defaultProfileDir, findChrome } from '../src/chrome.mjs';
import { NetworkRecorder, printSummary } from '../src/recorder.mjs';
import {
  fetchFromPage,
  ensureTargetOrigin,
  loadCapture,
  selectRequests,
  toCurl,
  runProbes,
  currentUrl,
} from '../src/replay.mjs';
import {
  RateLimiter,
  describeResult,
  clip,
  redactHeaders,
  sleep,
  ui,
  stableStringify,
} from '../src/util.mjs';

/* ----------------------------- arg parsing ----------------------------- */

function parseFlags(args) {
  const flags = { _: [], header: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      flags._.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq !== -1) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          val = next;
          i++;
        } else {
          val = true;
        }
      }
      if (key === 'header') {
        flags.header.push(val);
      } else if (key in flags && flags[key] !== true) {
        flags[key] = [].concat(flags[key], val);
      } else {
        flags[key] = val;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

const num = (v, d) => (v === undefined || v === true ? d : Number(v));
const str = (v, d = null) => (v === undefined || v === true ? d : String(v));

function headersFrom(flags) {
  const out = {};
  for (const h of flags.header || []) {
    const idx = String(h).indexOf(':');
    if (idx === -1) throw new Error(`--header needs "Name: value", got: ${h}`);
    out[String(h).slice(0, idx).trim()] = String(h).slice(idx + 1).trim();
  }
  return out;
}

/* --------------------------- browser resolution --------------------------- */

/**
 * Connect to an existing CDP endpoint, reuse a running profile, or launch.
 *
 * Reusing a profile matters for authenticated work: the operator logs into the
 * target once in a dedicated profile, and every later run attaches to that same
 * browser instead of starting a fresh, logged-out one. Chrome records its
 * debugging port in `<profile>/DevToolsActivePort`, so we can find a browser
 * that is already running rather than failing with "connection refused".
 */
async function resolveBrowser(flags, { wantUrl = null } = {}) {
  const explicitWs = str(flags.ws);
  if (explicitWs) {
    ui.info(`attaching to ${explicitWs}`);
    return { wsUrl: explicitWs, launched: null, profile: str(flags.profile) };
  }

  const profileDir = flags.profile ? resolve(str(flags.profile)) : null;

  if (profileDir) {
    const portFile = join(profileDir, 'DevToolsActivePort');
    if (existsSync(portFile)) {
      const first = (await readFile(portFile, 'utf8').catch(() => '')).split(/\r?\n/)[0]?.trim();
      if (first && /^\d+$/.test(first)) {
        try {
          const res = await fetch(`http://127.0.0.1:${first}/json/version`, {
            signal: AbortSignal.timeout(1500),
          });
          if (res.ok) {
            const info = await res.json();
            ui.ok(`reusing the browser already running on this profile (port ${first})`);
            return { wsUrl: info.webSocketDebuggerUrl, launched: null, profile: profileDir };
          }
        } catch {
          ui.step('profile has a stale DevToolsActivePort; starting a new browser');
        }
      }
    }
  }

  const launched = await launchChrome({
    headless: Boolean(flags.headless),
    profile: profileDir,
  });
  ui.ok(`chrome ${launched.browser} on port ${launched.port}  (profile: ${launched.profile})`);
  return { wsUrl: launched.wsUrl, launched, profile: launched.profile };
}

/* -------------------------------- commands -------------------------------- */

async function cmdHelp() {
  process.stdout.write(`cdp-probe — CDP tooling for authorized web security testing

USAGE
  cdp-probe <command> [options]

COMMANDS
  launch                      Start a browser with CDP on a dedicated profile and
                              leave it running so you can log in by hand.
  record <url>                Capture every request (with response bodies) the
                              page makes, to JSONL.
  replay                      Re-issue a request FROM INSIDE THE PAGE, so it
                              carries the page's own session cookie.
  eval                        Evaluate a JS expression in the page.
  help                        This text.

COMMON OPTIONS
  --ws <url>                  Attach to an existing CDP endpoint.
  --profile <dir>             Use (and reuse) a profile directory. Recording
                              against a profile you logged into is how you test
                              authenticated pages without ever handling cookies.
  --headless                  Run headless. Off by default: you usually need to
                              log in once by hand.
  --rate <n>                  Requests per second ceiling. Default 5, which most
                              disclosure programmes accept. Raise it only if the
                              programme's policy allows.
  --json                      Machine-readable output on stdout.
  --help                      Per-command help.

RECORD
  cdp-probe record https://target/app --profile ./prof --out cap.jsonl \\
      --settle 4000 --api-only

  --out <file>                JSONL destination (default: capture-<ts>.jsonl)
  --settle <ms>               Extra wait after load for late XHRs (default 3000)
  --api-only                  Keep only XHR/Fetch, i.e. the interesting surface
  --no-bodies                 Skip response bodies (much smaller captures)
  --max-body-bytes <n>        Per-body cap (default 2000000)
  --keep-open                 Leave the browser running when finished

REPLAY
  # re-issue request #7 from a capture, with a modified body
  cdp-probe replay --from cap.jsonl --index 7 --body '{"amount":1}' \\
      --profile ./prof

  # or target an endpoint directly
  cdp-probe replay --url https://target/api/x --method POST \\
      --header 'Content-Type: application/json' --body '{"a":1}' --profile ./prof

  --from <file>               Capture to pick a request from
  --index <n>                 Index within the selector's matches
  --url-contains <s>          Select captured requests by URL substring
  --method <M>                Select captured requests by method
  --api-only                  Restrict selection to XHR/Fetch
  --url <url>                 Explicit target URL (skips --from)
  --body <s>                  Request body
  --header 'K: V'             Repeatable
  --curl                      Print the equivalent curl for the selected request
  --dry-run                   Show what would be sent, send nothing
  --show-body                 Print response bodies (off by default; they are
                              often large and often personal data)

SAFETY
  This tool sends real requests with a real session. Use it only against
  systems you are authorised to test, and read the target programme's rules --
  several forbid state-changing requests and cap request rates.
`);
}

async function cmdLaunch(flags) {
  const profile = flags.profile
    ? resolve(String(flags.profile))
    : defaultProfileDir(str(flags.name, 'default'));

  const launched = await launchChrome({
    headless: Boolean(flags.headless),
    profile,
    userAgent: str(flags['user-agent']),
  });

  ui.ok(`chrome ${launched.browser}`);
  ui.info(`CDP endpoint : ${launched.wsUrl}`);
  ui.info(`profile      : ${launched.profile}`);
  ui.info(`executable   : ${launched.executable}`);
  process.stdout.write(`${launched.wsUrl}\n`);

  if (flags._[0] && typeof flags._[0] === 'string') {
    ui.step(`opening ${flags._[0]}`);
    const cdp = await new CDP(launched.wsUrl).connect();
    const { sessionId } = await cdp.newPage(String(flags._[0]));
    await cdp.send('Page.enable', {}, sessionId).catch(() => {});
    await cdp.close();
  }

  ui.info('');
  ui.info('Log in to the target in this window by hand. The session cookie stays in');
  ui.info('this profile and this tool never reads it.');
  ui.info('');
  ui.info(`Then run, in another terminal:`);
  ui.info(`  cdp-probe record <target-url> --profile "${launched.profile}" --out cap.jsonl`);
  ui.info('');
  ui.info('Close the window (or Ctrl+C here) when you are done.');

  if (flags['no-wait']) return;

  await new Promise((r) => {
    process.on('SIGINT', r);
    process.on('SIGTERM', r);
    launched.proc.once('exit', r);
  });

  if (!flags['keep-open']) {
    await closeChrome(launched.proc);
    ui.step('browser closed');
  }
}

async function cmdRecord(flags) {
  const target = flags._[0];
  if (!target) throw new Error('record needs a URL: cdp-probe record <url>');

  const settle = num(flags.settle, 3000);
  const out = str(flags.out, `capture-${Date.now()}.jsonl`);

  const { wsUrl, launched, profile } = await resolveBrowser(flags, { wantUrl: target });
  const { cdp, sessionId } = await attachToNewPage(wsUrl, { url: 'about:blank' });

  const recorder = new NetworkRecorder(cdp, sessionId, {
    captureBodies: !flags['no-bodies'],
    maxBodyBytes: num(flags['max-body-bytes'], 2_000_000),
    resourceTypes: flags['api-only'] ? ['XHR', 'Fetch'] : null,
  });
  await recorder.start();

  const loaded = cdp
    .waitFor('Page.loadEventFired', { timeout: 60_000, sessionId })
    .catch(() => ui.warn('load event did not fire within 60s; recording stops at --settle anyway'));

  ui.step(`navigating to ${target}`);
  await cdp.send('Page.navigate', { url: target }, sessionId);
  await loaded;

  if (settle > 0) {
    ui.step(`waiting ${settle}ms for late requests`);
    await sleep(settle);
  }

  await recorder.stop();
  const rows = await recorder.drain();
  const written = await recorder.writeJsonl(out);

  const summary = recorder.summary();
  printSummary(summary);

  ui.ok(`wrote ${written} entr(ies) to ${out}`);
  if (summary.transportFailures) {
    ui.warn(
      `${summary.transportFailures} request(s) never reached HTTP. That is a transport ` +
        `problem (proxy/VPN/network), NOT the target refusing anything.`,
    );
  }

  if (flags.json) {
    process.stdout.write(
      stableStringify({ out, ...summary, generatedAt: new Date().toISOString() }) + '\n',
    );
  }

  await cdp.close();
  if (launched && !flags['keep-open']) {
    await closeChrome(launched.proc);
    ui.step('browser closed');
  }
  if (profile && !launched) ui.step(`left the existing browser on ${profile} running`);
}

async function cmdReplay(flags) {
  const limiter = new RateLimiter(num(flags.rate, 5));
  const dryRun = Boolean(flags['dry-run']);
  const showBody = Boolean(flags['show-body']);

  /** @type {{label:string, url:string, method:string, headers:object, body:string|null}[]} */
  let items = [];

  if (flags.from) {
    const entries = await loadCapture(resolve(String(flags.from)));
    const picked = selectRequests(entries, {
      index: flags.index === undefined ? undefined : num(flags.index, 0),
      urlContains: str(flags['url-contains']),
      method: str(flags.method),
      apiOnly: Boolean(flags['api-only']),
    });
    if (!picked.length) throw new Error('no captured request matched the selector');
    items = picked.slice(0, num(flags.limit, picked.length)).map((e, i) => ({
      label: `#${e.id ?? i} ${e.method} ${e.url}`,
      url: str(flags.url) || e.url,
      method: (
        str(flags['method-override']) ||
        str(flags.methodOverride) ||
        e.method ||
        'GET'
      ).toUpperCase(),
      headers: { ...pickRequestHeaders(e.requestHeaders), ...headersFrom(flags) },
      body: flags.body !== undefined ? String(flags.body) : (e.postData ?? null),
    }));
  } else {
    const url = str(flags.url) || (typeof flags._[0] === 'string' ? flags._[0] : null);
    if (!url) {
      throw new Error('replay needs --from <capture.jsonl> or --url <url>');
    }
    items = [
      {
        label: `${str(flags.method, 'GET').toUpperCase()} ${url}`,
        url,
        method: str(flags.method, 'GET').toUpperCase(),
        headers: headersFrom(flags),
        body: flags.body !== undefined ? String(flags.body) : null,
      },
    ];
  }

  if (flags.curl) {
    for (const it of items) {
      process.stdout.write(
        toCurl(
          { method: it.method, url: it.url, requestHeaders: it.headers, postData: it.body },
          { includeCookies: Boolean(flags['include-cookies']) },
        ) + '\n\n',
      );
    }
    if (dryRun || !flags.send) return;
  }

  for (const it of items) {
    ui.step(`${it.method} ${it.url}`);
    if (it.body) ui.step(`  body: ${clip(it.body, 200)}`);
    const hdrs = redactHeaders(it.headers);
    if (Object.keys(hdrs).length) ui.step(`  headers: ${JSON.stringify(hdrs)}`);
  }

  if (dryRun) {
    ui.warn('--dry-run: nothing was sent');
    return;
  }

  const { wsUrl, launched, profile } = await resolveBrowser(flags);
  const { cdp, sessionId } = await attachToNewPage(wsUrl, { url: 'about:blank' });

  // Put the page on the target origin so its cookies are in scope. Doing this
  // once up front is cheaper and clearer than a warning per request.
  const firstOrigin = new URL(items[0].url).origin;
  await ensureTargetOrigin(cdp, sessionId, items[0].url);

  const results = await runProbes(
    items,
    async (it) => {
      if (new URL(it.url).origin !== firstOrigin) {
        await ensureTargetOrigin(cdp, sessionId, it.url);
      }
      // Only attach a body to methods that can carry one; fetch() rejects a
      // body on GET/HEAD and that rejection would masquerade as a failure.
      const body = ['GET', 'HEAD'].includes(it.method) ? null : it.body;
      return fetchFromPage(cdp, sessionId, {
        url: it.url,
        method: it.method,
        headers: it.headers,
        body,
        timeoutMs: num(flags.timeout, 60_000),
      });
    },
    { limiter },
  );

  const report = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const line = `${describeResult(r)}  ${r.method} ${r.url}`;
    if (!r.ok) {
      ui.error(line);
      ui.error(`        ^ ${r.error} — no HTTP response was produced. Not a server verdict.`);
    } else if (r.status >= 500) {
      ui.warn(line);
    } else {
      ui.ok(line);
    }
    if (showBody && r.body) {
      process.stderr.write(`        ${clip(r.body, 1200)}\n`);
    }
    report.push({
      label: items[i].label,
      ok: r.ok,
      transport: r.transport,
      status: r.status,
      ms: r.ms,
      attempts: r.attempts,
      error: r.error,
      responseHeaders: redactHeaders(r.headers),
      bodyLength: r.body ? r.body.length : 0,
      body: showBody ? r.body : undefined,
    });
  }

  if (flags.json) {
    process.stdout.write(stableStringify(report) + '\n');
  }

  const failures = report.filter((r) => r.transport).length;
  if (failures) {
    ui.warn(
      `${failures}/${report.length} request(s) produced no HTTP response. Re-run before drawing ` +
        `any conclusion from those rows.`,
    );
  }

  await cdp.close();
  if (launched && !flags['keep-open']) await closeChrome(launched.proc);
  if (profile && !launched) ui.step(`left the existing browser on ${profile} running`);
}

/** Chrome sends many HTTP/2 pseudo-headers and some that fetch() forbids. */
function pickRequestHeaders(headers = {}) {
  const drop = new Set([
    'cookie',
    'content-length',
    'host',
    'connection',
    'accept-encoding',
    'origin',
    'referer',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk.startsWith(':')) continue;
    if (drop.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

async function cmdEval(flags) {
  const js = str(flags.js) || str(flags._[0]);
  if (!js) throw new Error('eval needs --js "<expression>"');
  const pageUrl = str(flags.url);
  const { wsUrl, launched } = await resolveBrowser(flags);
  const { cdp, sessionId } = await attachToNewPage(wsUrl, { url: pageUrl || 'about:blank' });
  if (pageUrl) {
    const loaded = cdp.waitFor('Page.loadEventFired', { timeout: 30_000, sessionId }).catch(() => {});
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await loaded;
  }
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression: js, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) {
    ui.error(exceptionDetails.text || 'evaluation threw');
    process.exitCode = 1;
  } else {
    const v = typeof result.value === 'string' ? result.value : stableStringify(result.value);
    process.stdout.write(`${v}\n`);
  }
  await cdp.close();
  if (launched) await closeChrome(launched.proc);
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (!cmd || cmd === 'help' || argv.includes('--help')) {
    await cmdHelp();
    return;
  }

  switch (cmd) {
    case 'launch':
      return cmdLaunch(flags);
    case 'record':
      return cmdRecord(flags);
    case 'replay':
      return cmdReplay(flags);
    case 'eval':
      return cmdEval(flags);
    case 'doctor': {
      process.stdout.write(`node      ${process.version}\n`);
      process.stdout.write(`platform  ${process.platform} ${process.arch}\n`);
      process.stdout.write(`websocket ${typeof WebSocket !== 'undefined' ? 'available' : 'MISSING'}\n`);
      try {
        process.stdout.write(`chrome    ${findChrome()}\n`);
      } catch (e) {
        process.stdout.write(`chrome    NOT FOUND (${e.message})\n`);
        process.exitCode = 1;
      }
      return;
    }
    default:
      ui.error(`unknown command: ${cmd}`);
      await cmdHelp();
      process.exitCode = 2;
  }
}

main().catch((e) => {
  ui.error(e.message);
  if (process.env.CDP_PROBE_DEBUG) console.error(e.stack);
  process.exitCode = 1;
});