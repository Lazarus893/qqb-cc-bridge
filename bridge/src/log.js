// Logger — IMPORTANT: must write to stderr, never stdout, because stdout is the
// MCP transport. Anything on stdout that isn't valid JSON-RPC will break CC.

export function log(level, msg) {
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] [${level}] ${msg}\n`)
}
