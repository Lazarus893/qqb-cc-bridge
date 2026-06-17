// background.js — extension service worker.
//
// Responsibilities:
//   1. Maintain a persistent WebSocket connection to the local bridge daemon.
//   2. Track which tabs the user has explicitly "taken over" (debugger attached).
//   3. Route incoming bridge requests to the right handler in lib/.
//   4. Push tab list changes back to the bridge as events.
//
// MV3 service workers are evicted aggressively. We keep the WS alive while we
// can, and reconnect on every wake-up.

import { connect, send, onMessage, isOpen } from './lib/ws-client.js'
import { snapshotTab } from './lib/ax-tree.js'
import {
  click, typeText, scroll, navigate, waitFor, execJs, readText, screenshot,
  attachTab, detachTab, isAttached, listAttachedTabs,
} from './lib/interact.js'
import { pulseOverlay, clearOverlay, logOverlay, setOverlayVisible } from './lib/overlay.js'

// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  bridgeUrl: 'ws://127.0.0.1:9528',
  token: '',
}

async function getSettings() {
  const stored = await chrome.storage.local.get(['bridgeUrl', 'token'])
  return { ...DEFAULTS, ...stored }
}

// ── Connection lifecycle ──────────────────────────────────────────────────────

async function tryConnect() {
  const { bridgeUrl, token } = await getSettings()
  if (!token) {
    console.warn('[qqb] no token configured — open popup and paste it')
    return
  }
  try {
    await connect({ url: bridgeUrl, token })
    pushTabsToBridge()
  } catch (e) {
    console.warn('[qqb] connect failed:', e.message)
  }
}

// ── Request routing ───────────────────────────────────────────────────────────

onMessage(async (msg) => {
  if (msg.type !== 'request') return
  const { id, method, params } = msg
  try {
    const result = await dispatch(method, params)
    send({ id, type: 'response', result })
  } catch (e) {
    send({ id, type: 'response', error: { message: e?.message ?? String(e) } })
  }
})

async function dispatch(method, params) {
  // Methods that don't target a single tab — just run.
  if (method === 'list_tabs')   return listTabs()
  if (method === 'takeover')    return takeoverTab(params.tabId)
  if (method === 'release')     return releaseTab(params.tabId)
  if (method === 'pulse')       return pulseHandler(params)

  // Everything else targets a tab. Resolve once so both the overlay and the
  // action use the same tabId.
  const tabId = await resolveTab(params)
  const label = overlayLabel(method, params)

  // Pulse-before — show the breath in cyan ("working") while the action runs.
  // Best-effort: failure to inject overlay never blocks the action.
  // `quiet:true` (e.g. for the demo frame-grabber) skips overlay entirely.
  const quiet = method === 'screenshot' && Boolean(params?.quiet)
  if (OVERLAY_METHODS.has(method) && !quiet) {
    pulseOverlay({
      tabId,
      label,
      durationMs: OVERLAY_DURATION_MS_BY_METHOD[method] ?? 1500,
      status: 'working',
    }).catch(() => {})
  }

  // Special case: screenshot --clean → hide the overlay during capture.
  const clean = method === 'screenshot' && Boolean(params?.clean)
  if (clean) await setOverlayVisible({ tabId, visible: false }).catch(() => {})

  const t0 = Date.now()
  let result, error
  try {
    result = await runAction(method, tabId, params)
  } catch (e) {
    error = e
  } finally {
    if (clean) await setOverlayVisible({ tabId, visible: true }).catch(() => {})
  }

  const elapsed = Date.now() - t0
  // Pulse-after / timeline log — paint result in green or red.
  if (OVERLAY_METHODS.has(method) && !quiet) {
    const status = error ? 'error' : 'ok'
    const logLabel = error
      ? `${label} · failed (${truncate(error.message, 40)})`
      : `${label} · ${elapsed}ms`
    // Ripple at click coords, but don't fire if there was an error.
    const ripple = (!error && method === 'click' && result?._coords) ? result._coords : undefined
    pulseOverlay({
      tabId,
      label,
      durationMs: 900,        // brief "done" flash
      status,
      ripple,
      logText: logLabel,
      logStatus: status,
    }).catch(() => {})
  }

  if (error) throw error
  // Strip internal coord field before returning to caller.
  if (result && typeof result === 'object' && '_coords' in result) {
    const { _coords, ...rest } = result
    return rest
  }
  return result
}

async function runAction(method, tabId, params) {
  switch (method) {
    case 'snapshot':   return snapshotTab(tabId, params)
    case 'read_text':  return readText(tabId, params)
    case 'screenshot': return screenshot(tabId, params)
    case 'click':      return click(tabId, params)
    case 'type':       return typeText(tabId, params)
    case 'scroll':     return scroll(tabId, params)
    case 'navigate':   return navigate({ ...params, tabId })
    case 'wait_for':   return waitFor(tabId, params)
    case 'exec_js':    return execJs(tabId, params)
    default: throw new Error(`unknown method: ${method}`)
  }
}

