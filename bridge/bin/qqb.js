#!/usr/bin/env node
// qqb — one-shot CLI for the qqb-cc-bridge daemon.
//
// CC invokes this from Bash (no MCP layer). Each invocation:
//   1. Reads the token from ~/.qqb-cc-bridge/token.
//   2. Opens a WS connection to the daemon (default ws://127.0.0.1:9528).
//   3. Authenticates as role:'mcp-client' (the daemon already routes that role to the extension).
//   4. Sends ONE request, awaits the response, prints JSON to stdout, exits.
//
// Output contract:
//   - Success: JSON to stdout, exit 0.
//   - Failure: JSON {error: "..."} to stdout, non-zero exit. (Always JSON so CC can parse uniformly.)
//   - Optional: --pretty for indented JSON.
//
// Why not MCP? MCP-over-stdio adds a per-call subprocess + handshake on every
// tool call and is harder for CC to use ad-hoc. A single bash command per call
// is much simpler and the Skill can compose it freely.

import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const BRIDGE_URL = process.env.QQB_BRIDGE_URL ?? 'ws://127.0.0.1:9528'
const TOKEN_FILE = join(homedir(), '.qqb-cc-bridge', 'token')
const DEFAULT_TIMEOUT_MS = 30_000

// ---- arg parsing ------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pretty') out.flags.pretty = true
    else if (a === '--help' || a === '-h') out.flags.help = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq >= 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1)
      else {
        const next = argv[i + 1]
        if (next != null && !next.startsWith('--')) { out.flags[a.slice(2)] = next; i++ }
        else out.flags[a.slice(2)] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function num(v, fallback) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function bool(v, fallback) {
  if (v === true) return true
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return fallback
}

// ---- subcommand → wire method mapping --------------------------------------
// We translate CLI subcommands to the same internal extension methods that the
// MCP tools used. This keeps the extension untouched.

const COMMANDS = {
  ping: {
    method: '__local_ping__',          // synthesized below — never sent to ext
    summary: 'Health check. {mcpAlive, daemonReachable, extensionConnected, tabs}',
    build: () => ({}),
  },
  tabs: {
    method: 'list_tabs',
    summary: 'List all tabs the extension knows about.',
    build: (args) => ({ refresh: bool(args.flags.refresh, false) }),
  },
  snapshot: {
    method: 'snapshot',
    summary: 'Fetch the AX-tree snapshot of a tab. Use this BEFORE clicking/typing.',
    build: (args) => ({
      tabId: num(args.flags.tab, undefined),
      mode: args.flags.mode ?? 'ax',
      maxNodes: num(args.flags.maxNodes, 800),
    }),
  },
  read: {
    method: 'read_text',
    summary: 'Reader-mode text extraction (cheaper than snapshot when you only need to read).',
    build: (args) => ({
      tabId: num(args.flags.tab, undefined),
      selector: args.flags.selector,
    }),
  },
  screenshot: {
    method: 'screenshot',
    summary: 'Capture viewport / full page / element. Writes PNG/JPEG to disk; stdout is metadata + path.',
    timeoutHint: () => 60_000,    // big pages can take longer
    build: (args) => ({
      tabId: num(args.flags.tab, undefined),
      fullPage: bool(args.flags.fullPage, false),
      nodeRef: args.flags.ref,
      format: args.flags.format ?? 'png',
      quality: num(args.flags.quality, undefined),
      scale: num(args.flags.scale, 1),
      clean: bool(args.flags.clean, false),
    }),
  },
  click: {
    method: 'click',
    summary: 'Click an element by nodeRef from a recent snapshot.',
    build: (args) => {
      const ref = args._[1] ?? args.flags.ref
      if (!ref) throw new Error('usage: qqb click <nodeRef> [--tab N] [--button left|right|middle] [--clickCount N]')
      return {
        tabId: num(args.flags.tab, undefined),
        nodeRef: ref,
        button: args.flags.button ?? 'left',
        clickCount: num(args.flags.clickCount, 1),
      }
    },
  },
  type: {
    method: 'type',
    summary: 'Type text into an input identified by nodeRef.',
    build: (args) => {
      const ref = args._[1] ?? args.flags.ref
      const text = args.flags.text ?? args._.slice(2).join(' ')
      if (!ref || text === undefined || text === '') {
        throw new Error('usage: qqb type <nodeRef> --text "value" [--tab N] [--clear true|false] [--submit true|false]')
      }
      return {
        tabId: num(args.flags.tab, undefined),
        nodeRef: ref,
        text,
        clear: bool(args.flags.clear, true),
        submit: bool(args.flags.submit, false),
      }
    },
  },
  scroll: {
    method: 'scroll',
    summary: 'Scroll viewport (--direction up/down/top/bottom) or scroll element into view (--ref nX).',
    build: (args) => ({
      tabId: num(args.flags.tab, undefined),
      nodeRef: args.flags.ref,
      direction: args.flags.direction,
      pages: num(args.flags.pages, 1),
    }),
  },
  navigate: {
    method: 'navigate',
    summary: 'Drive a tab to a URL.',
    build: (args) => {
      const url = args._[1] ?? args.flags.url
      if (!url) throw new Error('usage: qqb navigate <url> [--tab N] [--waitUntil load|domcontentloaded|networkidle] [--newTab]')
      return {
        tabId: num(args.flags.tab, undefined),
        url,
        waitUntil: args.flags.waitUntil ?? 'load',
        newTab: bool(args.flags.newTab, false),
      }
    },
  },
  wait: {
    method: 'wait_for',
    summary: 'Wait for a condition. --idle MS | --url-changes [FROM] | --url-matches PATTERN | --selector SEL | --no-selector SEL',
    timeoutHint: (args) => num(args.flags.timeoutMs, 10_000) + 5_000,
    build: (args) => {
      let condition
      if (args.flags.idle != null && args.flags.idle !== false) {
        condition = { type: 'idle', ms: num(args.flags.idle, 500) }
      } else if (args.flags['url-changes'] != null && args.flags['url-changes'] !== false) {
        condition = { type: 'url-changes' }
        if (typeof args.flags['url-changes'] === 'string') condition.from = args.flags['url-changes']
      } else if (args.flags['url-matches']) {
        condition = { type: 'url-matches', pattern: String(args.flags['url-matches']) }
      } else if (args.flags.selector) {
        condition = { type: 'selector', selector: String(args.flags.selector) }
      } else if (args.flags['no-selector']) {
        condition = { type: 'no-selector', selector: String(args.flags['no-selector']) }
      } else {
        throw new Error('usage: qqb wait --idle 500 | --url-changes [FROM] | --url-matches PATTERN | --selector SEL | --no-selector SEL [--timeoutMs MS]')
      }
      return {
        tabId: num(args.flags.tab, undefined),
        condition,
        timeoutMs: num(args.flags.timeoutMs, 10_000),
      }
    },
  },
  exec: {
    method: 'exec_js',
    summary: 'ESCAPE HATCH — evaluate a JS expression. Prefer snapshot/read first.',
    build: (args) => {
      const expr = args._.slice(1).join(' ') || args.flags.expr
      if (!expr) throw new Error('usage: qqb exec "<expression>" [--tab N] [--awaitPromise true|false]')
      return {
        tabId: num(args.flags.tab, undefined),
        expr,
        awaitPromise: bool(args.flags.awaitPromise, true),
      }
    },
  },
  takeover: {
    method: 'takeover',
    summary: 'Attach chrome.debugger to a tab. Surfaces a yellow consent bar.',
    build: (args) => ({ tabId: num(args.flags.tab, undefined) }),
  },
  release: {
    method: 'release',
    summary: 'Detach chrome.debugger from a tab.',
    build: (args) => ({ tabId: num(args.flags.tab, undefined) }),
  },
  pulse: {
    method: 'pulse',
    summary: 'Manually trigger / clear the breathing overlay (cosmetic, normally automatic).',
    build: (args) => ({
      tabId: num(args.flags.tab, undefined),
      label: args.flags.label,
      durationMs: num(args.flags.duration, 2000),
      stop: bool(args.flags.stop, false),
      destroy: bool(args.flags.destroy, false),
    }),
  },
}

function help() {
  const lines = [
    'qqb — drive QQ Browser via the qqb-cc-bridge daemon.',
    '',
    'Usage:  qqb <command> [args] [--flags]',
    '',
    'Commands:',
  ]
  for (const [cmd, def] of Object.entries(COMMANDS)) {
    lines.push(`  ${cmd.padEnd(10)} ${def.summary}`)
  }
  lines.push('')
  lines.push('Global flags:')
  lines.push('  --pretty           pretty-print JSON output')
  lines.push('  --timeoutMs MS     per-request timeout (default 30000; 10000 for wait, 60000 for screenshot)')
  lines.push('  --tab N            target a specific tabId (otherwise: most-recent attached)')
  lines.push('')
  lines.push('Screenshot flags:')
  lines.push('  --fullPage         capture beyond the viewport (whole document)')
  lines.push('  --ref nX           capture only the element with this nodeRef')
  lines.push('  --format png|jpeg  default png; use jpeg + --quality for smaller files')
  lines.push('  --quality 1-100    jpeg quality (default 80)')
  lines.push('  --scale 1-2        scale factor (e.g. 0.5 to halve the size)')
  lines.push('  --out PATH         write to a specific path (default /tmp/qqb-screenshots/shot-<id>.png)')
  lines.push('  --base64           keep base64 inline in stdout instead of writing a file')
  lines.push('  --clean            hide the qqb overlay during capture (clean image)')
  lines.push('')
  lines.push('Env:')
  lines.push('  QQB_BRIDGE_URL     default ws://127.0.0.1:9528')
  lines.push('')
  lines.push('Output: always JSON on stdout, exit 0 on success / non-zero on error.')
  return lines.join('\n')
}

// ---- WS round-trip ----------------------------------------------------------

async function loadToken() {
  try {
    const t = (await readFile(TOKEN_FILE, 'utf8')).trim()
    if (t.length >= 16) return t
    throw new Error('token file is empty / too short')
  } catch (e) {
    throw new Error(
      `cannot read auth token at ${TOKEN_FILE}: ${e.message}\n` +
      `Start the daemon once to generate one:\n  node ${join(homedir(), 'projects', 'qqb-cc-bridge', 'src', 'index.js')}`
    )
  }
}

function withTimeout(promise, ms, label) {
  let timer
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, t]).finally(() => clearTimeout(timer))
}

