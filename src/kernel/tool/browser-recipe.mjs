import { createScopedBrowserRecipeStore } from '../browser/recipes.mjs'

const calls = new WeakSet()
export function markBrowserRecipeCall(call) {
  if (typeof call !== 'function') throw new Error('Recipe 需要宿主受控叶工具接口。')
  calls.add(call); return call
}
export const isBrowserRecipeCall = call => typeof call === 'function' && calls.has(call)

/** Fixed DSL composites, not generated executable plugins. No model path,
 * account, recorder, approval or fixture callback parameters exist here. */
export function createBrowserRecipeTools(browser) {
  return [{
    name: 'browser_recipe',
    description: 'List enabled recipes in the current account and workspace, or run one exact approved hash. Requires an already-open matching Browser page. Every finite Browser action goes through normal tool permissions, agent/Skill restrictions, durable execution and site checks again. Cannot record, approve, validate, enable, choose another account, grant a new origin or run generated code.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'run'] },
      id: { type: 'string', pattern: '^recipe_[a-f0-9-]{36}$' },
      hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      parameters: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 4096 } }
    }, required: ['action'], additionalProperties: false },
    capabilityFor: () => 'read',
    async execute(args, ctx) {
      if (args.action === 'list') {
        const store = await createScopedBrowserRecipeStore({ cwd: ctx.cwd }), listed = []
        for (const entry of await store.list()) if (entry.state === 'enabled') {
          const record = await store.get(entry)
          if (record.state !== 'enabled' || record.hash !== entry.hash) continue
          listed.push({ id: record.id, hash: record.hash, origin: record.candidate.origin, steps: record.candidate.steps, parameters: record.candidate.parameters })
        }
        return { output: JSON.stringify({ recipes: listed, note: 'Only previously user-approved and independently validated recipes in this account/workspace are shown.' }) }
      }
      if (args.action !== 'run' || !isBrowserRecipeCall(ctx.runBrowserRecipeCall)) throw Object.assign(new Error('Recipe 运行需要真实内核逐叶治理接口，不能使用模型提供的回调。'), { operationNotStarted: true })
      let index = 0, lastOutput = ''
      const store = await createScopedBrowserRecipeStore({ cwd: ctx.cwd, executor: {
        observe: () => browser.observe({ sessionId: ctx.sessionId }),
        execute: async (step, options) => {
          const result = await ctx.runBrowserRecipeCall({ index: index++, args: step, signal: options.signal,
            guard: { origin: options.origin, fingerprint: options.fingerprint, authorize: options.authorize } })
          lastOutput = String(result.output || '').slice(0, Math.min(ctx.toolResultLimit || 16000, 16000))
          if (result.status !== 'completed') throw Object.assign(new Error('受控 Browser 叶动作未完成'), { operationNotStarted: result.operationNotStarted === true, outcomeUnknown: result.outcomeUnknown })
        }
      } })
      try {
        const result = await store.run({ id: args.id, hash: args.hash, parameters: args.parameters || {}, signal: ctx.signal })
        return { output: JSON.stringify({ ...result, note: 'Actions completed; this is not independent proof that the user task/business goal is complete.', lastOutput }), metadata: { browserRecipe: { id: args.id, hash: args.hash, completedSteps: result.completedSteps } } }
      } catch (error) {
        return { status: 'error', output: JSON.stringify({ code: error.code || 'browser_recipe_failed', message: error.message, completedSteps: error.details?.completedSteps || 0, lastOutput }), metadata: { outcomeUnknown: error.details?.outcomeUnknown === true } }
      }
    }
  }]
}
