// qqb.scroll — scroll viewport or a specific node into view.

export const scroll = {
  name: 'qqb.scroll',
  description:
    'Scroll the page. Either: (a) scroll a specific element into view by nodeRef, or (b) scroll the viewport in a direction by a number of pages.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      nodeRef: { type: 'string', description: 'If set, scroll this element into view.' },
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
      pages: { type: 'number', default: 1, description: 'Used with direction up/down. Default 1 page.' },
    },
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    return hub.request('scroll', {
      tabId: args.tabId,
      nodeRef: args.nodeRef,
      direction: args.direction,
      pages: args.pages ?? 1,
    })
  },
}