async function callDaemon(method, params, { timeoutMs }) {
  const token = await loadToken()
  return withTimeout(new Promise((resolve, reject) => {
    let ws
    try { ws = new WebSocket(BRIDGE_URL) } catch (e) { reject(e); return }

    let settled = false
    const settle = (fn) => { if (!settled) { settled = true; fn() } }
    const reqId = randomUUID()

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token, role: 'mcp-client' }))
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg?.type === 'auth-ok') {
        ws.send(JSON.stringify({ id: reqId, type: 'request', method, params }))
        return
      }
      if (msg?.type === 'response' && msg.id === reqId) {
        if (msg.error) settle(() => reject(new Error(msg.error.message ?? 'extension error')))
        else settle(() => resolve(msg.result))
        try { ws.close() } catch {}
        return
      }
      // ignore unsolicited events (cached tabs push, etc.)
    })

    ws.on('close', (code, reason) => {
      const r = reason?.toString() || ''
      if (code === 1008 && /auth/i.test(r)) {
        settle(() => reject(new Error('auth rejected by daemon — token mismatch?')))
      } else {
        settle(() => reject(new Error(
          `qqb-cc-bridge daemon not running at ${BRIDGE_URL} (or closed early: code=${code} reason="${r}")\n` +
          `Start it with:  node ${join(homedir(), 'projects', 'qqb-cc-bridge', 'src', 'index.js')}`
        )))
      }
    })

    ws.on('error', (err) => {
      settle(() => reject(new Error(
        `cannot reach daemon at ${BRIDGE_URL}: ${err.message}\n` +
        `Start it with:  node ${join(homedir(), 'projects', 'qqb-cc-bridge', 'src', 'index.js')}`
      )))
      try { ws.close() } catch {}
    })
  }), timeoutMs, 'request')
}

