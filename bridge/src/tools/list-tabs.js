// qqb.list_tabs — list tabs the extension knows about.
// The extension proactively pushes a "tabs" event whenever the tab set changes,
// so this tool reads from cache without round-tripping.

export const listTabs = {
  name: 'qqb.list_tabs',
  description:
    'List browser tabs the extension is currently tracking. Returns array of {tabId, url, title, active, attached}. The "attached" flag indicates whether chrome.debugger is connected to that tab — only attached tabs accept snapshot/click/type.',
  inputSchema: {
    type: 'object',
    properties: {
      refresh: {
        type: 'boolean',
        description: 'If true, ask the extension for a fresh tab list instead of using the cached push. Default false.',
      },
    },
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    if (args.refresh || (hub.getFacts().tabs?.length ?? 0) === 0) {
      const result = await hub.request('list_tabs', {})
      return result
    }
    return { tabs: hub.getFacts().tabs }
  },
}
