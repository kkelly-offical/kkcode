import { createHash } from 'node:crypto'

const authorizations = new WeakMap()
const READ_ACTIONS = new Set(['status', 'open', 'new_tab', 'snapshot', 'screenshot', 'diagnostics', 'viewport', 'tabs', 'select_tab', 'close_tab', 'frames', 'dialogs', 'download', 'close'])
const refusal = message => Object.assign(new Error(message), { code: 'browser_action_authorization_invalid', operationNotStarted: true })
function digest(value) {
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export function browserActionNeedsAuthorization(args) {
  return args?.development === true || args?.dialog_response?.accept === true || !READ_ACTIONS.has(args?.action)
}
/** Host-only one-shot capability. Do not construct this from model/RPC JSON.
 * The verify callback must recheck the durable owner and consumed scoped grant. */
export function createBrowserActionAuthorization({ sessionId, args, taskId, actor, observation, verify }) {
  if (!sessionId || !taskId || !actor || typeof verify !== 'function' || !observation?.origin || !observation?.fingerprint) throw refusal('浏览器动作授权缺少任务、账号或页面绑定')
  const token = Object.freeze({})
  authorizations.set(token, { sessionId, argsHash: digest(args), observationHash: digest(observation), origin: observation.origin, taskId, actor: digest(actor), verify, consumed: false })
  return token
}
export function isBrowserActionAuthorization(value) { return !!value && authorizations.has(value) }
export async function consumeBrowserActionAuthorization(token, { sessionId, args, observe }) {
  const grant = token && authorizations.get(token)
  if (!grant || grant.consumed || grant.sessionId !== sessionId || grant.argsHash !== digest(args) || typeof observe !== 'function') throw refusal('浏览器敏感动作需要当前任务针对本次参数的单次宿主授权')
  // Reserve before awaiting; parallel attempts cannot both consume a token.
  grant.consumed = true
  const assertCurrent = async () => { if (await grant.verify() !== true) throw refusal('浏览器动作授权已撤销、过期或任务所有权已变化') }
  await assertCurrent()
  if (digest(await observe()) !== grant.observationHash) throw refusal('浏览器页面、标签页或框架在批准后已变化；本次动作未派发，请重新审查')
  await assertCurrent()
  return { assertCurrent, origin: grant.origin }
}
