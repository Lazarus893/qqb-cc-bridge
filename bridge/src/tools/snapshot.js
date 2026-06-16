// qqb.snapshot — fetch the AX-tree snapshot of a tab.
//
// The extension does the heavy lifting:
//   - chrome.debugger.attach (if not already)
//   - Accessibility.enable + Accessibility.getFullAXTree
//   - compactAXTree() to fold/strip noise and assign nodeRefs
//
// We then forward the result to CC. The bridge does NOT post-process the tree
// because CC can read structured JSON/YAML directly.

export const snapshot = {
  name: 'qqb.snapshot',
  description:
    'Read the accessibility tree of a tab. This is the canonical "see what is on the page" tool. Returns {tabId, url, title, etag, nodeCount, tree:[…]} where each node has {role, name?, value?, level?, disabled?, nodeRef?, url?, children?}. Use the nodeRef field with click/type/scroll. Re-snapshot after every interaction — node refs from a previous snapshot may be stale.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab to snapshot. Defaults to the currently active attached tab.' },
      mode: {
        type: 'string',
        enum: ['ax', 'text', 'mixed'],
        default: 'ax',
        description: 'ax = accessibility tree (default, recommended). text = reader-mode text only. mixed = ax + raw text fallback for canvas-heavy nodes.',
      },
      maxNodes: {
        type: 'number',
        default: 800,
        description: 'Hard cap on returned nodes — protect CC context. Default 800.',
      },
    },
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    return hub.request('snapshot', {
      tabId: args.tabId,
      mode: args.mode ?? 'ax',
      maxNodes: args.maxNodes ?? 800,
    })
  },
}
