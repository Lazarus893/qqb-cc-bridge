// overlay.js — visible "the agent is touching this page" indicator.
//
// Atlas-inspired breathing glow + click ripple at exact coordinates +
// folded command timeline in the corner. Everything is pure CSS animations
// + Web Animations API (no library dependency — important because we inject
// into arbitrary third-party pages).
//
// Architecture:
//   • One <div> host element appended to <html>, with a sealed shadow root
//     so the page's CSS can never reach in.
//   • Inside the shadow root: edge glow, top gradient, label pill,
//     ripple layer, timeline panel.
//   • State lives on window.__qqbOverlay__ — re-injection is a no-op.
//   • API surface: show / hide / destroy / ripple / log / setStatus.
//
// Status palette (cyan = working, green = ok, amber = warn, red = error)
// drives both the breath glow and the timeline row colors.

import { sendDebugger, ensureAttached } from './interact.js'

// ── The page-side script (string, injected via Runtime.evaluate) ─────────────

const OVERLAY_SCRIPT = `(() => {
  const KEY = '__qqbOverlay__'
  if (window[KEY] && window[KEY].version === 3) return window[KEY]
  if (window[KEY]) { try { window[KEY].destroy() } catch {} }

  const HOST_ID = 'qqb-cc-bridge-overlay-host'
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
  const shadow = host.attachShadow({ mode: 'closed' })

  // Status palette → glow + label + dot color
  const PALETTE = {
    working: { rgb: '80, 200, 255', bg: 'rgba(8, 18, 28, 0.78)' },     // cyan
    ok:      { rgb: '110, 231, 183', bg: 'rgba(8, 24, 18, 0.78)' },     // emerald
    warn:    { rgb: '252, 211, 77',  bg: 'rgba(28, 22, 6, 0.78)' },     // amber
    error:   { rgb: '248, 113, 113', bg: 'rgba(28, 10, 12, 0.78)' },    // rose
  }

  shadow.innerHTML = \`
    <style>
      :host, .root, .root * { box-sizing: border-box; }

      .root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 0;
        transition: opacity 240ms cubic-bezier(.2,.8,.2,1);
        --rgb: 80, 200, 255;
      }
      .root.active { opacity: 1; }

      /* Breathing inset glow — softer & more atmospheric than v1 */
      .glow {
        position: absolute; inset: 0;
        --pulse: 0;
        box-shadow:
          inset 0 0 0  calc(2px + 1px * var(--pulse))   rgba(var(--rgb), calc(0.50 + 0.30 * var(--pulse))),
          inset 0 0 calc(24px + 28px * var(--pulse))    rgba(var(--rgb), calc(0.16 + 0.20 * var(--pulse))),
          inset 0 0 calc(70px + 90px * var(--pulse))    rgba(var(--rgb), calc(0.08 + 0.16 * var(--pulse)));
        animation: qqbBreath 1800ms cubic-bezier(.45, 0, .55, 1) infinite;
      }
      @keyframes qqbBreath {
        0%, 100% { --pulse: 0; }
        50%      { --pulse: 1; }
      }

      /* Top edge wash — subtle "framed" feeling along the top */
      .topEdge {
        position: absolute;
        top: 0; left: 0; right: 0; height: 96px;
        background: linear-gradient(180deg,
          rgba(var(--rgb), 0.18) 0%,
          rgba(var(--rgb), 0.06) 45%,
          rgba(var(--rgb), 0) 100%);
        mix-blend-mode: screen;
        --pulseLite: 0.5;
        opacity: var(--pulseLite);
        animation: qqbBreathLite 1800ms cubic-bezier(.45, 0, .55, 1) infinite;
      }
      @keyframes qqbBreathLite {
        0%, 100% { --pulseLite: 0.45; }
        50%      { --pulseLite: 0.85; }
      }

      /* Action label pill — top-right */
      .label {
        position: absolute;
        top: 14px; right: 14px;
        max-width: 60vw;
        font: 500 12px/1.25 -apple-system, BlinkMacSystemFont, "PingFang SC",
              "Helvetica Neue", "Segoe UI", Arial, sans-serif;
        letter-spacing: 0.01em;
        color: #eaf6ff;
        background: rgba(8, 18, 28, 0.78);
        backdrop-filter: blur(12px) saturate(1.4);
        -webkit-backdrop-filter: blur(12px) saturate(1.4);
        border: 1px solid rgba(var(--rgb), 0.45);
        border-radius: 999px;
        padding: 7px 14px 7px 28px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow:
          0 6px 24px rgba(0, 0, 0, 0.40),
          0 0 0 1px rgba(var(--rgb), 0.10),
          0 0 24px rgba(var(--rgb), 0.18);
        transform: translateY(-6px) scale(0.96);
        opacity: 0;
        transition:
          opacity 240ms cubic-bezier(.2,.8,.2,1),
          transform 320ms cubic-bezier(.2, 1.2, .25, 1),
          background 200ms ease, border-color 200ms ease;
      }
      .root.active .label { opacity: 1; transform: translateY(0) scale(1); }

      .label::before {
        content: '';
        position: absolute;
        top: 50%; left: 11px;
        width: 8px; height: 8px;
        margin-top: -4px;
        border-radius: 50%;
        background: rgb(var(--rgb));
        box-shadow:
          0 0 8px rgba(var(--rgb), 0.95),
          0 0 18px rgba(var(--rgb), 0.55);
        animation: qqbDot 1200ms ease-in-out infinite;
      }
      @keyframes qqbDot {
        0%, 100% { transform: scale(1);    opacity: 1;   }
        50%      { transform: scale(1.40); opacity: 0.55; }
      }

      /* Click ripple at exact coordinates — appended dynamically */
      .ripple {
        position: absolute;
        width: 12px; height: 12px;
        margin: -6px 0 0 -6px;
        border-radius: 50%;
        border: 2px solid rgba(var(--rgb), 0.9);
        background: rgba(var(--rgb), 0.28);
        box-shadow: 0 0 24px rgba(var(--rgb), 0.55);
        opacity: 1;
        animation: qqbRipple 720ms cubic-bezier(.2, .65, .15, 1) forwards;
      }
      @keyframes qqbRipple {
        0%   { transform: scale(0.4); opacity: 0; }
        20%  { opacity: 1; }
        100% { transform: scale(8);   opacity: 0; }
      }

      /* Command timeline panel — bottom-right */
      .timeline {
        position: absolute;
        bottom: 14px; right: 14px;
        width: 280px;
        max-width: 60vw;
        font: 500 11px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC",
              "Helvetica Neue", "Segoe UI", Arial, sans-serif;
        background: rgba(8, 18, 28, 0.72);
        backdrop-filter: blur(14px) saturate(1.5);
        -webkit-backdrop-filter: blur(14px) saturate(1.5);
        border: 1px solid rgba(var(--rgb), 0.18);
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255,255,255,0.04) inset;
        overflow: hidden;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 240ms cubic-bezier(.2,.8,.2,1),
                    transform 280ms cubic-bezier(.2, 1.1, .3, 1);
      }
      .timeline.show { opacity: 1; transform: translateY(0); }
      .timelineHeader {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        color: rgba(234, 246, 255, 0.78);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-size: 10px;
      }
      .timelineHeader .count {
        background: rgba(var(--rgb), 0.16);
        color: rgb(var(--rgb));
        padding: 1px 7px;
        border-radius: 999px;
        font-size: 10px;
        letter-spacing: 0;
      }
      .timelineList {
        padding: 4px 0;
        max-height: 180px;
        overflow: hidden;
      }
      .row {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 12px;
        color: #cfe5f5;
        animation: qqbRowIn 320ms cubic-bezier(.2, 1.0, .3, 1);
      }
      @keyframes qqbRowIn {
        from { opacity: 0; transform: translateX(8px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      .row .badge {
        flex: 0 0 auto;
        width: 6px; height: 6px;
        border-radius: 50%;
        background: rgb(var(--rgb));
        box-shadow: 0 0 8px rgba(var(--rgb), 0.7);
      }
      .row.ok    .badge { background: rgb(110, 231, 183); box-shadow: 0 0 8px rgba(110, 231, 183, 0.7); }
      .row.warn  .badge { background: rgb(252, 211, 77);  box-shadow: 0 0 8px rgba(252, 211, 77,  0.7); }
      .row.error .badge { background: rgb(248, 113, 113); box-shadow: 0 0 8px rgba(248, 113, 113, 0.7); }
      .row.ok .text    { color: #d1fae5; }
      .row.warn .text  { color: #fef3c7; }
      .row.error .text { color: #fee2e2; }
      .row .text {
        flex: 1 1 auto;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row .ts {
        flex: 0 0 auto;
        font-size: 10px;
        color: rgba(207, 229, 245, 0.55);
        font-variant-numeric: tabular-nums;
      }

      /* Honor reduced-motion */
      @media (prefers-reduced-motion: reduce) {
        .glow, .topEdge, .label::before { animation: none; }
        .glow { --pulse: 0.55; }
        .ripple { animation: none; opacity: 0; }
      }
    </style>
    <div class="root" part="root">
      <div class="glow"></div>
      <div class="topEdge"></div>
      <div class="ripples"></div>
      <div class="label">qqb · idle</div>
      <div class="timeline">
        <div class="timelineHeader">
          <span>qqb timeline</span>
          <span class="count">0</span>
        </div>
        <div class="timelineList"></div>
      </div>
    </div>
  \`

  ;(document.documentElement || document.body || document).appendChild(host)

  const root      = shadow.querySelector('.root')
  const labelEl   = shadow.querySelector('.label')
  const ripplesEl = shadow.querySelector('.ripples')
  const timelineEl = shadow.querySelector('.timeline')
  const listEl    = shadow.querySelector('.timelineList')
  const countEl   = shadow.querySelector('.count')

  let hideTimer = null
  let timelineHideTimer = null
  let savedDisplay = ''
  const MAX_ROWS = 5
  let rowCount = 0

  function setStatus(status) {
    const p = PALETTE[status] || PALETTE.working
    root.style.setProperty('--rgb', p.rgb)
  }

  function show(label, durationMs, status) {
    if (label != null) labelEl.textContent = label
    if (status) setStatus(status)
    root.classList.add('active')
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (durationMs > 0) {
      hideTimer = setTimeout(() => hide(), durationMs)
    }
    showTimeline()
  }

  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    root.classList.remove('active')
    // Keep timeline visible briefly so users can read the last entry.
    if (timelineHideTimer) clearTimeout(timelineHideTimer)
    timelineHideTimer = setTimeout(() => hideTimeline(), 2400)
  }

  function showTimeline() {
    if (timelineHideTimer) { clearTimeout(timelineHideTimer); timelineHideTimer = null }
    timelineEl.classList.add('show')
  }

  function hideTimeline() {
    timelineEl.classList.remove('show')
  }

  function ripple(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return
    const r = document.createElement('div')
    r.className = 'ripple'
    r.style.left = x + 'px'
    r.style.top  = y + 'px'
    ripplesEl.appendChild(r)
    setTimeout(() => { try { r.remove() } catch {} }, 800)
  }

  // Add a row to the timeline. status ∈ working|ok|warn|error.
  function log(text, status = 'ok') {
    const row = document.createElement('div')
    row.className = 'row ' + status
    const badge = document.createElement('div'); badge.className = 'badge'
    const txt = document.createElement('div'); txt.className = 'text'; txt.textContent = text
    const ts = document.createElement('div'); ts.className = 'ts'
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    ts.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    row.appendChild(badge); row.appendChild(txt); row.appendChild(ts)
    listEl.insertBefore(row, listEl.firstChild)
    while (listEl.children.length > MAX_ROWS) {
      const last = listEl.lastChild
      if (last) {
        last.style.transition = 'opacity 200ms ease, height 200ms ease'
        last.style.opacity = '0'
        setTimeout(() => { try { last.remove() } catch {} }, 220)
      } else break
    }
    rowCount = Math.min(MAX_ROWS, rowCount + 1)
    countEl.textContent = String(rowCount)
    showTimeline()
  }

  // Hide the entire overlay element from rendering temporarily —
  // used by the bridge for clean screenshots.
  function setVisible(v) {
    if (v) {
      host.style.display = savedDisplay || ''
    } else {
      savedDisplay = host.style.display
      host.style.display = 'none'
    }
  }

  function destroy() {
    hide()
    try { host.remove() } catch {}
    delete window[KEY]
  }

  const api = { show, hide, ripple, log, destroy, setStatus, setVisible, version: 3 }
  window[KEY] = api
  return api
})()`

