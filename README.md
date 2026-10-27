# cdp-probe

> Record what a logged-in browser actually sends, then re-issue those requests through the same session — without ever copying the session cookie.

`cdp-probe` is a **zero-dependency** command-line tool that talks to Chrome over the DevTools Protocol. It exists to make one awkward job safe: testing the authenticated part of a web app from the command line.

```
node >= 22.4    |    zero npm dependencies    |    MIT
```

---

## The problem

Testing an authenticated app means sending requests as a logged-in user. The usual routes all have a sharp edge:

| Approach | The sharp edge |
|---|---|
| Burp / mitmproxy | A CA certificate in your browser, a proxy in the middle of everything, and a second copy of the session to look after. |
| Puppeteer / Playwright | A browser you are *not* logged into, plus a large dependency tree, to do what Chrome already does. |
| Copy the cookie into `curl` | The session now lives in your shell history, your clipboard and your notes — and it stops working the moment it rotates. |

That last one is the dangerous one, because it is also the convenient one. Credentials leak through convenience.

## The approach

`cdp-probe` never reads your cookie. Instead:

1. You open a **dedicated Chrome profile** and log in by hand, once.
2. `cdp-probe record` attaches to that browser and captures every request — including response bodies — to JSONL.
3. `cdp-probe replay` issues a request **from inside the page** using `fetch()`. The request is same-origin, so the browser attaches the page's own cookies for you.

The session never leaves the browser. There is nothing for this tool to leak, because there is nothing for it to hold.

```
┌─────────────┐   CDP (websocket)   ┌──────────────────────┐
│ cdp-probe   │ ──────────────────► │ Chrome (profile with │
│             │                     │ your real session)   │
│             │ ◄── requests+bodies │                      │
└─────────────┘                     └──────────────────────┘
       │                                       ▲
       └──── replay: page.evaluate(fetch) ─────┘
                 (cookie attached by the browser)
```

## Requirements

- **Node.js 22.4 or newer.** No packages are needed — the tool uses the built-in global `WebSocket`.
- **Chrome, Chromium, or Edge** installed. `cdp-probe doctor` will find it, or set `CDP_PROBE_CHROME` to an explicit path.

## Install

```bash
git clone https://github.com/<you>/cdp-probe.git
cd cdp-probe
npm link            # puts `cdp-probe` on your PATH
# or skip linking and run: node bin/cdp-probe.mjs <command>
```

There is nothing to build and nothing to install.

## Quickstart

```bash
# 1. Open a browser on a dedicated profile and log in by hand.
cdp-probe launch https://target.example/app --name target

# 2. In another terminal: record the app, including late XHRs.
cdp-probe record https://target.example/app \
    --profile ~/.cdp-probe/profiles/target \
    --out cap.jsonl --settle 6000 --api-only

# 3. Look at what you caught.
cdp-probe replay --from cap.jsonl --url-contains /api/ --curl

# 4. Re-issue one of them, with the page's session, and see the response.
cdp-probe replay --from cap.jsonl --index 3 \
    --profile ~/.cdp-probe/profiles/target --show-body
```

## Commands

### `launch [url]`

Starts Chrome with `--remote-debugging-port=0` on a profile directory and leaves it running. Chrome writes the actual port to `<profile>/DevToolsActivePort`, so later commands can find and **reuse** the same browser — that is what keeps your login alive between runs.

| flag | meaning |
|---|---|
| `--name <n>` | profile name under `~/.cdp-probe/profiles/` |
| `--profile <dir>` | explicit profile directory |
| `--headless` | run headless (you cannot log in by hand this way) |
| `--no-wait` | exit immediately instead of waiting for the window to close |
| `--keep-open` | leave the browser running on Ctrl+C |
| `--user-agent <ua>` | override the UA |

### `record <url>`

Captures requests with bodies into JSONL — one JSON object per line, so a long capture stays `grep`-able and a half-written file is still readable.

| flag | meaning |
|---|---|
| `--out <file>` | destination (default `capture-<ts>.jsonl`) |
| `--settle <ms>` | extra wait after load for late XHRs (default `3000`) |
| `--api-only` | keep only `XHR`/`Fetch` — usually the interesting surface |
| `--no-bodies` | skip response bodies (much smaller, much faster) |
| `--max-body-bytes <n>` | per-body cap (default `2000000`) |
| `--json` | machine-readable summary on stdout |
| `--keep-open` | leave the browser running |

Each row carries `url`, `method`, `resourceType`, `status`, `requestHeaders`, `postData`, `responseHeaders`, `body`, `ms`, and — importantly — `transportFailed` / `errorText` for requests that never got a response.

### `replay`

Two modes, both ending in the same place: a request issued from inside the page.

```bash
# pick a captured request by selector
cdp-probe replay --from cap.jsonl --url-contains /api/orders --index 0 --show-body

# or aim at an endpoint directly
cdp-probe replay --url https://target.example/api/x --method POST \
    --header 'Content-Type: application/json' --body '{"amount":1}' --show-body
```

| flag | meaning |
|---|---|
| `--from <file>` | capture to select from |
| `--url-contains <s>` | select by URL substring |
| `--method <M>` | select by method, when `--from` is used |
| `--index <n>` | index among the matches |
| `--limit <n>` | send at most n of the matches |
| `--method-override <M>` | send the selected request with a different method |
| `--url <url>` | explicit target (skips `--from`) |
| `--body <s>` / `--header 'K: V'` | override the payload |
| `--curl` | print the equivalent curl and **send nothing** |
| `--dry-run` | show what would be sent, send nothing |
| `--show-body` | print response bodies (off by default — they are often personal data) |
| `--rate <n>` | requests per second ceiling (default `5`) |
| `--json` | machine-readable array on stdout |