// Methods that target a specific tab and benefit from a visible overlay.
const OVERLAY_METHODS = new Set([
  'snapshot', 'read_text', 'click', 'type', 'scroll', 'wait_for',
  'exec_js', 'screenshot', 'navigate',
])

// Per-method overlay duration. Roughly: how long the action might plausibly
// take, plus a fade-out beat. wait_for can run for up to 10s by default, so
// we don't auto-hide it — we let the call's success/failure clear it.
const OVERLAY_DURATION_MS_BY_METHOD = {
  snapshot: 1200,
  read_text: 1200,
  click: 1500,
  type: 2000,
  scroll: 1000,
  wait_for: 0,        // stays on; refresh on next call
  exec_js: 1500,
  screenshot: 1500,
  navigate: 3000,
}

function overlayLabel(method, params = {}) {
  const ref = params.nodeRef ? ` ${params.nodeRef}` : ''
  switch (method) {
    case 'snapshot':   return 'qqb · reading page'
    case 'read_text':  return 'qqb · reading text'
    case 'screenshot': return params.fullPage ? 'qqb · screenshot (full page)' : `qqb · screenshot${ref}`
    case 'click':      return `qqb · click${ref}`
    case 'type':       return `qqb · type${ref}`
    case 'scroll':     return `qqb · scroll${params.direction ? ' ' + params.direction : ref}`
    case 'wait_for':   return `qqb · wait (${params.condition?.type ?? 'idle'})`
    case 'exec_js':    return 'qqb · exec JS'
    case 'navigate':   return `qqb · navigate ${truncate(params.url, 32)}`
    default:           return 'qqb · working'
  }
}

function truncate(s, n) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

async function pulseHandler(params = {}) {
  const tabId = params.tabId ?? (await resolveTab(params).catch(() => null))
  if (tabId == null) throw new Error('no active tab; specify tabId')
  if (params.stop) {
    await clearOverlay({ tabId, destroy: Boolean(params.destroy) })
    return { ok: true, tabId, stopped: true }
  }
  await pulseOverlay({
    tabId,
    label: params.label ?? 'qqb · working',
    durationMs: params.durationMs ?? 2000,
  })
  return { ok: true, tabId, label: params.label ?? 'qqb · working', durationMs: params.durationMs ?? 2000 }
}

// ── Tab management ────────────────────────────────────────────────────────────

async function resolveTab(params) {
  if (params?.tabId != null) return params.tabId
  // Default to the most recently active attached tab.
  const attached = listAttachedTabs()
  if (attached.length > 0) return attached[attached.length - 1]
  // Fall back to the active tab in the focused window.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) throw new Error('no active tab; specify tabId')
  return tab.id
}

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return {
    tabs: tabs.map((t) => ({
      tabId: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      attached: isAttached(t.id),
    })),
  }
}

async function takeoverTab(tabId) {
  if (tabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tabId = tab?.id
    if (tabId == null) throw new Error('no active tab')
  }
  await attachTab(tabId)
  pushTabsToBridge()
  return { ok: true, tabId }
}

async function releaseTab(tabId) {
  // Best-effort overlay teardown before debugger detaches — once detached we
  // can't talk to the page anymore.
  if (tabId != null) await clearOverlay({ tabId, destroy: true }).catch(() => {})
  await detachTab(tabId)
  pushTabsToBridge()
  return { ok: true }
}

async function pushTabsToBridge() {
  if (!isOpen()) return
  try {
    const data = await listTabs()
    send({ type: 'event', event: 'tabs', data })
  } catch (e) {
    console.warn('[qqb] pushTabsToBridge:', e.message)
  }
}

// ── Tab event listeners ──────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(() => pushTabsToBridge())
chrome.tabs.onActivated.addListener(() => pushTabsToBridge())
chrome.tabs.onRemoved.addListener((tabId) => {
  detachTab(tabId).catch(() => {})
  pushTabsToBridge()
})
chrome.debugger.onDetach.addListener((source, reason) => {
  console.warn('[qqb] debugger detached', source, reason)
  pushTabsToBridge()
})

// ── Service worker boot ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => tryConnect())
chrome.runtime.onStartup.addListener(() => tryConnect())
self.addEventListener('activate', () => tryConnect())

// Reconnect each time the popup pokes us.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'reconnect') {
    tryConnect().then(() => sendResponse({ ok: true, connected: isOpen() }))
    return true // async
  }
  if (msg?.type === 'status') {
    sendResponse({
      connected: isOpen(),
      attachedTabs: listAttachedTabs(),
    })
    return false
  }
  if (msg?.type === 'takeover-active') {
    takeoverTab().then((r) => sendResponse(r), (e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
  if (msg?.type === 'release') {
    releaseTab(msg.tabId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
})

// First attempt right away.
tryConnect()
