/**
 * Finding and launching a Chromium browser with remote debugging enabled.
 *
 * Two deliberate choices:
 *
 *  1. An isolated `--user-data-dir` per run, unless the caller names one. Two
 *     reasons. Chrome refuses remote debugging against the default profile on
 *     current versions. And more importantly, a separate profile means the
 *     tool cannot read or corrupt the operator's everyday browsing state --
 *     they log into the target inside THIS profile, deliberately.
 *
 *  2. `--remote-debugging-port=0` so the OS picks a free port, then read the
 *     real port out of the `DevToolsActivePort` file Chrome writes into the
 *     profile. A hardcoded port collides with the browser the operator already
 *     has open, and the failure looks like "connection refused" for no visible
 *     reason.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sessionDir, sleep, ui } from './util.mjs';

const WINDOWS_CANDIDATES = [
  `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
];

const POSIX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Locate a Chromium binary. `CDP_PROBE_CHROME` overrides everything. */
export function findChrome() {
  const override = process.env.CDP_PROBE_CHROME;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CDP_PROBE_CHROME points at ${override}, which does not exist`);
    }
    return override;
  }
  const candidates = process.platform === 'win32' ? WINDOWS_CANDIDATES : POSIX_CANDIDATES;
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(
    'Could not find Chrome or Edge. Set CDP_PROBE_CHROME to the full path of a Chromium binary.',
  );
}

/**
 * Launch a Chromium browser with CDP enabled and wait until it is reachable.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.headless=false]  headless is off by default on purpose:
 *        authenticated testing usually requires a human to log in once.
 * @param {string}  [opts.profile]         reuse an existing profile directory
 * @param {string}  [opts.userAgent]
 * @param {string[]}[opts.args]            extra Chrome flags
 * @returns {Promise<{proc, port, wsUrl, profile, executable}>}
 */
export async function launchChrome({
  headless = false,
  profile = null,
  userAgent = null,
  args = [],
} = {}) {
  const executable = findChrome();

  let profileDir = profile;
  if (!profileDir) {
    profileDir = join(await sessionDir(), 'profile');
  }
  await mkdir(profileDir, { recursive: true });

  const flags = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    ...args,
  ];

  ui.step(`launching ${executable}`);
  const proc = spawn(executable, flags, { stdio: 'ignore', windowsHide: false });
  proc.on('error', (e) => ui.error(`chrome failed to start: ${e.message}`));

  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
  let port = null;

  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const text = await readFile(portFile, 'utf8').catch(() => '');
      const first = text.split(/\r?\n/)[0]?.trim();
      // Chrome writes the port first and only then opens the socket, so a
      // readable file does not yet mean a usable endpoint -- probe it below.
      if (first && /^\d+$/.test(first)) port = Number(first);
    }
    if (port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const info = await res.json();
          return {
            proc,
            port,
            wsUrl: info.webSocketDebuggerUrl,
            profile: profileDir,
            executable,
            browser: info.Browser,
          };
        }
      } catch {
        /* not ready yet */
      }
    }
    if (proc.exitCode !== null) {
      throw new Error(`Chrome exited with code ${proc.exitCode} before CDP became available`);
    }
    await sleep(200);
  }

  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  throw new Error(
    `Chrome did not expose a CDP endpoint within 30s (profile: ${profileDir}). ` +
      'If another instance is already using this profile directory, Chrome reuses it and the ' +
      'new debugging port is never opened -- pass a fresh --profile directory.',
  );
}

/** Shut the browser down cleanly, then make sure the process is gone. */
export async function closeChrome(proc, { graceMs = 3000 } = {}) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  await Promise.race([exited, sleep(graceMs)]);
  if (proc.exitCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/** Default profile location for the interactive `launch` command. */
export function defaultProfileDir(name = 'default') {
  return join(homedir(), '.cdp-probe', 'profiles', name);
}