// ---- ping (synthesized — does NOT round-trip extension if daemon is down) --

async function pingHandler({ flags }) {
  const timeoutMs = num(flags.timeoutMs, 4000)
  const r = {
    ok: true,
    pong: 'pong',
    daemonReachable: false,        // WS daemon answers
    extensionConnected: false,     // QQ extension is WS-authed (list_tabs round-trips)
    anyTabAttached: false,         // at least one tab has chrome.debugger attached
    tabs: 0,
  }
  try {
    const tabsResult = await callDaemon('list_tabs', { refresh: true }, { timeoutMs })
    r.daemonReachable = true
    r.extensionConnected = true
    const list = tabsResult?.tabs ?? []
    r.tabs = list.length
    r.anyTabAttached = list.some((t) => t.attached)
  } catch (e) {
    const m = String(e?.message ?? '')
    if (/extension not connected/i.test(m)) {
      r.daemonReachable = true
      r.extensionConnected = false
    } else {
      r.daemonReachable = false
      r._daemonError = m.split('\n')[0]
    }
  }
  return r
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.flags.help || args._.length === 0) {
    process.stdout.write(help() + '\n')
    process.exit(args._.length === 0 ? 1 : 0)
  }

  const cmd = args._[0]
  const def = COMMANDS[cmd]
  if (!def) {
    emit({ error: `unknown command: ${cmd}`, hint: 'run qqb --help' }, args, 2)
    return
  }

  const timeoutMs = def.timeoutHint ? def.timeoutHint(args) : num(args.flags.timeoutMs, DEFAULT_TIMEOUT_MS)

  try {
    let result
    if (cmd === 'ping') {
      result = await pingHandler(args)
    } else {
      const params = def.build(args)
      result = await callDaemon(def.method, params, { timeoutMs })
      if (cmd === 'screenshot') {
        result = await persistScreenshot(result, args)
      }
    }
    emit(result, args, 0)
  } catch (e) {
    emit({ error: e.message ?? String(e) }, args, 1)
  }
}