> **`--curl` and `--dry-run` do not need a browser and send nothing.** Run one of them first.

### `eval --js "<expression>"`

Evaluates JavaScript in a page and prints the result. Useful for checking state you cannot reach with a request — a `localStorage` flag, a feature toggle, a size calculation.

```bash
cdp-probe eval --js 'document.title' --url https://target.example/app --profile ~/.cdp-probe/profiles/target
```

### `doctor`

Prints the Node version, platform, whether the built-in `WebSocket` is present, and the resolved Chrome binary. If something is wrong, this is the first thing to run.

## Three design rules, and the failure behind each

These are not style preferences. Each one is here because a probe harness that ignored it lied to its operator.

### 1. A transport failure is not a rejection

If a connection reset, a dead proxy, or a TLS error is reported the same way as "the server said no", you will write conclusions the target never produced.

Real failure this came from: a batch of requests where **every single one** returned `HTTP 000` because a local proxy was answering `502` to `CONNECT`. The summary called them "rejected". Two batches of results had to be thrown away.

So a probe either produced an HTTP response (`ok: true`) or it did not (`ok: false`, `transport: true`). There is no third state that can be confused with either.

### 2. Never share a temp path between concurrent runs

Real failure this came from: a long batch was backgrounded while a second batch started. Both wrote their request body to the same fixed filename. The second batch's HTTP client read the file mid-rewrite, aborted before sending, and produced `000` for every request — which looked exactly like the target blocking us. Hours went into "the server is rejecting us" before the shared path was found.

Every path this tool creates includes the process id and random bytes. Two runs can never collide.

### 3. Pace requests by default

Most disclosure programmes cap automated traffic — a common ceiling is **5 requests per second against a single host, counted across all tools and threads**. A tool that can only run flat out will eventually get its operator banned, and that is the operator's problem, not the tool's excuse.

The limiter defaults to 5/s. Raise it with `--rate` only if the programme's policy actually allows it.

## Library use

The modules are exported, so you can drive Chrome directly:

```js
import { launchChrome, closeChrome } from 'cdp-probe/src/chrome.mjs';
import { attachToNewPage } from 'cdp-probe/src/cdp.mjs';
import { NetworkRecorder } from 'cdp-probe/src/recorder.mjs';
import { fetchFromPage } from 'cdp-probe/src/replay.mjs';

const chrome = await launchChrome({ headless: true });
const { cdp, sessionId } = await attachToNewPage(chrome.wsUrl, { url: 'about:blank' });

const rec = new NetworkRecorder(cdp, sessionId, { captureBodies: true });
await rec.start();
await cdp.send('Page.navigate', { url: 'https://target.example/' }, sessionId);
await rec.stop();

for (const r of await rec.drain()) console.log(r.method, r.status, r.url);

const res = await fetchFromPage(cdp, sessionId, { url: 'https://target.example/api/me' });
console.log(res.ok, res.transport, res.status);

await cdp.close();
await closeChrome(chrome.proc);
```

## What this tool does not do

Said plainly, so nobody expects it to:

- **It is not a scanner.** It sends the requests you point it at, and nothing else.
- **It does not log in for you.** The login is yours, by hand, in the browser.
- **It cannot set forbidden headers.** `Cookie`, `Host`, `Content-Length`, `Origin` and `Referer` are set by the browser; the tool strips them from overrides rather than silently ignoring your input. The session cookie comes from the browser, not from you.
- **Replaying a state-changing request really does change state.** That is the point, and it is also the risk. Use `--curl` first.
- **Bodies are best-effort.** Chrome cannot always produce a body for redirects and `204`s; when that happens the row says `bodyUnavailable` with the reason rather than showing an empty body.
- **No HAR export.** Captures are JSONL only — by choice, because a HAR is one giant array that cannot be streamed or partially recovered.
- **Service-worker and some preflighted CORS requests** are recorded but may not be replayable from the page's origin.

## Authorization

This tool sends **real requests, with a real session, from a real browser**. It has no idea what it is pointed at.

Use it only against systems you own, or that you have explicit written permission to test — a bug bounty programme's published scope is one such permission, and reading it is part of the job. Several programmes forbid state-changing requests and cap request rates; this tool defaults to a polite rate, but it cannot enforce anyone's rules for them.

If you are not sure you are allowed to test something, you are not allowed to test it.

## 中文速览

> `cdp-probe` 是一个**零依赖**的 Chrome DevTools Protocol 命令行工具，为了解决一个具体问题：在命令行里安全地测试需要登录的 Web 应用。

**它的核心思路**：不复制 Cookie，而是**在页面内部发请求**。用 `fetch()` 从页面自己的 origin 发出，浏览器会自动带上该会话的 Cookie —— 工具从头到尾不读取、不保存、不打印它。所以它没有东西可泄漏。

三条设计规则，每一条都来自一次真实踩坑：

1. **传输失败 ≠ 被目标拒绝** —— 曾经一整批请求全部返回 `000`（本地代理对 `CONNECT` 回 502），摘要却报成"被拒绝"，两批结论作废。现在传输失败有独立状态，永远不会和 HTTP 状态码混淆。
2. **临时文件路径绝不共用** —— 曾经两个批次写同一个固定文件名，一个读到半个文件后中止发送，表现出的现象和"被目标封禁"一模一样。
3. **默认限速 5 请求/秒** —— 多数 SRC 的单主机上限就是 5 rps，且按所有工具、所有线程合计。

**只能用于已授权的目标。** 不确定是否获准测试，就是未获准。

## License

MIT. See [LICENSE](LICENSE).