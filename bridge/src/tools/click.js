// qqb.click — click a node by nodeRef from a recent snapshot.

export const click = {
  name: 'qqb.click',
  description:
    'Click an element identified by nodeRef from a recent qqb.snapshot. Uses CDP Input.dispatchMouseEvent for fidelity. Returns {ok, navigated, newUrl?}. After this call, re-snapshot before doing anything else — the tree may have changed.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      nodeRef: { type: 'string', description: 'Reference from a recent qqb.snapshot, e.g. "n10".' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      clickCount: { type: 'number', default: 1 },
    },
    required: ['nodeRef'],
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    return hub.request('click', {
      tabId: args.tabId,
      nodeRef: args.nodeRef,
      button: args.button ?? 'left',
      clickCount: args.clickCount ?? 1,
    })
  },
}
