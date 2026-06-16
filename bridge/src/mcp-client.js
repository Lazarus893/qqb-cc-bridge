#!/usr/bin/env node
// qqb-cc-bridge — MCP client proxy.
//
// CC spawns this for each session. It:
//   1. Reads the auth token from ~/.qqb-cc-bridge/token.
//   2. Connects to the long-lived daemon on ws://127.0.0.1:9528 as role='mcp-client'.
//   3. Exposes the same MCP tool surface as the daemon's --with-mcp mode, but
//      routes every tool call through the WS connection.
//
// If the daemon isn't running, every tool call fails fast with a clear message
// telling the user to start the daemon. This is intentional — auto-spawning
// the daemon from CC would race when multiple CC sessions launch in parallel.

import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { tools } from './tools/index.js'
import { ensureToken } from './auth.js'
import { log } from './log.js'

const BRIDGE_URL = process.env.QQB_BRIDGE_URL ?? 'ws://127.0.0.1:9528'
const REQUEST_TIMEOUT_MS = 30_000

function startProxyHub({ url, token }) {
  const state = {
    ws: null,
    authed: false,
    pending: new Map(),
    facts: { tabs: [], lastEvent: null },
    eventListeners: new Set(),
    backoffMs: 500,
    everConnected: false,
    /** Promise that resolves on the next auth-ok. */
    nextAuth: null,
    nextAuthResolve: null,
  }

  function newAuthPromise() {
    state.nextAuth = new Promise((resolve) => { state.nextAuthResolve = resolve })
  }
  newAuthPromise()

  function connect() {
    return new Promise((resolve, reject) => {
      let settled = false
      try { state.ws = new WebSocket(url) } catch (e) { reject(e); return }

      state.ws.on('open', () => {
        state.ws.send(JSON.stringify({ type: 'auth', token, role: 'mcp-client' }))
      })
      state.ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg?.type === 'auth-ok') {
          state.authed = true
          state.backoffMs = 500
          state.everConnected = true
          if (state.nextAuthResolve) { state.nextAuthResolve(); state.nextAuthResolve = null }
          newAuthPromise() // for next reconnect cycle
          log('info', 'connected to bridge daemon')
          if (!settled) { settled = true; resolve() }
          return
        }
        if (msg.type === 'response') {
          const p = state.pending.get(msg.id)
          if (!p) return
          clearTimeout(p.timer)
          state.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? 'extension error'))
          else p.resolve(msg.result)
          return
        }
        if (msg.type === 'event') {
          state.facts.lastEvent = { event: msg.event, data: msg.data, t: Date.now() }
          if (msg.event === 'tabs') state.facts.tabs = msg.data?.tabs ?? []
          for (const fn of state.eventListeners) {
            try { fn(msg) } catch {}
          }
          return
        }
      })
      state.ws.on('close', () => {
        state.ws = null
        state.authed = false
        if (!settled) { settled = true; reject(new Error('ws closed before auth')) }
        scheduleReconnect()
      })
      state.ws.on('error', (err) => {
        if (!state.everConnected) log('warn', `ws: ${err.message}`)
      })
    })
  }

  function scheduleReconnect() {
    const delay = Math.min(state.backoffMs, 10_000)
    state.backoffMs = Math.min(state.backoffMs * 2, 10_000)
    setTimeout(() => connect().catch(() => {}), delay)
  }

  async function request(method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    // Wait briefly for an in-progress connection to authenticate. Caps how
    // long we'll block — if the daemon is genuinely down, we want a fast
    // "daemon not running" error, not a 30s hang.
    if (!state.authed) {
      try {
        await Promise.race([
          state.nextAuth,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
        ])
      } catch {
        // fall through — the canonical check below produces the user-visible error
      }
    }
    if (!state.authed || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        'qqb-cc-bridge daemon not running. Start it with:\n' +
        '  node ' + new URL('../src/index.js', import.meta.url).pathname
      )
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id)
        reject(new Error(`request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      state.pending.set(id, { resolve, reject, timer })
      state.ws.send(JSON.stringify({ id, type: 'request', method, params }))
    })
  }

  function isConnected() {
    return state.authed && state.ws?.readyState === WebSocket.OPEN
  }

  function addEventListener(fn) {
    state.eventListeners.add(fn)
    return () => state.eventListeners.delete(fn)
  }

  function getFacts() { return state.facts }

  return { connect, request, isConnected, addEventListener, getFacts }
}

// Tiny helper because the SDK's URL conflicts with global URL when we want
// to use it for path math. (Now unused after rename, kept removed.)

async function startMcp(hub) {
  const server = new Server(
    { name: 'qqb-cc-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const tool = tools.find((t) => t.name === name)
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] }
    }
    try {
      const result = await tool.handler({ args: args ?? {}, hub })
      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      }
    } catch (err) {
      log('warn', `tool ${name} failed: ${err.message}`)
      return { isError: true, content: [{ type: 'text', text: `error: ${err.message}` }] }
    }
  })

  await server.connect(new StdioServerTransport())
}

async function main() {
  const token = await ensureToken()
  const hub = startProxyHub({ url: BRIDGE_URL, token })

  // Try once; if it fails, the MCP server still comes up — tool calls report a
  // friendly "daemon not running" error and the proxy keeps reconnecting.
  hub.connect().catch((e) => log('warn', `initial connect: ${e.message}`))

  await startMcp(hub)
  log('info', 'mcp-client ready on stdio')
}

main().catch((err) => {
  log('error', `fatal: ${err?.stack ?? err}`)
  process.exit(1)
})
