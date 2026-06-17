// ax-tree.js — fetch a tree representation of the page via CDP and fold/strip
// it into a shape that's cheap for an LLM to understand.
//
// Three modes are supported:
//   • 'ax'    — CDP Accessibility tree (default). Walks cross-frame iframes
//               and grafts child-frame trees under their owning Iframe nodes.
//   • 'dom'   — CDP DOM tree. Useful for canvas-heavy / non-semantic pages
//               where the AX tree returns mostly `generic` / empty-name nodes.
//   • 'mixed' — Try AX first; if the result looks too thin (fewer than
//               MIXED_FALLBACK_THRESHOLD named nodes), re-run as DOM and
//               return that with mode: 'dom-fallback'.
//
// AX-mode compaction rules:
//   • Drop nodes whose role is structural noise (generic, none, presentation,
//     ScrollArea, GenericContainer) UNLESS they have a name worth keeping.
//   • Promote children: if a stripped node has children, hoist them to the
//     parent's children list.
//   • Truncate names/values longer than ~200 chars.
//   • Assign a stable `nodeRef` (n0, n1, …) to every interactive node.
//   • Hard-cap the result at maxNodes (DFS, depth-first), and tell the caller
//     how much was elided.
//
// DOM-mode rules:
//   • Skip script/style/meta/link/head/noscript/comment nodes.
//   • Prefer aria-label / aria-labelledby for `name`.
//   • Capture id / className / value / bbox (bbox only for interactive-ish
//     nodes — DOM.getBoxModel is expensive).
//   • Same maxNodes cap and stable nodeRef numbering.
//
// Returns { tabId, url, title, mode, etag, nodeCount, frames, truncated, tree }.

import { sendDebugger, ensureAttached, stashRefTable } from './interact.js'

// ── Heuristics ────────────────────────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'option', 'treeitem',
])

const STRUCTURAL_NOISE_ROLES = new Set([
  'generic', 'none', 'presentation', 'GenericContainer', 'inline',
  'LineBreak', 'EmbeddedObject',
])

const INFORMATIVE_ROLES = new Set([
  'heading', 'paragraph', 'staticText', 'list', 'listitem', 'image',
  'table', 'row', 'cell', 'columnheader', 'rowheader',
  'navigation', 'main', 'banner', 'contentinfo', 'region', 'article',
  'form', 'dialog', 'alert', 'status', 'tooltip',
])

// AX roles that mark an embedded frame in the parent document.
const FRAME_ROLES = new Set(['Iframe', 'iframe', 'IframePresentational'])

const MAX_NAME_LEN = 200
const MAX_VALUE_LEN = 200

// DOM tags that are never interesting to walk into.
const DOM_SKIP_TAGS = new Set([
  'script', 'style', 'meta', 'link', 'head', 'noscript', 'template',
])

// DOM tags that look interactive enough to justify a getBoxModel call.
const DOM_INTERACTIVE_TAGS = new Set([
  'button', 'a', 'input', 'select', 'textarea',
])

// "This page is non-semantic" heuristic for mixed-mode fallback.
export const MIXED_FALLBACK_THRESHOLD = 20

// CDP Node.nodeType constants (matches DOM Node.nodeType).
const NODE_TYPE_ELEMENT = 1
const NODE_TYPE_TEXT = 3
const NODE_TYPE_DOCUMENT = 9
const NODE_TYPE_DOCUMENT_FRAGMENT = 11

// Hard cap on iframe recursion depth.
const MAX_FRAME_DEPTH = 3

// Full-page screenshot caps (defensive — see runDomSnapshot / ax-tree
// concerns: Chromium can crash the render process when asked to render
// excessively tall documents in one capture).
export const MAX_FULLPAGE_HEIGHT_PX = 16000

