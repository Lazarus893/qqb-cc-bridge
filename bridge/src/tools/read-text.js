// qqb.read_text — extract reader-mode-style text from a page.
// Cheaper than full AX snapshot when CC just needs to read article body.

export const readText = {
  name: 'qqb.read_text',
  description:
    'Extract the main readable text content of a tab (article body, not nav/footer). Cheaper than qqb.snapshot when you only need to read content and won\'t interact. Returns {tabId, url, title, text, wordCount}.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      selector: { type: 'string', description: 'Optional CSS selector to scope extraction. Default = whole document.' },
    },
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    return hub.request('read_text', {
      tabId: args.tabId,
      selector: args.selector,
    })
  },
}
