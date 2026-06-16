// WebSocket server — accepts two client roles:
//
//   role:'extension' (default) — the QQ Browser extension. There is at most
//     one extension client at a time; latest wins.
//
//   role:'mcp-client' — a thin MCP proxy spawned by Claude Code. Each CC
//     session gets one. Multiple may coexist. The server forwards their
//     `request` messages straight to the extension and routes the reply back.
//
// Wire protocol (JSON over WS):
//   { type:'auth', token, role? }                 ← first message, both roles
//   { type:'auth-ok' }                            ← server → client
//   { id, type:'request',  method, params }       ← from anywhere (mcp-client / server) → extension
//   { id, type:'response', result | error }       ← extension → originator
//   {     type:'event',    event,  data   }       ← extension → server (broadcast to all mcp-clients)

import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { log } from '../log.js'

const REQUEST_TIMEOUT_MS = 30_000

export function startWsServer({ port, token }) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port })
  const state = {
    /** @type {import('ws').WebSocket | null} */
    extension: null,
    /** @type {Set<import('ws').WebSocket>} */
    mcpClients: new Set(),
    /** Bridge-originated requests (e.g. from the in-process MCP server). */
    pending: new Map(),
    /** Per-mcp-client pending requests so we can route responses. */
    pendingByOrigin: new Map(), // id → ws
    facts: {
      tabs: [],
      lastEvent: null,
    },
    eventListeners: new Set(),
  }

  wss.on('connection', (ws, req) => {
    log('info', `ws connection from ${req.socket.remoteAddress}`)
    let authed = false
    let role = null

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch (e) {
        log('warn', `bad json: ${e.message}`)
        return
      }

      if (!authed) {
        if (msg?.type === 'auth' && msg.token === token) {
          authed = true
          role = msg.role === 'mcp-client' ? 'mcp-client' : 'extension'
          if (role === 'extension') {
            if (state.extension && state.extension !== ws) {
              try { state.extension.close(1000, 'replaced') } catch {}
            }
            state.extension = ws
            log('info', 'extension authenticated')
          } else {
            state.mcpClients.add(ws)
            log('info', `mcp-client authenticated (active=${state.mcpClients.size})`)
            // Send a snapshot of current facts so the client doesn't need to
            // wait for the next push.
            try {
              ws.send(JSON.stringify({ type: 'event', event: 'tabs', data: { tabs: state.facts.tabs } }))
            } catch {}
          }
          ws.send(JSON.stringify({ type: 'auth-ok' }))
        } else {
          ws.close(1008, 'auth required')
        }
        return
      }

      if (role === 'mcp-client') {
        // The client wants to make a request to the extension. Stamp the
        // origin so we can route the response back to this specific client.
        if (msg.type === 'request') {
          if (!state.extension) {
            ws.send(JSON.stringify({
              id: msg.id, type: 'response',
              error: { message: 'extension not connected — open the QQB extension popup and click "接管当前页"' },
            }))
            return
          }
          state.pendingByOrigin.set(msg.id, ws)
          state.extension.send(JSON.stringify(msg))
          // 35s safety net — clean up if extension never replies.
          setTimeout(() => state.pendingByOrigin.delete(msg.id), REQUEST_TIMEOUT_MS + 5_000)
          return
        }
        return
      }

      // role === 'extension'
      if (msg.type === 'response') {
        // Either it answers an mcp-client request, or an in-process bridge request.
        const originWs = state.pendingByOrigin.get(msg.id)
        if (originWs) {
          state.pendingByOrigin.delete(msg.id)
          if (originWs.readyState === originWs.OPEN) originWs.send(JSON.stringify(msg))
          return
        }
        const pending = state.pending.get(msg.id)
        if (!pending) return
        clearTimeout(pending.timer)
        state.pending.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error.message ?? 'extension error'))
        else pending.resolve(msg.result)
        return
      }

      if (msg.type === 'event') {
        state.facts.lastEvent = { event: msg.event, data: msg.data, t: Date.now() }
        if (msg.event === 'tabs') state.facts.tabs = msg.data?.tabs ?? []
        // Fan out to all mcp-clients.
        const payload = JSON.stringify(msg)
        for (const c of state.mcpClients) {
          if (c.readyState === c.OPEN) {
            try { c.send(payload) } catch {}
          }
        }
        for (const fn of state.eventListeners) {
          try { fn(msg) } catch (e) { log('warn', `listener: ${e.message}`) }
        }
        return
      }
    })

    ws.on('close', (code, reason) => {
      log('info', `ws closed code=${code} role=${role} reason=${reason?.toString() || ''}`)
      if (state.extension === ws) state.extension = null
      state.mcpClients.delete(ws)
    })

    ws.on('error', (err) => {
      log('warn', `ws error: ${err.message}`)
    })
  })

  wss.on('listening', () => log('info', `ws listening on 127.0.0.1:${port}`))

  /**
   * Send a request to the extension and await the response. Used by the
   * in-process MCP server (when the bridge is run as a single all-in-one
   * process — `qqb-cc-bridge --mcp` mode).
   */
  async function request(method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!state.extension) throw new Error('extension not connected — open the QQB extension popup and click "接管当前页"')
    const id = randomUUID()
    const payload = JSON.stringify({ id, type: 'request', method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id)
        reject(new Error(`request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      state.pending.set(id, { resolve, reject, timer })
      state.extension.send(payload)
    })
  }

  function isConnected() {
    return state.extension != null
  }

  function addEventListener(fn) {
    state.eventListeners.add(fn)
    return () => state.eventListeners.delete(fn)
  }

  function getFacts() {
    return state.facts
  }

  return { request, isConnected, addEventListener, getFacts }
}
