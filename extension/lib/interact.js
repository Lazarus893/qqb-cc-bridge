// interact.js — debugger lifecycle + interactions (click/type/scroll/navigate/wait/exec).
//
// All interactions go through CDP rather than chrome.scripting where it
// matters, so synthetic events look closer to real hardware (e.g. login forms
// that gate on `isTrusted`).

import { cdp } from './cdp.js'

const ATTACHED = new Set()
const REF_TABLES = new Map() // tabId → { nodeRef → {axId, backendDOMNodeId} }
const DEBUGGER_PROTOCOL_VERSION = '1.3'

// ── Debugger lifecycle ───────────────────────────────────────────────────────

export function isAttached(tabId) { return ATTACHED.has(tabId) }
export function listAttachedTabs() { return [...ATTACHED] }

export async function attachTab(tabId) {
  if (ATTACHED.has(tabId)) return
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve()
    })
  })
  ATTACHED.add(tabId)
  // Domain-enable calls intentionally bypass the retry helper. Reattach is
  // implemented via attachTab itself; if a transient failure here looped back
  // through cdp(), we'd recurse. retries:0 keeps it linear.
  await cdp(tabId, 'DOM.enable', {}, { retries: 0 })
  await cdp(tabId, 'Runtime.enable', {}, { retries: 0 })
  await cdp(tabId, 'Page.enable', {}, { retries: 0 })
  await cdp(tabId, 'Accessibility.enable', {}, { retries: 0 })
}

export async function detachTab(tabId) {
  if (!ATTACHED.has(tabId)) return
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve())
  })
  ATTACHED.delete(tabId)
  REF_TABLES.delete(tabId)
}

export async function ensureAttached(tabId) {
  if (!ATTACHED.has(tabId)) await attachTab(tabId)
}

// Thin compatibility shim — kept exported so existing importers (overlay.js,
// ax-tree.js) don't need to change. All CDP traffic now flows through
// cdp() so transient errors auto-recover.
export function sendDebugger(tabId, method, params) {
  return cdp(tabId, method, params)
}

// ── nodeRef ↔ AX node bookkeeping (called from snapshotTab) ──────────────────

export function stashRefTable(tabId, refTable) {
  REF_TABLES.set(tabId, refTable)
}

function resolveNodeRef(tabId, nodeRef) {
  const tbl = REF_TABLES.get(tabId)
  const entry = tbl?.[nodeRef]
  if (!entry) {
    throw new Error(
      `unknown nodeRef "${nodeRef}" for tab ${tabId}. Re-snapshot first — node refs are scoped to the most recent qqb.snapshot.`
    )
  }
  return entry
}

async function resolveToObjectId(tabId, nodeRef) {
  const { backendDOMNodeId } = resolveNodeRef(tabId, nodeRef)
  if (!backendDOMNodeId) throw new Error(`nodeRef ${nodeRef} has no DOM node (offscreen / aria-only)`)
  const { object } = await sendDebugger(tabId, 'DOM.resolveNode', {
    backendNodeId: backendDOMNodeId,
  })
  return object.objectId
}

