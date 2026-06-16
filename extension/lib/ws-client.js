// ws-client.js — single-connection WebSocket client with backoff reconnection.
//
// The MV3 service worker may sleep at any time, so we don't try to be heroic
// about staying alive — we just reconnect quickly when we wake up.
//
// Reconnect rules:
//   • Only one in-flight connect attempt at a time (`connecting` guard).
//   • The previous WS's close listener no longer schedules a reconnect when
//     the close was caused by us (cleanup()) — `intentionalClose` flag.
//   • If a new connect arrives while one is in progress, dedupe.

let ws = null
let listeners = new Set()
let url = null
let token = null
let backoffMs = 500
let reconnectTimer = null
let connecting = null            // Promise of in-flight connect, or null
let intentionalClose = false     // true when we close the WS ourselves

export function isOpen() {
  return ws && ws.readyState === WebSocket.OPEN
}

export function connect(opts) {
  url = opts.url
  token = opts.token
  // Already connected? Done.
  if (isOpen()) return Promise.resolve()
  // Already connecting? Return the same promise.
  if (connecting) return connecting

  connecting = new Promise((resolve, reject) => {
    cleanup()                                      // close prior, intentional
    let settled = false
    const settle = (fn) => {
      if (settled) return
      settled = true
      connecting = null
      fn()
    }

    try { ws = new WebSocket(url) } catch (e) { settle(() => reject(e)); return }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }))
    })

    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg?.type === 'auth-ok') {
        backoffMs = 500
        settle(resolve)
        return
      }
      for (const fn of listeners) {
        try { fn(msg) } catch (e) { console.warn('[qqb] listener:', e) }
      }
    })

    ws.addEventListener('close', (ev) => {
      console.log('[qqb] ws closed', ev.code, ev.reason)
      const wasIntentional = intentionalClose
      intentionalClose = false
      // Only auto-reconnect if WE didn't close it ourselves AND we got past
      // initial-connect (otherwise the rejection below schedules a retry).
      if (!wasIntentional && settled) scheduleReconnect()
      // If we never resolved, reject AND schedule a retry — initial connect failed.
      if (!settled) {
        if (!wasIntentional) scheduleReconnect()
        settle(() => reject(new Error(`ws closed before auth: code=${ev.code}`)))
      }
    })

    ws.addEventListener('error', () => {
      // Don't log raw events — they're not informative. close() will follow.
    })
  })

  return connecting
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(backoffMs, 15_000)
  backoffMs = Math.min(backoffMs * 2, 15_000)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!url || !token) return
    if (isOpen() || connecting) return
    connect({ url, token }).catch((e) => console.warn('[qqb] reconnect failed:', e.message))
  }, delay)
}

function cleanup() {
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    intentionalClose = true
    try { ws.close() } catch {}
  }
  ws = null
}

export function send(obj) {
  if (!isOpen()) {
    console.warn('[qqb] send() while closed; dropping', obj?.id ?? obj?.event)
    return false
  }
  ws.send(JSON.stringify(obj))
  return true
}

export function onMessage(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
