import { loadConfig } from '../../src/config/load-config.mjs'
import { validateConfig } from '../../src/config/schema.mjs'

// Evaluation limits are an explicit host contract, not user model defaults.
// Keep them in memory; ordinary config files no longer carry numeric caps.
export async function loadEvaluationConfig(cwd, profile) {
  const state = await loadConfig(cwd)
  if (state.errors?.length) return state
  for (const config of [state.config, state.userConfig]) {
    if (!config.provider?.evaluation) throw new Error('Evaluation provider is missing')
    Object.assign(config.provider.evaluation, { context_limit: profile.contextLimit, max_tokens: profile.maxTokens })
    if (!validateConfig(config).valid) throw new Error('Evaluation host model limits failed schema validation')
  }
  return state
}
