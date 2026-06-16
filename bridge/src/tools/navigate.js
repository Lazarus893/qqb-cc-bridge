// qqb.navigate — drive a tab to a URL and optionally wait for a condition.

export const navigate = {
  name: 'qqb.navigate',
  description:
    'Navigate a tab to a URL. Returns {ok, finalUrl, title}. With waitUntil=load (default) or networkidle, the call only resolves once the page is settled enough to snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      url: { type: 'string' },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        default: 'load',
      },
      newTab: { type: 'boolean', default: false, description: 'Open in a new tab instead of reusing.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    return hub.request('navigate', {
      tabId: args.tabId,
      url: args.url,
      waitUntil: args.waitUntil ?? 'load',
      newTab: args.newTab ?? false,
    })
  },
}
