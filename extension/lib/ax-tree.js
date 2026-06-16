// ax-tree.js — fetch the accessibility tree via CDP, then fold/strip it into a
// shape that's cheap for an LLM to understand.
//
// Compaction rules:
//   • Drop nodes whose role is structural noise (generic, none, presentation,
//     ScrollArea, GenericContainer) UNLESS they have a name worth keeping.
//   • Promote children: if a stripped node has children, hoist them to the
//     parent's children list.
//   • Truncate names/values longer than ~120 chars.
//   • Assign a stable `nodeRef` (n0, n1, …) to every node that survives AND is
//     interactive (button, link, textbox, checkbox, switch, menuitem, tab, …)
//     or is the canonical root anchor (heading levels).
//   • Hard-cap the result at maxNodes (DFS, depth-first), and tell the caller
//     how much was elided.
//
// Returns { tabId, url, title, etag, nodeCount, truncated, tree }.

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

const MAX_NAME_LEN = 200
const MAX_VALUE_LEN = 200

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Snapshot a tab's AX tree.
 * @param {number} tabId
 * @param {{ mode?: 'ax'|'text'|'mixed', maxNodes?: number }} opts
 */
export async function snapshotTab(tabId, opts = {}) {
  const mode = opts.mode ?? 'ax'
  const maxNodes = opts.maxNodes ?? 800

  await ensureAttached(tabId)

  const tab = await chrome.tabs.get(tabId)
  await sendDebugger(tabId, 'Accessibility.enable', {})
  const { nodes } = await sendDebugger(tabId, 'Accessibility.getFullAXTree', {})

  const compact = compactAXTree(nodes, { maxNodes })
  stashRefTable(tabId, compact.refTable)
  return {
    tabId,
    url: tab.url,
    title: tab.title,
    mode,
    etag: hashEtag(compact.tree),
    nodeCount: compact.nodeCount,
    truncated: compact.truncated,
    tree: compact.tree,
  }
}

// ── AX-tree compaction ────────────────────────────────────────────────────────

/**
 * Take CDP AXNode[] and produce a folded, named-and-numbered tree.
 *
 * CDP AXNode shape (relevant fields):
 *   { nodeId, parentId, childIds:[], backendDOMNodeId,
 *     role:{value}, name:{value}, value:{value},
 *     properties:[{name, value:{value}}], ignored }
 */
export function compactAXTree(axNodes, { maxNodes }) {
  // Build id → node map.
  const byId = new Map()
  for (const n of axNodes) byId.set(n.nodeId, n)

  // Find root — the node without a parentId or whose parent is missing.
  let root = axNodes.find((n) => !n.parentId || !byId.has(n.parentId))
  if (!root) root = axNodes[0]

  let counter = 0
  let total = 0
  let truncated = false

  function refOf(n) {
    return 'n' + (counter++).toString(36)
  }

  function shouldKeep(role, name, value) {
    if (INTERACTIVE_ROLES.has(role)) return true
    if (INFORMATIVE_ROLES.has(role) && (name || value)) return true
    if (STRUCTURAL_NOISE_ROLES.has(role)) return false
    return Boolean(name) // unfamiliar role + has a name → keep
  }

  function visit(node) {
    if (total >= maxNodes) { truncated = true; return null }
    if (!node || node.ignored) {
      // descend through ignored
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
      // descend, hoist
      const out = []
      for (const cid of node.childIds ?? []) {
        const c = visit(byId.get(cid))
        if (Array.isArray(c)) out.push(...c)
        else if (c) out.push(c)
      }
      return out.length ? out : null
    }

    total++
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

    if (INTERACTIVE_ROLES.has(role)) out.nodeRef = refOf(node)
    // Stash the AX nodeId for the bridge — we strip it on the way out, but we
    // need a side-table to map nodeRef → AX node so click/type can find the
    // backendDOMNodeId.
    out.__axId = node.nodeId
    out.__backendDOMNodeId = node.backendDOMNodeId

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

  // Strip __axId and __backendDOMNodeId from the public tree, and stash a
  // side-table keyed by nodeRef so interact.js can resolve them.
  const refTable = {}
  function strip(n) {
    if (!n) return n
    if (n.nodeRef) {
      refTable[n.nodeRef] = {
        axId: n.__axId,
        backendDOMNodeId: n.__backendDOMNodeId,
      }
    }
    delete n.__axId
    delete n.__backendDOMNodeId
    if (n.children) n.children.forEach(strip)
    return n
  }
  if (Array.isArray(tree)) tree.forEach(strip)
  else strip(tree)

  // Cache the ref table on globalThis keyed by tabId (set by caller layer).
  // We return it embedded so the caller can stash it.
  return {
    tree: Array.isArray(tree) ? tree : [tree],
    nodeCount: total,
    truncated,
    refTable,
  }
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

function hashEtag(obj) {
  // FNV-1a over JSON — small, fast, no deps.
  const s = JSON.stringify(obj)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(36)
}
