// qqb.wait_for — wait for a condition.
// Conditions:
//   { type:'idle', ms }                 — page has been quiet for `ms` ms (no DOM mutations)
//   { type:'url-changes', from? }       — current URL differs from `from` (default current url)
//   { type:'url-matches', pattern }     — URL matches regex
//   { type:'selector', selector }       — selector found in DOM
//   { type:'no-selector', selector }    — selector NOT found / removed

export const waitFor = {
  name: 'qqb.wait_for',
  description:
    'Wait for a page condition before returning. Use after click/type that triggers navigation or async UI updates, before re-snapshotting. Returns {ok, elapsedMs}.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      condition: {
        oneOf: [
          { type: 'object', properties: { type: { const: 'idle' }, ms: { type: 'number', default: 500 } }, required: ['type'] },
          { type: 'object', properties: { type: { const: 'url-changes' }, from: { type: 'string' } }, required: ['type'] },
          { type: 'object', properties: { type: { const: 'url-matches' }, pattern: { type: 'string' } }, required: ['type', 'pattern'] },
          { type: 'object', properties: { type: { const: 'selector' }, selector: { type: 'string' } }, required: ['type', 'selector'] },
          { type: 'object', properties: { type: { const: 'no-selector' }, selector: { type: 'string' } }, required: ['type', 'selector'] },
        ],
      },
      timeoutMs: { type: 'number', default: 10_000 },
    },
    required: ['condition'],
    additionalProperties: false,
  },
  async handler({ args, hub }) {
    return hub.request(
      'wait_for',
      {
        tabId: args.tabId,
        condition: args.condition,
        timeoutMs: args.timeoutMs ?? 10_000,
      },
      { timeoutMs: (args.timeoutMs ?? 10_000) + 5_000 }
    )
  },
}