// Same-origin check helper for cross-frame walking. Returns true if the
// child frame URL is same-origin with the parent (so getFullAXTree is safe),
// false otherwise — including all opaque/about:/data: schemes which we
// classify as cross-origin out of caution.
export function isSameOrigin(parentUrl, childUrl) {
  if (!parentUrl || !childUrl) return false
  // about:blank / about:srcdoc inherit the embedder's origin in practice and
  // are safe to walk.
  if (childUrl === 'about:blank' || childUrl.startsWith('about:srcdoc')) return true
  try {
    const p = new URL(parentUrl)
    const c = new URL(childUrl)
    return p.origin === c.origin
  } catch {
    return false
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Snapshot a tab.
 * @param {number} tabId
 * @param {{ mode?: 'ax'|'dom'|'mixed', maxNodes?: number }} opts
 */
export async function snapshotTab(tabId, opts = {}) {
  const mode = opts.mode ?? 'ax'
  const maxNodes = opts.maxNodes ?? 800

  await ensureAttached(tabId)
  await sendDebugger(tabId, 'Accessibility.enable', {}).catch(() => {})

  const tab = await chrome.tabs.get(tabId)

  // Per-snapshot ref-counter and ref-table — shared across all modes and
  // across iframe recursion so every nodeRef is unique within the snapshot.
  const ctx = {
    tabId,
    counter: 0,
    refTable: {},
    remaining: maxNodes,
    truncated: false,
  }

  let payload
  if (mode === 'dom') {
    payload = await runDomSnapshot(ctx)
    payload.mode = 'dom'
  } else if (mode === 'mixed') {
    const ax = await runAxSnapshot(ctx)
    if (countNamed(ax.tree) < MIXED_FALLBACK_THRESHOLD) {
      // Reset ctx for the DOM pass so refs start fresh.
      ctx.counter = 0
      ctx.refTable = {}
      ctx.remaining = maxNodes
      ctx.truncated = false
      payload = await runDomSnapshot(ctx)
      payload.mode = 'dom-fallback'
    } else {
      payload = ax
      payload.mode = 'ax'
    }
  } else {
    payload = await runAxSnapshot(ctx)
    payload.mode = 'ax'
  }

  stashRefTable(tabId, ctx.refTable)

  return {
    tabId,
    url: tab.url,
    title: tab.title,
    mode: payload.mode,
    etag: hashEtag(payload.tree),
    nodeCount: payload.nodeCount,
    frames: payload.frames ?? 0,
    truncated: ctx.truncated,
    tree: payload.tree,
  }
}

// ── AX-mode driver (with cross-frame iframe walking) ─────────────────────────

async function runAxSnapshot(ctx) {
  const { tabId } = ctx

  // 1. Pull the frame tree once so we know which frameIds exist.
  let frameTree = null
  try {
    const r = await sendDebugger(tabId, 'Page.getFrameTree', {})
    frameTree = r?.frameTree ?? null
  } catch {
    // Page domain may not be ready; carry on with top-frame only.
  }

  // 2. Top-level AX tree.
  const { nodes: topNodes } = await sendDebugger(
    tabId, 'Accessibility.getFullAXTree', {}
  )
  const topCompact = compactAxNodes(topNodes, ctx)

  // 3. Walk child frames (depth-first) and graft them into the top tree.
  // The parent URL drives the same-origin check inside graftChildFrames —
  // we never issue getFullAXTree against a cross-origin frameId, because on
  // some Chromium-derived browsers (notably QQ Browser) that call has been
  // observed to crash the render process (Aw-Snap, error 5) instead of
  // rejecting the CDP request.
  let framesMerged = 0
  const parentUrl = frameTree?.frame?.url ?? null
  if (frameTree?.childFrames?.length) {
    framesMerged = await graftChildFrames(
      ctx, topCompact.tree, frameTree.childFrames, /* depth */ 1, parentUrl
    )
  }

  return {
    tree: topCompact.tree,
    nodeCount: topCompact.nodeCount,
    frames: framesMerged,
  }
}

/**
 * Recursively walk `childFrames` from CDP, fetch each frame's AX tree, and
 * graft each child's compacted children into the matching Iframe leaf in
 * `parentTree`. Returns the number of frames successfully merged.
 *
 * `parentUrl` is the URL of the frame whose AX tree contains parentTree.
 * It's used to decide same-origin vs cross-origin for each child:
 *   • same-origin → safe to call Accessibility.getFullAXTree({frameId}).
 *   • cross-origin → SKIPPED entirely; we never issue the CDP call. This
 *     is a defensive measure: on Chromium-derived browsers (incl. QQ
 *     Browser) cross-origin getFullAXTree has been observed to crash the
 *     renderer (Aw-Snap, STATUS_ACCESS_VIOLATION / error 5) rather than
 *     rejecting the request. The placeholder leaves the iframe visible in
 *     the snapshot but unwalked.
 */
async function graftChildFrames(ctx, parentTree, childFrames, depth, parentUrl) {
  if (depth > MAX_FRAME_DEPTH) return 0
  let merged = 0

  // Collect all Iframe-role leaves in the parent tree, in the order they
  // appear (DFS). We pair them with childFrames by index — CDP returns them
  // in document order, so they line up.
  const iframeLeaves = []
  collectFrameLeaves(parentTree, iframeLeaves)

  for (let i = 0; i < childFrames.length; i++) {
    const child = childFrames[i]
    const frameId = child.frame?.id
    const childUrl = child.frame?.url ?? null
    const target = iframeLeaves[i] ?? null
    const sameOrigin = isSameOrigin(parentUrl, childUrl)

    let childCompact = null
    let frameError = null

    if (!sameOrigin) {
      // Cross-origin — DO NOT issue getFullAXTree. Just record a placeholder.
      frameError = new Error('cross-origin (not walked)')
    } else {
      try {
        if (!frameId) throw new Error('missing frameId')
        if (ctx.remaining <= 0) throw new Error('node budget exhausted')
        const { nodes } = await sendDebugger(
          ctx.tabId, 'Accessibility.getFullAXTree', { frameId }
        )
        childCompact = compactAxNodes(nodes, ctx)
      } catch (e) {
        frameError = e
      }
    }

    if (target) {
      if (childCompact && childCompact.tree.length > 0) {
        // Graft: append the child frame's roots as children of the iframe.
        target.children = (target.children ?? []).concat(childCompact.tree)
        merged++
      } else {
        // Cross-origin or otherwise inaccessible: leave a marker.
        target.children = (target.children ?? []).concat([{
          role: 'frame',
          name: '(unavailable)',
          frameId: frameId ?? null,
          url: childUrl ?? undefined,
          ...(frameError ? { error: truncateMsg(frameError.message) } : {}),
        }])
      }
    }

    // Recurse into grandchildren only when we successfully walked this level
    // AND the result was same-origin (so the grandchild origin check has a
    // meaningful parentUrl). If we couldn't graft, the child URL is the
    // correct parent for any nested frames.
    if (child.childFrames?.length && depth < MAX_FRAME_DEPTH) {
      if (childCompact && childCompact.tree.length > 0) {
        merged += await graftChildFrames(
          ctx, childCompact.tree, child.childFrames, depth + 1, childUrl
        )
      }
    }
  }
  return merged
}

function collectFrameLeaves(treeOrArray, out) {
  const arr = Array.isArray(treeOrArray) ? treeOrArray : [treeOrArray]
  for (const n of arr) {
    if (!n || typeof n !== 'object') continue
    if (FRAME_ROLES.has(n.role)) out.push(n)
    if (n.children?.length) collectFrameLeaves(n.children, out)
  }
}

// ── AX-tree compaction (per-frame) ────────────────────────────────────────────

/**
 * Take CDP AXNode[] and produce a folded, named-and-numbered tree.
 * Honors the shared `ctx` — counter, refTable, remaining (maxNodes), truncated.
 *
 * Exported as `compactAXTree` for backward compatibility.
 *
 * CDP AXNode shape (relevant fields):
 *   { nodeId, parentId, childIds:[], backendDOMNodeId,
 *     role:{value}, name:{value}, value:{value},
 *     properties:[{name, value:{value}}], ignored }
 */
function compactAxNodes(axNodes, ctx) {
  const byId = new Map()
  for (const n of axNodes) byId.set(n.nodeId, n)

  let root = axNodes.find((n) => !n.parentId || !byId.has(n.parentId))
  if (!root) root = axNodes[0]

  function refOf() {
    return 'n' + (ctx.counter++).toString(36)
  }

  function shouldKeep(role, name, value) {
    if (INTERACTIVE_ROLES.has(role)) return true
    if (FRAME_ROLES.has(role)) return true
    if (INFORMATIVE_ROLES.has(role) && (name || value)) return true
    if (STRUCTURAL_NOISE_ROLES.has(role)) return false
    return Boolean(name)
  }

  let nodeCount = 0

  function visit(node) {
    if (ctx.remaining <= 0) { ctx.truncated = true; return null }
    if (!node || node.ignored) {
      const out = []
      for (const cid of node?.childIds ?? []) {
        const c = visit(byId.get(cid))
        if (Array.isArray(c)) out.push(...c)
        else if (c) out.push(c)
      }
      return out.length ? out : null
    }

    const role = node.role?.value ?? 'unknown'
    const rawName = node.name?.value
    const rawValue = node.value?.value
    const name = trim(rawName, MAX_NAME_LEN)
    const value = trim(rawValue, MAX_VALUE_LEN)

    if (!shouldKeep(role, name, value)) {
      const out = []
      for (const cid of node.childIds ?? []) {
        const c = visit(byId.get(cid))
        if (Array.isArray(c)) out.push(...c)
        else if (c) out.push(c)
      }
      return out.length ? out : null
    }

    ctx.remaining--
    nodeCount++

    /** @type {any} */
    const out = { role }
    if (name) out.name = name
    if (value) out.value = value
    if (role === 'heading') {
      const level = readProp(node, 'level')
      if (level != null) out.level = Number(level)
    }
    if (readProp(node, 'disabled') === true) out.disabled = true
    if (readProp(node, 'checked') != null) out.checked = readProp(node, 'checked')
    if (readProp(node, 'expanded') != null) out.expanded = readProp(node, 'expanded')
    const url = readProp(node, 'url')
    if (url) out.url = url

    if (INTERACTIVE_ROLES.has(role)) {
      const ref = refOf()
      out.nodeRef = ref
      ctx.refTable[ref] = {
        axId: node.nodeId,
        backendDOMNodeId: node.backendDOMNodeId,
      }
    }

    const children = []
    for (const cid of node.childIds ?? []) {
      const c = visit(byId.get(cid))
      if (Array.isArray(c)) children.push(...c)
      else if (c) children.push(c)
    }
    if (children.length) out.children = children
    return out
  }

  const tree = visit(root) ?? []
  return {
    tree: Array.isArray(tree) ? tree : [tree],
    nodeCount,
  }
}

/**
 * Backwards-compatible export — the previous public signature.
 * Takes raw CDP AXNode[] and returns { tree, nodeCount, truncated, refTable }.
 */
export function compactAXTree(axNodes, { maxNodes }) {
  const ctx = { tabId: null, counter: 0, refTable: {}, remaining: maxNodes, truncated: false }
  const r = compactAxNodes(axNodes, ctx)
  return {
    tree: r.tree,
    nodeCount: r.nodeCount,
    truncated: ctx.truncated,
    refTable: ctx.refTable,
  }
}

// ── DOM-mode driver ───────────────────────────────────────────────────────────

async function runDomSnapshot(ctx) {
  const { tabId } = ctx

  // Pull the whole DOM in one shot — CDP supports depth:-1 + pierce:true to
  // include shadow roots and same-origin iframes.
  const { root } = await sendDebugger(tabId, 'DOM.getDocument', {
    depth: -1,
    pierce: true,
  })

  const tree = await walkDomNode(ctx, root)
  // root is a #document — its children carry the actual <html>. Flatten if
  // we got a single document wrapper.
  let flattened = tree
  if (Array.isArray(flattened) && flattened.length === 1 && flattened[0].role === 'document') {
    flattened = flattened[0].children ?? []
  } else if (!Array.isArray(flattened) && flattened?.role === 'document') {
    flattened = flattened.children ?? []
  }
  const result = Array.isArray(flattened) ? flattened : [flattened].filter(Boolean)

  // Count nodes in the final tree for the response (recursive).
  const nodeCount = countNodes(result)

  return {
    tree: result,
    nodeCount,
    frames: 0,
  }
}

async function walkDomNode(ctx, node) {
  if (!node || ctx.remaining <= 0) {
    if (node && ctx.remaining <= 0) ctx.truncated = true
    return null
  }

  const nodeType = node.nodeType

  // Document-ish nodes — descend straight into their children.
  if (nodeType === NODE_TYPE_DOCUMENT || nodeType === NODE_TYPE_DOCUMENT_FRAGMENT) {
    const children = await walkChildren(ctx, node)
    return {
      role: 'document',
      ...(children.length ? { children } : {}),
    }
  }

  // Text nodes are folded into their parent's `name` field, not emitted on
  // their own. Skip here.
  if (nodeType === NODE_TYPE_TEXT) return null

  // Anything else we don't understand (comment, processing instruction, etc.)
  // — skip.
  if (nodeType !== NODE_TYPE_ELEMENT) return null

  const tag = (node.localName || node.nodeName || '').toLowerCase()
  if (DOM_SKIP_TAGS.has(tag)) return null

  const attrs = attrMap(node.attributes)

  // Compute "name" — prefer aria-label, then aria-labelledby (we can't
  // dereference labelledby cheaply without extra calls; treat its raw value
  // as a hint), then leaf text content.
  let name = attrs['aria-label']
  if (!name && attrs['aria-labelledby']) name = `(labelledby:${attrs['aria-labelledby']})`

  // Recurse into children before deciding leaf-ness.
  ctx.remaining--
  const children = await walkChildren(ctx, node)

  if (!name) {
    // Only fold text into name if every child is text-only (no element kids).
    const hasElementKid = children.length > 0
    if (!hasElementKid) {
      const txt = collectLeafText(node)
      if (txt) name = txt.slice(0, 80)
    }
  }

  /** @type {any} */
  const out = { role: tag }
  if (name) out.name = trim(name, MAX_NAME_LEN)
  const val = attrs['value']
  if (val != null) out.value = trim(val, MAX_VALUE_LEN)
  if (attrs.id) out.id = attrs.id
  if (attrs.class) out.className = trim(attrs.class, 120)
  if (attrs.href) out.href = trim(attrs.href, 200)
  if (attrs.role) out.ariaRole = attrs.role
  if (attrs.type) out.type = attrs.type
  if (attrs.placeholder) out.placeholder = trim(attrs.placeholder, 120)

  // Every emitted DOM node gets a stable nodeRef — click/type need to be able
  // to address any node the snapshot exposed, regardless of mode.
  const ref = 'n' + (ctx.counter++).toString(36)
  out.nodeRef = ref
  ctx.refTable[ref] = {
    // DOM-mode: store CDP nodeId AND backendNodeId. interact.js prefers
    // backendDOMNodeId via DOM.resolveNode; we get backendNodeId straight
    // from DOM.getDocument.
    axId: null,
    backendDOMNodeId: node.backendNodeId,
    domNodeId: node.nodeId,
  }

  // Only call getBoxModel for interactive-ish nodes — it's expensive and
  // can throw for offscreen elements. Best-effort only.
  // Defensive: skip the call entirely if backendNodeId is missing/zero. On
  // some Chromium-derived browsers, getBoxModel against a stale or detached
  // node can crash the renderer rather than rejecting cleanly.
  const isInteractive = DOM_INTERACTIVE_TAGS.has(tag) || Boolean(attrs.role)
  if (isInteractive && node.backendNodeId) {
    try {
      const bb = await sendDebugger(ctx.tabId, 'DOM.getBoxModel', {
        backendNodeId: node.backendNodeId,
      })
      const m = bb?.model
      if (m && Number.isFinite(m.width) && Number.isFinite(m.height) && m.width > 0 && m.height > 0) {
        // m.content is [x1,y1, x2,y1, x2,y2, x1,y2]
        const c = m.content
        if (Array.isArray(c) && c.length >= 8 &&
            c.every((n) => Number.isFinite(n))) {
          out.bbox = {
            x: c[0], y: c[1],
            w: m.width, h: m.height,
          }
        }
      }
    } catch {
      // offscreen / non-rendered / detached — skip bbox quietly
    }
  }

  if (children.length) out.children = children
  return out
}

async function walkChildren(ctx, node) {
  const out = []
  // node.children is what we get from DOM.getDocument with depth:-1.
  // For elements that contain shadow roots, CDP exposes shadowRoots[].
  const kids = []
  if (Array.isArray(node.children)) kids.push(...node.children)
  if (Array.isArray(node.shadowRoots)) kids.push(...node.shadowRoots)
  if (node.contentDocument) kids.push(node.contentDocument)

  for (const k of kids) {
    if (ctx.remaining <= 0) { ctx.truncated = true; break }
    const c = await walkDomNode(ctx, k)
    if (Array.isArray(c)) out.push(...c)
    else if (c) out.push(c)
  }
  return out
}

function attrMap(attrArr) {
  const out = {}
  if (!Array.isArray(attrArr)) return out
  for (let i = 0; i < attrArr.length; i += 2) {
    out[attrArr[i]] = attrArr[i + 1]
  }
  return out
}

function collectLeafText(node) {
  if (!node) return ''
  if (!Array.isArray(node.children)) return (node.nodeValue ?? '').trim()
  const parts = []
  for (const c of node.children) {
    if (c.nodeType === NODE_TYPE_TEXT && c.nodeValue) parts.push(c.nodeValue)
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}

function countNodes(arr) {
  let n = 0
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return }
    if (!x || typeof x !== 'object') return
    n++
    if (x.children) walk(x.children)
  }
  walk(arr)
  return n
}

function countNamed(treeOrArray) {
  let n = 0
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return }
    if (!x || typeof x !== 'object') return
    if (x.name) n++
    if (x.children) walk(x.children)
  }
  walk(treeOrArray)
  return n
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readProp(node, name) {
  for (const p of node.properties ?? []) {
    if (p.name === name) return p.value?.value
  }
  return undefined
}

function trim(s, n) {
  if (s == null) return undefined
  const t = String(s).replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > n ? t.slice(0, n) + '…' : t
}

function truncateMsg(s) {
  if (!s) return ''
  return String(s).length > 120 ? String(s).slice(0, 120) + '…' : String(s)
}

function hashEtag(obj) {
  const s = JSON.stringify(obj)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(36)
}
