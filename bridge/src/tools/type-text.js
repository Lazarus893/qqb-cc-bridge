// qqb.type — type text into a focusable input identified by nodeRef.
// Optionally submits afterwards (Enter key).

export const typeText = {
  name: 'qqb.type',
  description:
    'Type text into an input/textarea/contenteditable element. Focuses the element first, optionally clears existing value, types via CDP Input.dispatchKeyEvent, and (optionally) presses Enter to submit. Returns {ok, value}.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      nodeRef: { type: 'string' },
      text: { type: 'string' },
      clear: { type: 'boolean', default: true, description: 'Select-all + delete before typing. Default true.' },
      submit: { type: 'boolean', default: false, description: 'Press Enter after typing.' },
    },
    required: ['nodeRef', 'text'],
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    return hub.request('type', {
      tabId: args.tabId,
      nodeRef: args.nodeRef,
      text: args.text,
      clear: args.clear ?? true,
      submit: args.submit ?? false,
    })
  },
}