// Screenshot post-processing — write the base64 payload to disk so we don't
// blast 1-2 MB of base64 into CC's context. The default flow returns just a
// path; --base64 keeps the bytes inline (use sparingly).
async function persistScreenshot(result, args) {
  if (!result?.base64) return result

  const base64 = result.base64
  if (args.flags.base64) {
    // Caller explicitly wants the bytes inline — pass through.
    return result
  }

  const ext = result.format === 'jpeg' ? 'jpg' : 'png'
  let outPath = args.flags.out
  if (!outPath) {
    const dir = join(tmpdir(), 'qqb-screenshots')
    await mkdir(dir, { recursive: true })
    // Avoid Date.now/Math.random — readFile a tiny counter or use process.hrtime
    // Simpler: use process.pid + monotonic perf_hooks counter via process.hrtime
    const stamp = process.hrtime.bigint().toString(36)
    outPath = join(dir, `shot-${stamp}.${ext}`)
  }

  const buf = Buffer.from(base64, 'base64')
  await writeFile(outPath, buf)

  // Strip base64 from output; replace with path + size.
  const { base64: _drop, ...meta } = result
  return { ...meta, path: outPath, byteLength: buf.length }
}

function emit(obj, args, code) {
  const text = args.flags.pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)
  process.stdout.write(text + '\n')
  process.exit(code)
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e?.message ?? String(e) }) + '\n')
  process.exit(1)
})
