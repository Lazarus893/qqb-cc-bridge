// ws-client.js — single-connection WebSocket client with backoff reconnection.
//
// The MV3 service worker may sleep at any time, so we don't try to be heroic
// about staying alive — we just reconnect quickly when we wake up.

let ws = null
let listeners = new Set()
let url = null
let token = null
let backoffMs = 500
let reconnectTimer = null

export function isOpen() {
  return ws && ws.readyState === WebSocket.OPEN
}

export function connect(opts) {
  url = opts.url
  token = opts.token
  return new Promise((resolve, reject) => {
    cleanup()
    try { ws = new WebSocket(url) } catch (e) { reject(e); return }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }))
    })

    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg?.type === 'auth-ok') {
        backoffMs = 500
        resolve()
        return
      }
      for (const fn of listeners) {
        try { fn(msg) } catch (e) { console.warn('[qqb] listener:', e) }
      }
    })

    ws.addEventListener('close', (ev) => {
      console.log('[qqb] ws closed', ev.code, ev.reason)
      scheduleReconnect()
      // If we never resolved (auth never returned), reject.
      reject(new Error(`ws closed before auth: code=${ev.code}`))
    })

    ws.addEventListener('error', (ev) => {
      console.warn('[qqb] ws error', ev)
    })
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(backoffMs, 15_000)
  backoffMs = Math.min(backoffMs * 2, 15_000)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!url || !token) return
    connect({ url, token }).catch((e) => console.warn('[qqb] reconnect failed:', e.message))
  }, delay)
}

function cleanup() {
  if (ws && ws.readyState !== WebSocket.CLOSED) {
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
