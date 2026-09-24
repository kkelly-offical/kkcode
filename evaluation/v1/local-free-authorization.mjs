import path from 'node:path'
import { mkdir, writeFile, lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { loadConfig } from '../../src/config/load-config.mjs'
import { prepareBudgetProfile } from '../../src/usage/budget-profiles.mjs'
import { createLocalFreeInferenceAuthorization } from '../../src/usage/local-free.mjs'
import { allocateLocalFreeLimits, assertLocalFreeProfile } from './local-free.mjs'
import { normalizeLocalFreePolicy } from '../../src/storage/local-free-policy.mjs'

/** A new batch may receive a smaller allocation, but must not silently approve
 * a replacement listener, credential scope, route, protocol or model. This is
 * metadata comparison, not a substitute for the live host capability check. */
export function localFreeServiceBinding(policy) {
  const { version, provider, model, protocol, baseUrl, scopeHash, listener } = normalizeLocalFreePolicy(policy)
  return { version, provider, model, protocol, baseUrl, scopeHash, listener }
}

export const localFreeServiceBindingHash = policy => createHash('sha256').update(JSON.stringify(localFreeServiceBinding(policy))).digest('hex')

export async function readEvaluationLocalFreeBinding(filename) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > 65536 || process.platform !== 'win32' && (before.mode & 0o077 || process.getuid && before.uid !== process.getuid())) throw new Error('Local-free binding must be a bounded private authorization file')
    const chunks = [], buffer = Buffer.alloc(8192)
    let total = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > 65536) throw new Error('Local-free binding exceeds its size limit')
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    const after = await handle.stat()
    if (before.size !== total || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Local-free binding changed while being read')
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new Error('Local-free binding is not valid authorization JSON') }
    if (value.schema !== 'kk.evaluation.authorization.v1') throw new Error('Not an evaluation authorization receipt')
    return normalizeLocalFreePolicy(value.localFreePolicy)
  } finally { await handle.close() }
}

/** Approve exactly one listener before a suite starts. This host capability is
 * reused by all cases; a new task is not permission to bless a new process. */
export async function prepareEvaluationLocalFreeAuthorization({ profile, limits, privateRoot, expectedPolicy = null }) {
  assertLocalFreeProfile(profile)
  const original = expectedPolicy === null ? null : normalizeLocalFreePolicy(expectedPolicy)
  const expectedBinding = original === null ? null : localFreeServiceBindingHash(original)
  const allocation = allocateLocalFreeLimits(limits, 1).perTask
  if (original && (allocation.requestLimit > original.maxRequests || allocation.tokenLimit > original.maxTokens)) throw new Error('A continued evaluation cannot enlarge the original per-task allocation')
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
      authorize: async ({ policy }) => {
        if (expectedBinding && localFreeServiceBindingHash(policy) !== expectedBinding) throw Object.assign(new Error('The originally approved local-free service binding changed; new listener, credential, route or model approval is required'), { code: 'EVALUATION_LOCAL_SERVICE_CHANGED' })
        return true
      } })
  } finally { if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome }
}
