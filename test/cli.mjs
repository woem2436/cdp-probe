/**
 * CLI-level end-to-end test.
 *
 * The smoke test proves the library works. This proves the thing a user
 * actually types works: argument parsing, the JSONL file on disk, the exit
 * codes, and --json output. Those are separate failure surfaces, and a tool
 * whose modules pass but whose CLI misparses a flag is still broken.
 *
 * Run: node test/cli.mjs
 */

import { createServer } from 'node:http';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { readFile, rm, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'bin', 'cdp-probe.mjs');
const API_MARKER = 'CLI_API_PAYLOAD';

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

/** Run the CLI as a child process, exactly as a user would. */
function runCli(args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));

    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut: false });
    });
  });
}

function startTargetServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>cli target</title>
        <script>setTimeout(() => fetch('/api/data').then(r => r.text()), 250);</script>`);
      return;
    }
    if (url.pathname === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ payload: API_MARKER }));
      return;
    }
    res.writeHead(404).end('nope');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

async function main() {
  process.stdout.write('cdp-probe CLI test\n\n');

  const work = await mkdtemp(join(tmpdir(), 'cdp-probe-cli-'));
  const { server, port } = await startTargetServer();
  const base = `http://127.0.0.1:${port}`;
  const capture = join(work, 'cap.jsonl');
  const profile = join(work, 'profile');

  process.stdout.write(`  work dir: ${work}\n  target:   ${base}\n\n`);

  try {
    /* ---- doctor ---- */
    const doctor = await runCli(['doctor'], { cwd: work });
    await check('doctor exits 0 and reports chrome', () => {
      assert.equal(doctor.code, 0, `exit ${doctor.code}: ${doctor.stderr}`);
      assert.match(doctor.stdout, /chrome\s+\S/, 'no chrome line in doctor output');
      assert.match(doctor.stdout, /websocket\s+available/, 'no websocket line');
    });

    /* ---- record ---- */
    const rec = await runCli(
      [
        'record',
        base + '/',
        '--out',
        capture,
        '--settle',
        '1500',
        '--profile',
        profile,
        '--headless',
        '--json',
      ],
      { cwd: work },
    );

    await check('record exits 0', () => {
      assert.equal(rec.code, 0, `exit ${rec.code}\nstderr:\n${rec.stderr}`);
      assert.ok(!rec.timedOut, 'record timed out');
    });

    await check('record writes a JSONL capture to the requested path', async () => {
      const raw = await readFile(capture, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      assert.ok(lines.length >= 2, `only ${lines.length} JSONL line(s)`);
      for (const line of lines) JSON.parse(line); // every line must be valid JSON
      const rows = lines.map((l) => JSON.parse(l));
      const doc = rows.find((r) => r.resourceType === 'Document');
      assert.ok(doc, 'no Document row');
      assert.equal(doc.status, 200);
    });

    await check('record captured the XHR and its response body', async () => {
      const rows = (await readFile(capture, 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const api = rows.find((r) => String(r.url).endsWith('/api/data'));
      assert.ok(api, 'the /api/data XHR is missing');
      assert.equal(api.status, 200);
      assert.ok(String(api.body).includes(API_MARKER), `body missing marker: ${api.body}`);
    });

    await check('record --json emits a parseable summary on stdout', () => {
      // --json output is pretty-printed and progress goes to stderr, so all of
      // stdout is exactly one JSON document.
      const text = rec.stdout.trim();
      assert.ok(text, `nothing was written to stdout (stderr: ${rec.stderr})`);
      const summary = JSON.parse(text);
      assert.equal(typeof summary.transportFailures, 'number');
      assert.ok(summary.total > 0, 'summary.total was not populated');
    });

    /* ---- replay (no browser needed when it only prints curl) ---- */
    const curlOut = await runCli(
      ['replay', '--from', capture, '--url-contains', '/api/data', '--curl'],
      { cwd: work },
    );
    await check('replay --curl prints a curl with the captured URL and no --send', () => {
      assert.equal(curlOut.code, 0, `exit ${curlOut.code}: ${curlOut.stderr}`);
      assert.match(curlOut.stdout, /curl/, 'no curl in stdout');
      assert.ok(curlOut.stdout.includes('/api/data'), 'URL missing from curl');
      assert.ok(!/cookie:/i.test(curlOut.stdout), 'replay --curl leaked a cookie by default');
    });

    /* ---- replay failure path: transport must be distinguishable ---- */
    const transportOut = await runCli(
      ['replay', '--url', 'http://127.0.0.1:1/nope', '--json', '--profile', profile, '--headless'],
      { cwd: work },
    );
    await check('replay reports an unreachable target as transport, not as a status', () => {
      const text = transportOut.stdout.trim();
      assert.ok(
        text,
        `nothing on stdout (exit ${transportOut.code})\nstderr:\n${transportOut.stderr}`,
      );
      const rows = JSON.parse(text);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].transport, true, 'transport flag was not set');
      assert.equal(rows[0].status, null, 'a transport failure invented an HTTP status');
      assert.equal(rows[0].ok, false);
    });

    /* ---- eval ---- */
    const ev = await runCli(['eval', '--js', '6*7', '--profile', profile], { cwd: work });
    await check('eval prints the evaluated value', () => {
      assert.equal(ev.code, 0, `exit ${ev.code}: ${ev.stderr}`);
      assert.equal(ev.stdout.trim(), '42');
    });

    /* ---- unknown command must not look like success ---- */
    const bad = await runCli(['frobnicate'], { cwd: work });
    await check('an unknown command exits non-zero', () => {
      assert.notEqual(bad.code, 0, 'unknown command exited 0');
    });
  } finally {
    server.close();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`\ncli test crashed: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});