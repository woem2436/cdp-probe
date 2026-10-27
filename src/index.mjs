/**
 * Library entry point, for using cdp-probe as a module instead of a CLI.
 *
 *   import { attachToNewPage, launchChrome, NetworkRecorder } from 'cdp-probe';
 */

export { CDP, attachToNewPage } from './cdp.mjs';
export { findChrome, launchChrome, closeChrome, defaultProfileDir } from './chrome.mjs';
export { NetworkRecorder, printSummary } from './recorder.mjs';
export {
  fetchFromPage,
  ensureTargetOrigin,
  currentUrl,
  loadCapture,
  selectRequests,
  toCurl,
  runProbes,
} from './replay.mjs';
export {
  RateLimiter,
  TransportError,
  transportFailure,
  httpResponse,
  redactHeaders,
  describeResult,
  sessionDir,
  uniquePath,
  writeUnique,
  sleep,
  ui,
  clip,
  stableStringify,
} from './util.mjs';