async function getBoundingBox(tabId, nodeRef) {
  const objectId = await resolveToObjectId(tabId, nodeRef)
  const { result } = await sendDebugger(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function () {
      this.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
      const r = this.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
    }`,
    returnByValue: true,
  })
  if (!result?.value) throw new Error('cannot get bounding box (element not in layout)')
  if (result.value.w === 0 || result.value.h === 0) {
    throw new Error('element has zero size — likely hidden')
  }
  return result.value
}

// ── click ────────────────────────────────────────────────────────────────────

export async function click(tabId, params) {
  await ensureAttached(tabId)
  const before = (await chrome.tabs.get(tabId)).url
  const { x, y } = await getBoundingBox(tabId, params.nodeRef)
  const button = params.button ?? 'left'
  const clickCount = params.clickCount ?? 1
  await sendDebugger(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none',
  })
  await sendDebugger(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount,
  })
  await sendDebugger(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount,
  })
  // Brief settle so navigation starts before we report.
  await new Promise((r) => setTimeout(r, 50))
  const after = (await chrome.tabs.get(tabId)).url
  // Expose viewport coords so the overlay can ripple at the exact click point.
  return { ok: true, navigated: before !== after, newUrl: after, _coords: { x, y } }
}

// ── type ─────────────────────────────────────────────────────────────────────

export async function typeText(tabId, params) {
  await ensureAttached(tabId)
  const objectId = await resolveToObjectId(tabId, params.nodeRef)

  // Focus first; for contenteditable, click into it.
  await sendDebugger(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function () { this.focus({preventScroll:false}); this.scrollIntoView({block:'center'}); }`,
    returnByValue: true,
  })

  if (params.clear) {
    // Select-all + delete via key events.
    await keyChord(tabId, 'a', { ctrl: true })
    await keyPress(tabId, 'Delete')
  }

  // Insert text — Input.insertText is the cheapest reliable path for IMEs.
  if (params.text) {
    await sendDebugger(tabId, 'Input.insertText', { text: params.text })
  }

  if (params.submit) {
    await keyPress(tabId, 'Enter')
  }

  // Read back the value if it's an input/textarea; contenteditable returns ''.
  const { result } = await sendDebugger(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function () { return this.value ?? this.textContent ?? ''; }`,
    returnByValue: true,
  })
  return { ok: true, value: result?.value }
}

async function keyPress(tabId, key) {
  const codeMap = { Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape' }
  const code = codeMap[key] ?? key
  await sendDebugger(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: vkFor(key),
  })
  await sendDebugger(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: vkFor(key),
  })
}

async function keyChord(tabId, key, mods) {
  const modBits =
    (mods.ctrl ? 2 : 0) | (mods.alt ? 1 : 0) | (mods.shift ? 8 : 0) | (mods.meta ? 4 : 0)
  await sendDebugger(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key, code: `Key${key.toUpperCase()}`, modifiers: modBits,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  })
  await sendDebugger(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: `Key${key.toUpperCase()}`, modifiers: modBits,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  })
}

function vkFor(key) {
  const map = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27 }
  return map[key] ?? key.charCodeAt?.(0) ?? 0
}

// ── scroll ───────────────────────────────────────────────────────────────────

export async function scroll(tabId, params) {
  await ensureAttached(tabId)
  if (params.nodeRef) {
    const objectId = await resolveToObjectId(tabId, params.nodeRef)
    await sendDebugger(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () { this.scrollIntoView({block:'center', behavior:'instant'}); }`,
      returnByValue: true,
    })
    return { ok: true }
  }
  const dir = params.direction ?? 'down'
  const pages = params.pages ?? 1
  await sendDebugger(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const h = window.innerHeight;
      if ('${dir}' === 'top') window.scrollTo({top:0});
      else if ('${dir}' === 'bottom') window.scrollTo({top:document.body.scrollHeight});
      else window.scrollBy({top: ${dir === 'up' ? '-' : ''}h * ${pages}, behavior:'instant'});
    })()`,
    awaitPromise: false,
    returnByValue: true,
  })
  return { ok: true }
}

// ── navigate ─────────────────────────────────────────────────────────────────

export async function navigate(params) {
  let tabId = params.tabId
  if (params.newTab || tabId == null) {
    const tab = await chrome.tabs.create({ url: params.url, active: true })
    tabId = tab.id
    await waitForLoad(tabId, params.waitUntil ?? 'load')
    return { ok: true, tabId, finalUrl: tab.url, title: tab.title }
  }
  await ensureAttached(tabId)
  await sendDebugger(tabId, 'Page.navigate', { url: params.url })
  await waitForLoad(tabId, params.waitUntil ?? 'load')
  const tab = await chrome.tabs.get(tabId)
  return { ok: true, tabId, finalUrl: tab.url, title: tab.title }
}

function waitForLoad(tabId, waitUntil) {
  return new Promise((resolve) => {
    if (waitUntil === 'domcontentloaded') {
      // chrome.tabs has no DOMContentLoaded; approximate with status='complete'.
    }
    const t0 = Date.now()
    const check = async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      if (!tab) return resolve()
      if (tab.status === 'complete') return resolve()
      if (Date.now() - t0 > 30_000) return resolve() // give up gracefully
      setTimeout(check, 100)
    }
    check()
  })
}

// ── wait_for ─────────────────────────────────────────────────────────────────

export async function waitFor(tabId, params) {
  await ensureAttached(tabId)
  const { condition, timeoutMs = 10_000 } = params
  const start = Date.now()
  const deadline = start + timeoutMs

  while (Date.now() < deadline) {
    if (await checkCondition(tabId, condition)) {
      return { ok: true, elapsedMs: Date.now() - start }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`wait_for ${condition.type} timed out after ${timeoutMs}ms`)
}

async function checkCondition(tabId, c) {
  if (c.type === 'idle') {
    // Approximation: page is "idle" if its document.readyState is complete and
    // no DOM mutations within the requested ms.
    const ms = c.ms ?? 500
    const { result } = await sendDebugger(tabId, 'Runtime.evaluate', {
      expression: `(async () => {
        if (document.readyState !== 'complete') return false;
        return new Promise(r => {
          let dirty = false;
          const obs = new MutationObserver(() => { dirty = true; });
          obs.observe(document.documentElement, {childList:true, subtree:true, attributes:true, characterData:true});
          setTimeout(() => { obs.disconnect(); r(!dirty); }, ${ms});
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    return result?.value === true
  }
  if (c.type === 'url-changes') {
    const tab = await chrome.tabs.get(tabId)
    return c.from ? tab.url !== c.from : true
  }
  if (c.type === 'url-matches') {
    const tab = await chrome.tabs.get(tabId)
    try { return new RegExp(c.pattern).test(tab.url) } catch { return false }
  }
  if (c.type === 'selector') {
    const { result } = await sendDebugger(tabId, 'Runtime.evaluate', {
      expression: `!!document.querySelector(${JSON.stringify(c.selector)})`,
      returnByValue: true,
    })
    return result?.value === true
  }
  if (c.type === 'no-selector') {
    const { result } = await sendDebugger(tabId, 'Runtime.evaluate', {
      expression: `!document.querySelector(${JSON.stringify(c.selector)})`,
      returnByValue: true,
    })
    return result?.value === true
  }
  return false
}

// ── exec_js ──────────────────────────────────────────────────────────────────

export async function execJs(tabId, params) {
  await ensureAttached(tabId)
  const { result, exceptionDetails } = await sendDebugger(tabId, 'Runtime.evaluate', {
    expression: params.expr,
    awaitPromise: params.awaitPromise ?? true,
    returnByValue: true,
  })
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text || 'evaluation error')
  }
  return { value: result?.value }
}

