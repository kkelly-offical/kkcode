import path from 'node:path'
import { mkdir, writeFile, lstat } from 'node:fs/promises'
import { loadConfig } from '../../src/config/load-config.mjs'
import { prepareBudgetProfile } from '../../src/usage/budget-profiles.mjs'
import { createLocalFreeInferenceAuthorization } from '../../src/usage/local-free.mjs'
import { allocateLocalFreeLimits, assertLocalFreeProfile } from './local-free.mjs'

/** Approve exactly one listener before a suite starts. This host capability is
 * reused by all cases; a new task is not permission to bless a new process. */
export async function prepareEvaluationLocalFreeAuthorization({ profile, limits, privateRoot }) {
  assertLocalFreeProfile(profile)
  const allocation = allocateLocalFreeLimits(limits, 1).perTask
  const previousHome = process.env.KKCODE_HOME, home = path.join(privateRoot, 'state')
  await mkdir(home, { recursive: true, mode: 0o700 })
  if ((await lstat(home)).isSymbolicLink()) throw new Error('Suite authorization state cannot be a symlink')
  process.env.KKCODE_HOME = home
  try {
    const prices = path.join(home, 'prices.json')
    await writeFile(prices, JSON.stringify({ currency: 'USD', per_tokens: 1000000, models: { [profile.model]: profile.pricing } }), { flag: 'wx', mode: 0o600 })
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ provider: { default: 'evaluation', evaluation: {
      type: profile.providerType === 'responses' ? 'openai-responses' : profile.providerType, base_url: profile.baseUrl,
      api_key: '', api_key_env: profile.apiKeyEnv || '', default_model: profile.model, context_limit: profile.contextLimit, max_tokens: profile.maxTokens
    } }, usage: { pricing_file: prices }, mcp: { servers: {} }, plugins: { enabled: false }, skills: { enabled: false, auto_seed: false } }), { flag: 'wx', mode: 0o600 })
    const state = await loadConfig(privateRoot)
    if (state.errors?.length || state.config.provider.default !== 'evaluation' || state.config.provider.evaluation.api_key) throw new Error('Suite authorization configuration failed validation')
    return await createLocalFreeInferenceAuthorization({ profile: await prepareBudgetProfile(state, { providerType: 'evaluation', model: profile.model }),
      baseUrl: profile.baseUrl, apiKeyEnv: profile.apiKeyEnv || '', maxRequests: allocation.requestLimit, maxTokens: allocation.tokenLimit,
      authorize: async () => true })
  } finally { if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome }
}
