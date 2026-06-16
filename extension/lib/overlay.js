// overlay.js — visible "the agent is touching this page" indicator.
//
// Inspired by ChatGPT Atlas's breathing-glow effect. The overlay is injected
// into the page via CDP Runtime.evaluate (no content script registration
// needed) and is fully self-contained:
//
//   • A position:fixed full-page <div> with a glowing inset box-shadow that
//     pulses (breath ~1.6s loop)
//   • A small pill in the top-right that names the current action
//   • Lives in a sealed shadow root attached to a host element, so the page's
//     own CSS can't fight us
//   • Idempotent — calling pulse() repeatedly while one is active just
//     re-arms the auto-fade timer and updates the label
//   • Ignores all pointer events — never blocks the user
//
// We deliberately do NOT use chrome.scripting.executeScript: Runtime.evaluate
// runs in the page's main world and is already part of the same CDP session
// we use for clicks/snapshots, so the overlay piggybacks on the existing
// debugger attach without extra permissions.

import { sendDebugger, ensureAttached } from './interact.js'

// ── The page-side script ─────────────────────────────────────────────────────
// Defined as a string so Runtime.evaluate can inject it. The whole thing is
// IIFE-wrapped and stashes its API on window.__qqbOverlay__ for re-use.

const OVERLAY_SCRIPT = `(() => {
  const KEY = '__qqbOverlay__'
  if (window[KEY]) return window[KEY]

  const HOST_ID = 'qqb-cc-bridge-overlay-host'
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
  const shadow = host.attachShadow({ mode: 'closed' })

  shadow.innerHTML = \`
    <style>
      :host, .root, .root * { box-sizing: border-box; }
      .root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 0;
        transition: opacity 220ms ease-out;
      }
      .root.active { opacity: 1; }

      /* Breathing inner glow — the "atlas" feel.
         Two stacked shadows: a tight cyan ring + a soft outer wash that
         scales subtly via a CSS variable controlled by the keyframe. */
      .glow {
        position: absolute;
        inset: 0;
        border-radius: 0;
        --pulse: 0;
        box-shadow:
          inset 0 0 0 calc(2px + 1px * var(--pulse)) rgba(80, 200, 255, calc(0.55 + 0.35 * var(--pulse))),
          inset 0 0 calc(20px + 24px * var(--pulse)) rgba(80, 200, 255, calc(0.18 + 0.22 * var(--pulse))),
          inset 0 0 calc(60px + 80px * var(--pulse)) rgba(120, 220, 255, calc(0.10 + 0.18 * var(--pulse)));
        animation: qqbBreath 1700ms ease-in-out infinite;
      }
      @keyframes qqbBreath {
        0%, 100% { --pulse: 0; }
        50%      { --pulse: 1; }
      }

      /* Subtle top edge gradient so the screen reads as "framed" rather than
         tinted; mirrors Atlas's emphasis along the top edge. */
      .topEdge {
        position: absolute;
        top: 0; left: 0; right: 0; height: 80px;
        background: linear-gradient(180deg,
          rgba(80, 200, 255, 0.18) 0%,
          rgba(80, 200, 255, 0.06) 50%,
          rgba(80, 200, 255, 0) 100%);
        animation: qqbBreath 1700ms ease-in-out infinite;
        opacity: calc(0.5 + 0.5 * var(--pulse, 0));
      }

      /* Action label pill in the top-right corner. */
      .label {
        position: absolute;
        top: 14px;
        right: 14px;
        max-width: 60vw;
        font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC",
              "Helvetica Neue", Arial, sans-serif;
        color: #d5f4ff;
        background: rgba(8, 18, 28, 0.78);
        backdrop-filter: blur(10px) saturate(1.4);
        -webkit-backdrop-filter: blur(10px) saturate(1.4);
        border: 1px solid rgba(80, 200, 255, 0.45);
        border-radius: 999px;
        padding: 6px 12px 6px 26px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow:
          0 4px 18px rgba(0, 0, 0, 0.35),
          0 0 0 1px rgba(80, 200, 255, 0.08);
        transform: translateY(-4px);
        opacity: 0;
        transition: opacity 220ms ease-out, transform 220ms ease-out;
      }
      .root.active .label { opacity: 1; transform: translateY(0); }
      .label::before {
        content: '';
        position: absolute;
        top: 50%; left: 10px;
        width: 8px; height: 8px;
        margin-top: -4px;
        border-radius: 50%;
        background: rgb(80, 200, 255);
        box-shadow: 0 0 8px rgba(80, 200, 255, 0.9), 0 0 16px rgba(80, 200, 255, 0.5);
        animation: qqbDot 1200ms ease-in-out infinite;
      }
      @keyframes qqbDot {
        0%, 100% { transform: scale(1); opacity: 1; }
        50%      { transform: scale(1.35); opacity: 0.6; }
      }

      /* Honor user's accessibility preference. */
      @media (prefers-reduced-motion: reduce) {
        .glow, .topEdge, .label::before { animation: none; }
        .glow { --pulse: 0.5; }
      }
    </style>
    <div class="root" part="root">
      <div class="glow"></div>
      <div class="topEdge"></div>
      <div class="label">qqb · working</div>
    </div>
  \`

  ;(document.documentElement || document.body || document).appendChild(host)

  const root = shadow.querySelector('.root')
  const labelEl = shadow.querySelector('.label')
  let hideTimer = null

  function show(label, durationMs) {
    if (label != null) labelEl.textContent = label
    root.classList.add('active')
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (durationMs > 0) {
      hideTimer = setTimeout(() => hide(), durationMs)
    }
  }

  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    root.classList.remove('active')
  }

  function destroy() {
    hide()
    try { host.remove() } catch {}
    delete window[KEY]
  }

  const api = { show, hide, destroy, version: 1 }
  window[KEY] = api
  return api
})()`

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Pulse the overlay on a tab. Idempotent: if the overlay is already showing,
 * the label updates and the auto-hide timer resets.
 *
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {string} [opts.label]        Text shown in the pill, e.g. "qqb · click n5"
 * @param {number} [opts.durationMs]   Auto-hide after this many ms; 0 = stay on. Default 1500.
 */
export async function pulseOverlay({ tabId, label = 'qqb · working', durationMs = 1500 }) {
  if (!tabId) return
  try {
    await ensureAttached(tabId)
  } catch {
    // If we can't attach (chrome:// page etc.), skip silently — overlay is best-effort.
    return
  }
  // Inject (idempotent), then call show() with current label/duration.
  const expr = `(() => {
    ${OVERLAY_SCRIPT};
    if (window.__qqbOverlay__) {
      window.__qqbOverlay__.show(${JSON.stringify(label)}, ${Number(durationMs) || 0});
      return true;
    }
    return false;
  })()`
  try {
    await sendDebugger(tabId, 'Runtime.evaluate', {
      expression: expr,
      awaitPromise: false,
      returnByValue: true,
    })
  } catch {
    // Non-fatal — overlays are cosmetic.
  }
}

/**
 * Hide / remove the overlay on a tab. Optional; the auto-hide timer usually
 * suffices, but exposed for explicit "clear" calls (e.g. release).
 */
export async function clearOverlay({ tabId, destroy = false } = {}) {
  if (!tabId) return
  try {
    const expr = `(() => {
      const api = window.__qqbOverlay__;
      if (!api) return false;
      ${destroy ? 'api.destroy();' : 'api.hide();'}
      return true;
    })()`
    await sendDebugger(tabId, 'Runtime.evaluate', {
      expression: expr,
      awaitPromise: false,
      returnByValue: true,
    })
  } catch {
    // ignore — overlay is best-effort
  }
}