// ── read_text ────────────────────────────────────────────────────────────────

export async function readText(tabId, params) {
  await ensureAttached(tabId)
  const selector = params.selector
  const { result } = await sendDebugger(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
      if (!root) return { text: '', wordCount: 0 };
      // Prefer <article> if present and selector unspecified.
      const target = ${selector ? 'root' : '(document.querySelector("article") || root)'};
      // Strip script/style/nav noise.
      const clone = target.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,nav,footer,aside,header').forEach(n => n.remove());
      const text = clone.innerText.replace(/\\n{3,}/g, '\\n\\n').trim();
      return { text, wordCount: text.split(/\\s+/).filter(Boolean).length };
    })()`,
    awaitPromise: false,
    returnByValue: true,
  })
  const tab = await chrome.tabs.get(tabId)
  return {
    tabId,
    url: tab.url,
    title: tab.title,
    text: result?.value?.text ?? '',
    wordCount: result?.value?.wordCount ?? 0,
  }
}

// ── screenshot ───────────────────────────────────────────────────────────────
//
// CDP Page.captureScreenshot is the canonical way. Three shapes:
//   - viewport (default): just what's visible
//   - fullPage: `captureBeyondViewport: true` + clip = whole document
//   - element by nodeRef: scrollIntoView, then clip to its absolute box
//
// Returns { tabId, url, title, format, base64, width, height, byteLength }.
// The bridge/CLI writes the bytes to disk so CC doesn't drag MB of base64
// through its context. base64 is what CDP gives us; we pass it through.

export async function screenshot(tabId, params) {
  await ensureAttached(tabId)

  const format = params.format === 'jpeg' ? 'jpeg' : 'png'
  const quality = format === 'jpeg' ? Math.max(1, Math.min(100, params.quality ?? 80)) : undefined
  const scale = params.scale ?? 1

  /** @type {any} */
  const cdpParams = {
    format,
    captureBeyondViewport: false,
  }
  if (quality != null) cdpParams.quality = quality

  let clipMeta = null

  if (params.nodeRef) {
    // Element screenshot: scroll into view, capture absolute box.
    const objectId = await resolveToObjectId(tabId, params.nodeRef)
    const { result } = await sendDebugger(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () {
        this.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
        const r = this.getBoundingClientRect();
        return {
          x: r.left + window.scrollX,
          y: r.top + window.scrollY,
          width: r.width,
          height: r.height,
          dpr: window.devicePixelRatio || 1,
        };
      }`,
      returnByValue: true,
    })
    const box = result?.value
    if (!box) throw new Error('cannot get bounding box for screenshot')
    if (box.width === 0 || box.height === 0) throw new Error('element has zero size')
    cdpParams.clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale }
    cdpParams.captureBeyondViewport = true
    clipMeta = box
  } else if (params.fullPage) {
    // Full page: capture beyond viewport at the document's full size.
    const { result } = await sendDebugger(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const d = document.documentElement, b = document.body;
        const w = Math.max(d.scrollWidth, b ? b.scrollWidth : 0, d.clientWidth);
        const h = Math.max(d.scrollHeight, b ? b.scrollHeight : 0, d.clientHeight);
        return { width: w, height: h, dpr: window.devicePixelRatio || 1 };
      })()`,
      returnByValue: true,
    })
    const dim = result?.value
    if (!dim) throw new Error('cannot read document dimensions')
    cdpParams.clip = { x: 0, y: 0, width: dim.width, height: dim.height, scale }
    cdpParams.captureBeyondViewport = true
    clipMeta = dim
  }
  // else: viewport-only — leave clip unset

  const { data } = await sendDebugger(tabId, 'Page.captureScreenshot', cdpParams)
  if (!data) throw new Error('captureScreenshot returned no data')

  const tab = await chrome.tabs.get(tabId)
  // base64 length → byte length: ceil(len/4)*3 minus padding
  const padding = (data.match(/=*$/)?.[0] ?? '').length
  const byteLength = Math.floor(data.length * 3 / 4) - padding

  return {
    tabId,
    url: tab.url,
    title: tab.title,
    format,
    base64: data,
    byteLength,
    width: clipMeta?.width,
    height: clipMeta?.height,
    dpr: clipMeta?.dpr ?? 1,
    fullPage: Boolean(params.fullPage),
    nodeRef: params.nodeRef ?? null,
  }
}

