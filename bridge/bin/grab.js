#!/usr/bin/env node
// grab.js — high-cadence screenshot grabber.
//
// Holds ONE WebSocket connection to the daemon and fires screenshot
// requests as fast as the round-trip allows, writing PNG frames to
// $FRAME_DIR/frame-NNNN.png. Driven by a sibling process that runs
// the actual demo actions (qqb pulse / click / etc).
//
// Usage:
//   FRAME_DIR=/tmp/qqb-demo TAB=1715533381 node grab.js
//
// Stops cleanly on SIGTERM.

import WebSocket from 'ws'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const FRAME_DIR = process.env.FRAME_DIR
const TAB_ID = Number(process.env.TAB)
const BRIDGE_URL = process.env.QQB_BRIDGE_URL ?? 'ws://127.0.0.1:9528'
const TARGET_FPS = Number(process.env.FPS ?? 12)

if (!FRAME_DIR || !TAB_ID) {
  console.error('FRAME_DIR + TAB env required')
  process.exit(1)
}

await mkdir(FRAME_DIR, { recursive: true })

const token = (await readFile(join(homedir(), '.qqb-cc-bridge', 'token'), 'utf8')).trim()

const ws = new WebSocket(BRIDGE_URL)
const pending = new Map()

await new Promise((resolve, reject) => {
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token, role: 'mcp-client' })))
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === 'auth-ok') return resolve()
    if (msg.type === 'response') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  })
  ws.on('close', () => reject(new Error('ws closed')))
  ws.on('error', (e) => reject(e))
})

function call(method, params) {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, type: 'request', method, params }))
  })
}

let stopping = false
process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

let frame = 0
const targetIntervalMs = 1000 / TARGET_FPS
console.error(`[grab] tab=${TAB_ID} fps=${TARGET_FPS} interval=${targetIntervalMs.toFixed(1)}ms → ${FRAME_DIR}`)

while (!stopping) {
  const t0 = Date.now()
  try {
    const r = await call('screenshot', {
      tabId: TAB_ID,
      mode: 'ax',
      maxNodes: 800,
      format: 'png',
      scale: 1,
      quiet: true,
    })
    if (r?.base64) {
      const out = join(FRAME_DIR, `frame-${String(frame).padStart(4, '0')}.png`)
      await writeFile(out, Buffer.from(r.base64, 'base64'))
      frame++
    }
  } catch (e) {
    console.error('[grab]', e.message)
  }
  const elapsed = Date.now() - t0
  const remain = targetIntervalMs - elapsed
  if (remain > 0) await new Promise((r) => setTimeout(r, remain))
}

console.error(`[grab] captured ${frame} frames`)
try { ws.close() } catch {}
process.exit(0)
