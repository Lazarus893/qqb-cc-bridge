#!/usr/bin/env node
// qqb-cc-bridge — long-lived daemon.
//
// Run this ONCE per machine. It owns the WS server on 127.0.0.1:9528 and
// stays connected to the QQ Browser extension across CC sessions.
//
// Claude Code itself does NOT spawn this — CC spawns mcp-client.js, a thin
// MCP-over-stdio proxy that connects to this daemon.
//
// Usage:
//   node src/index.js                  # daemon
//   node src/index.js --with-mcp       # also expose MCP on stdio (legacy single-process mode)

import { startWsServer } from './ws/server.js'
import { startMcpServer } from './mcp/server.js'
import { ensureToken } from './auth.js'
import { log } from './log.js'

const PORT = Number(process.env.QQB_PORT ?? 9528)
const WITH_MCP = process.argv.includes('--with-mcp')

async function main() {
  const token = await ensureToken()
  log('info', `daemon starting (port=${PORT})`)
  log('info', `auth token: ${token}`)
  if (!WITH_MCP) {
    log('info', 'daemon-only mode — CC connects via mcp-client.js proxy')
  }

  const hub = startWsServer({ port: PORT, token })
  if (WITH_MCP) {
    await startMcpServer({ hub })
    log('info', 'mcp server ready on stdio')
  }
}

main().catch((err) => {
  log('error', `fatal: ${err?.stack ?? err}`)
  process.exit(1)
})
