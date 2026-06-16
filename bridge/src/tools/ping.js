// qqb.ping — health check.
//
// Returns three booleans so the caller can disambiguate:
//   mcpAlive       — this MCP process is running (always true if you got a response)
//   daemonReachable— the long-lived bridge daemon is reachable on ws://127.0.0.1:9528
//   extensionConnected — the QQ Browser extension is authenticated to the daemon

export const ping = {
  name: 'qqb.ping',
  description:
    'Health check. Returns {mcpAlive, daemonReachable, extensionConnected, tabs}. Use this as your first call in any session — if daemonReachable is false, tell the user to start the daemon (`node ~/projects/qqb-cc-bridge/src/index.js`); if extensionConnected is false, tell them to open the QQB extension popup and click "接管当前页".',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler({ hub }) {
    let daemonReachable = false
    let extensionConnected = false
    let tabs = 0
    try {
      const r = await hub.request('list_tabs', {}, { timeoutMs: 2000 })
      daemonReachable = true
      const list = r?.tabs ?? []
      tabs = list.length
      extensionConnected = list.some((t) => t.attached)
    } catch (e) {
      const msg = String(e?.message ?? '')
      if (msg.includes('daemon not running')) daemonReachable = false
      else if (msg.includes('extension not connected')) {
        // daemon IS reachable, just no extension
        daemonReachable = true
        extensionConnected = false
      } else {
        // Unknown error — treat optimistically: daemon was reachable, but
        // something else broke. Surface the message so CC can show it.
        daemonReachable = hub.isConnected()
      }
    }
    return {
      ok: true,
      pong: 'pong',
      mcpAlive: true,
      daemonReachable,
      extensionConnected,
      tabs,
    }
  },
}