// ── Public API ───────────────────────────────────────────────────────────────

// Helper — runs a debugger call with a hard timeout so cosmetic overlay ops
// can never block the user-facing action if the page is mid-load or the SW
// is stalled. 800ms is plenty for Runtime.evaluate of a tiny script.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('overlay timeout')), ms)),
  ])
}

/**
 * Pulse the overlay on a tab. Idempotent: if the overlay is already showing,
 * the label updates and the auto-hide timer resets.
 *
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {string} [opts.label]      Pill text, e.g. "qqb · click n5"
 * @param {number} [opts.durationMs] Auto-hide after N ms; 0 = stay on. Default 1500.
 * @param {string} [opts.status]     working|ok|warn|error — drives color
 * @param {{x:number,y:number}} [opts.ripple]  Click coords (in viewport px)
 * @param {string} [opts.logText]    Append a row to the timeline
 * @param {string} [opts.logStatus]  Status for the timeline row (default 'ok')
 */
export async function pulseOverlay({
  tabId,
  label = 'qqb · working',
  durationMs = 1500,
  status = 'working',
  ripple,
  logText,
  logStatus = 'ok',
}) {
  if (!tabId) return
  try {
    await withTimeout(ensureAttached(tabId), 800)
  } catch {
    return
  }
  // Build a one-shot expression that injects (idempotent), shows, optionally
  // ripples, optionally logs.
  const calls = [
    `api.show(${JSON.stringify(label)}, ${Number(durationMs) || 0}, ${JSON.stringify(status)})`,
  ]
  if (ripple && typeof ripple.x === 'number' && typeof ripple.y === 'number') {
    calls.push(`api.ripple(${ripple.x}, ${ripple.y})`)
  }
  if (logText) {
    calls.push(`api.log(${JSON.stringify(logText)}, ${JSON.stringify(logStatus)})`)
  }
  const expr = `(() => {
    const api = ${OVERLAY_SCRIPT};
    if (!api) return false;
    ${calls.join(';')};
    return true;
  })()`
  try {
    await withTimeout(sendDebugger(tabId, 'Runtime.evaluate', {
      expression: expr,
      awaitPromise: false,
      returnByValue: true,
    }), 1500)
  } catch {
    // best-effort
  }
}

