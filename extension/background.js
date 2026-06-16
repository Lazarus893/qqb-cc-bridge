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
  switch (method) {
    case 'list_tabs':         return listTabs()
    case 'snapshot':          return snapshotTab(await resolveTab(params), params)
    case 'read_text':         return readText(await resolveTab(params), params)
    case 'screenshot':        return screenshot(await resolveTab(params), params)
    case 'click':             return click(await resolveTab(params), params)
    case 'type':              return typeText(await resolveTab(params), params)
    case 'scroll':            return scroll(await resolveTab(params), params)
    case 'navigate':          return navigate(params)
    case 'wait_for':          return waitFor(await resolveTab(params), params)
    case 'exec_js':           return execJs(await resolveTab(params), params)
    case 'takeover':          return takeoverTab(params.tabId)
    case 'release':           return releaseTab(params.tabId)
    default: throw new Error(`unknown method: ${method}`)
  }
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
