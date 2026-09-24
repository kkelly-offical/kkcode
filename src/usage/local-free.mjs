import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile, readlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeBudgetProfile } from '../storage/run-budget-profile.mjs'
import { normalizeLocalFreePolicy, localFreePolicyId } from '../storage/local-free-policy.mjs'
import { routeBudgetScope } from './provider-scope.mjs'

const authorities = new WeakMap(), active = new AsyncLocalStorage(), execute = promisify(execFile)
const fail = message => { throw Object.assign(new Error(message), { code: 'LOCAL_FREE_AUTHORIZATION', operationNotStarted: true }) }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

function endpoint(value) {
  let url
  try { url = new URL(value) } catch { fail('本机免费推理地址无效。') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) fail('免费授权仅接受字面 loopback 地址，不接受 DNS、远端、查询凭据或跳转。')
  return url
}
async function processIdentity(pid, fd) {
  const [stat, status, executable, socket] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8'), readlink(`/proc/${pid}/exe`), readlink(`/proc/${pid}/fd/${fd}`)])
  const startTimeTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]), inode = socket.match(/^socket:\[(\d+)\]$/)?.[1]
  if (!/^\d+$/.test(startTimeTicks || '') || !Number.isSafeInteger(uid) || !inode || (process.getuid?.() !== 0 && uid !== process.getuid?.())) fail('无法确认当前用户有权控制该本机监听进程。')
  return { pid, uid, fd, inode, startTimeTicks, executable }
}
async function listenerFor(baseUrl) {
  if (process.platform !== 'linux') fail('本机免费推理的进程身份核验目前要求 Linux /proc；其他系统不会退回仅信任 URL。')
  const url = endpoint(baseUrl), port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const { stdout } = await execute('ss', ['-H', '-ltnp', `( sport = :${port} )`], { timeout: 5000, maxBuffer: 128 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } })
  const expected = `${url.hostname}:${port}`, matches = []
  for (const line of stdout.split('\n')) {
    if (line.trim().split(/\s+/)[3] !== expected) continue
    for (const item of line.matchAll(/pid=(\d+),fd=(\d+)/g)) matches.push(await processIdentity(Number(item[1]), Number(item[2])))
  }
  if (matches.length !== 1) fail('必须确认唯一的字面 loopback 监听进程；通配绑定、未知拥有者或共享监听不自动授权。')
  return matches[0]
}

/** Host-only capability. The callback is the real approval boundary, not a
 * boolean from a model or a serialized localFreePolicy. No credential is
 * returned or written into the policy; only its route-scoped HMAC is kept. */
export async function createLocalFreeInferenceAuthorization({ profile: supplied, baseUrl, apiKeyEnv = '', maxRequests, maxTokens, authorize, expectedPolicy = null }) {
  const profile = normalizeBudgetProfile(supplied), url = endpoint(baseUrl)
  if (Object.values(profile.rates).some(rate => rate !== 0) || profile.compaction) fail('本机免费授权要求四项完整零单价，且不允许额外原生压缩迭代。')
  if (typeof authorize !== 'function' || apiKeyEnv && (!/^[A-Z][A-Z0-9_]{1,100}$/.test(apiKeyEnv) || !process.env[apiKeyEnv])) fail('本机免费授权需要真实宿主回调和有效凭据环境变量。')
  const credential = apiKeyEnv ? process.env[apiKeyEnv] : ''
  if (routeBudgetScope({ ...profile, baseUrl: url.href, credential }) !== profile.scopeHash) fail('本机授权与冻结模型端点／凭据档案不一致。')
  let listener
  try { listener = await listenerFor(url.href) } catch (error) { if (error.code === 'LOCAL_FREE_AUTHORIZATION') throw error; fail('无法安全核查本机监听进程，未授予免费推理能力。') }
  const body = { version: 1, provider: profile.provider, model: profile.model, protocol: profile.protocol, baseUrl: url.href, scopeHash: profile.scopeHash, maxRequests, maxTokens, listener }
  const policy = freeze(normalizeLocalFreePolicy({ ...body, id: localFreePolicyId(body) }))
  if (expectedPolicy && normalizeLocalFreePolicy(expectedPolicy).id !== policy.id) fail('原免费授权的监听进程、路由或配额已变化；不能把重启视为新额度。')
  if (await authorize(freeze({ kind: 'local-free-inference', policy, profile, apiFeesUsd: 0, concurrency: 1 })) !== true) fail('宿主没有明确批准本机免费推理。')
  if (JSON.stringify(await listenerFor(url.href)) !== JSON.stringify(listener)) fail('授权期间本机监听进程发生变化。')
  const authority = Object.freeze({ kind: 'local-free-inference', id: policy.id })
  authorities.set(authority, { policy, profileId: profile.id })
  return authority
}
export const isLocalFreeInferenceAuthorization = value => authorities.has(value)
export function localFreePolicy(authority) { const entry = authorities.get(authority); if (!entry) fail('本机免费授权不能由 JSON 或普通布尔值构造。'); return entry.policy }
export function validateLocalFreeBudget(authority, { budgetUsd, profiles, expectedPolicy = null }) {
  const policy = localFreePolicy(authority), entry = authorities.get(authority)
  if (budgetUsd !== 0 || profiles.length !== 1 || profiles[0].id !== entry.profileId || Object.values(profiles[0].rates).some(rate => rate !== 0)) fail('免费授权不能用于非零美元预算、其他价格档案或职责模型。')
  if (expectedPolicy && normalizeLocalFreePolicy(expectedPolicy).id !== policy.id) fail('持久免费授权与当前真实宿主能力不一致。')
  return policy
}
export async function withLocalFreeInferenceAuthorization(authority, deadlineAt, operation) {
  localFreePolicy(authority)
  const state = { authority, deadlineAt, closed: false }
  return active.run(state, async () => { try { return await operation() } finally { state.closed = true } })
}
function current() { const state = active.getStore(); return state && !state.closed && Date.now() < state.deadlineAt ? authorities.get(state.authority) : null }
export function localFreeCredentialTransportAllowed({ baseUrl, apiKey = '', providerName }) {
  const entry = current()
  if (!entry) return false
  const policy = entry.policy
  try { return providerName === policy.provider && endpoint(baseUrl).href === policy.baseUrl && routeBudgetScope({ ...policy, baseUrl, credential: apiKey }) === policy.scopeHash } catch { return false }
}
export async function verifyLocalFreeRequest({ provider, model, protocol, baseUrl, credential }) {
  const state = active.getStore()
  if (!state) return
  const entry = current()
  if (!entry) fail('免费推理作用域已结束或过期。')
  const policy = entry.policy
  if (provider !== policy.provider || model !== policy.model || protocol !== policy.protocol || endpoint(baseUrl).href !== policy.baseUrl || routeBudgetScope({ provider, model, protocol, baseUrl, credential }) !== policy.scopeHash) fail('免费推理不能切换模型、凭据、协议或远端路由。')
  try { if (JSON.stringify(await listenerFor(baseUrl)) !== JSON.stringify(policy.listener)) fail('本机监听进程已变化，原免费授权失效。') }
  catch (error) { if (error.code === 'LOCAL_FREE_AUTHORIZATION') throw error; fail('无法复核本机监听进程，未发送推理。') }
}
