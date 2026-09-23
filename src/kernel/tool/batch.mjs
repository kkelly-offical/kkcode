/** Declarative composition, not a JavaScript runtime or a permission shortcut. */
export function createToolBatch() {
  return {
    name: 'tool_batch',
    description: 'Run 1–8 explicit tool operations in order through normal approvals, schemas, skill/agent limits and audit. Stops at the first failure. No nested batches, delegation or background launch. Not atomic; completed operations are not rolled back.',
    inputSchema: { type: 'object', properties: {
      calls: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 128 }, args: { type: 'object' } }, required: ['name', 'args'], additionalProperties: false } }
    }, required: ['calls'], additionalProperties: false },
    capabilityFor: () => 'read',
    async execute(args, ctx) {
      if (typeof ctx.runToolBatch !== 'function') throw new Error('Tool composition requires a governed turn runtime')
      if (!Array.isArray(args.calls) || !args.calls.length || args.calls.length > 8) throw new Error('Use 1–8 explicit operations')
      if (args.calls.some(call => ['tool_batch', 'task', 'task_group', 'task_parallel', 'enter_plan', 'exit_plan', 'skill'].includes(call.name))) throw new Error('Nested composition, mode changes, skill activation and delegation must be separate calls')
      return ctx.runToolBatch(args.calls)
    }
  }
}
