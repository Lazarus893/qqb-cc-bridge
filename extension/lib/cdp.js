// cdp.js — single retry wrapper around chrome.debugger.sendCommand.
//
// Why: in tight CDP loops (and occasionally even one-off calls) QQ Browser's
// embedded DevTools Protocol can return -32603 "Internal error" or "Detached
// while handling command". Today these errors propagate to the user, who has
// to manually `qqb release` + `qqb takeover` and retry. We auto-recover by:
//   1. Detaching at the Chrome level (swallow errors).
//   2. Clearing interact.js's ATTACHED bookkeeping.
//   3. Sleeping ~200ms so the SW + tab can converge.
//   4. Re-running the exact same takeover code path (attach + enable
//      DOM/Runtime/Page/Accessibility).
//   5. Retrying the original command exactly once.
//
// Hard errors (invalid params, unknown method, "No tab with given id") fall
// through immediately — retrying them is pointless.
//
// Idempotency notes:
//   • The yellow consent bar appears only on the *first* chrome.debugger.attach
//     per browser session. Re-attaching does not re-prompt — the user already
//     granted permission.
//   • If the user explicitly released a tab, this helper's caller would have
//     already errored out (no ATTACHED state) before reaching us; we only
//     reattach in response to a transient error from a previously attached tab.

import { attachTab, detachTab } from './interact.js'

const TRANSIENT_PATTERNS = [
  'Internal error',     // QQ-Browser-specific failure mode (Page.captureScreenshot)
  '-32603',             // CDP error code for the same
  'Detached',           // "Detached while handling command"
  'Target closed',
  'connection',         // covers stale-connection style errors
]

function isTransient(err) {
  const msg = err?.message ?? String(err ?? '')
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p))
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Raw send, no retry. Used internally so the retry loop doesn't recurse into
// itself, and exposed via `cdp(..., {retries:0})` so attachTab's
// domain-enable sequence can run during reattach without looping.
function sendRaw(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(`${method}: ${err.message}`))
      else resolve(result ?? {})
    })
  })
}

async function reattach(tabId) {
  // Force a Chrome-level detach. Swallow errors — if the connection was
  // already torn down, Chrome reports "Debugger is not attached" and we
  // don't care.
  await new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        // Drain lastError so it doesn't leak into the next call.
        void chrome.runtime.lastError
        resolve()
      })
    } catch { resolve() }
  })
  // Sync interact.js's ATTACHED set so the next attachTab() won't short-
  // circuit on its idempotency check.
  try { await detachTab(tabId) } catch {}
  await sleep(200)
  // Re-run the takeover code path: attach + enable the same domains.
  await attachTab(tabId)
}

/**
 * Send a CDP command with single-retry recovery on transient errors.
 *
 * @param {number} tabId
 * @param {string} method
 * @param {object} [params]
 * @param {{ retries?: number }} [opts]  retries=0 disables auto-recovery
 *   (used by attachTab so the domain-enable sequence during reattach
 *   cannot recurse back into the retry loop).
 */
export async function cdp(tabId, method, params = {}, opts = {}) {
  const maxRetries = opts.retries ?? 1
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await sendRaw(tabId, method, params)
    } catch (err) {
      lastErr = err
      if (!isTransient(err) || attempt >= maxRetries) throw err
      console.warn(
        `[cdp] transient error on ${method}, reattaching tab=${tabId}: ${err.message}`
      )
      try {
        await reattach(tabId)
      } catch (_reErr) {
        // Reattach itself failed — surface the original CDP error so the user
        // sees the underlying cause, not the recovery failure.
        throw err
      }
    }
  }
  throw lastErr
}
