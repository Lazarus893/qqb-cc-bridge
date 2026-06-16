// qqb.exec_js — escape hatch. Last resort when AX tree + content scripts can't
// answer a question. The Skill explicitly tells CC to avoid this.

export const execJs = {
  name: 'qqb.exec_js',
  description:
    'ESCAPE HATCH — execute a JavaScript expression in the tab and return the result. Prefer qqb.snapshot/read_text first. Only use when the AX tree genuinely cannot express what you need (e.g. computed style, canvas content, internal app state). The expression must be a single expression, not a statement; wrap with `(()=>{ … })()` if you need a block.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      expr: { type: 'string' },
      awaitPromise: { type: 'boolean', default: true },
    },
    required: ['expr'],
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    return hub.request('exec_js', {
      tabId: args.tabId,
      expr: args.expr,
      awaitPromise: args.awaitPromise ?? true,
    })
  },
}