/** Append a row to the timeline without changing the breath label. */
export async function logOverlay({ tabId, text, status = 'ok' }) {
  if (!tabId || !text) return
  try {
    await withTimeout(ensureAttached(tabId), 800)
    const expr = `(() => {
      const api = ${OVERLAY_SCRIPT};
      if (!api) return false;
      api.log(${JSON.stringify(text)}, ${JSON.stringify(status)});
      return true;
    })()`
    await withTimeout(sendDebugger(tabId, 'Runtime.evaluate', {
      expression: expr, awaitPromise: false, returnByValue: true,
    }), 1500)
  } catch {}
}

/** Hide / destroy the overlay. */
export async function clearOverlay({ tabId, destroy = false } = {}) {
  if (!tabId) return
  try {
    const expr = `(() => {
      const api = window.__qqbOverlay__;
      if (!api) return false;
      ${destroy ? 'api.destroy();' : 'api.hide();'}
      return true;
    })()`
    await withTimeout(sendDebugger(tabId, 'Runtime.evaluate', {
      expression: expr, awaitPromise: false, returnByValue: true,
    }), 1500)
  } catch {}
}

/**
 * Toggle overlay host visibility — used by `qqb screenshot --clean` so the
 * captured image doesn't include the overlay chrome.
 */
export async function setOverlayVisible({ tabId, visible }) {
  if (!tabId) return
  try {
    const expr = `(() => {
      const api = window.__qqbOverlay__;
      if (!api) return false;
      api.setVisible(${visible ? 'true' : 'false'});
      return true;
    })()`
    await withTimeout(sendDebugger(tabId, 'Runtime.evaluate', {
      expression: expr, awaitPromise: false, returnByValue: true,
    }), 1500)
  } catch {}
}
