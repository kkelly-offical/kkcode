import { createHash } from 'node:crypto'
import { boundedSchemaJson } from '../tool/schema-validation.mjs'

export class ForgeError extends Error {
  constructor(code, message, status = null) { super(message); this.name = 'ForgeError'; this.code = code; this.httpStatus = status }
}
export const fail = (code, message, status) => { throw new ForgeError(code, message, status) }
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function bounded(value, name, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r]/.test(value)) fail('FORGE_INVALID', `${name} 格式无效。`)
  return value
}
export function sha(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('FORGE_INVALID', '必须提供完整候选提交 SHA。')
  return value
}
export function branch(value) {
  bounded(value, '分支', 240)
  if (/^[./-]|[./]$|\.\.|@\{|[\s~^:?*\[\\]|\/\/|\.lock(?:\/|$)|\/\./.test(value) || value === '@' || value.startsWith('refs/')) fail('FORGE_INVALID', '分支名称无效，不能使用选项、通配符或完整 ref。')
  return value
}
export function number(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('FORGE_INVALID', 'PR／MR 编号必须为正整数。')
  return value
}
export function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value) }
  return value
}
/** Detach host data without freezing caller-owned objects or invoking getters. */
export function snapshotForgeData(value) {
  try { return deepFreeze(JSON.parse(boundedSchemaJson(value, 2 * 1024 * 1024))) }
  catch { fail('FORGE_INVALID', 'Forge 参数必须为大小受限的 JSON 纯数据，不能包含 Proxy、getter 或循环。') }
}

/** Parse only identity. Never read project configuration or acquire a token here.
 * @param {string} remote @param {{kind?: string, apiBase?: string}} [options] */
export function parseForgeRemote(remote, { kind, apiBase } = {}) {
  bounded(remote, '仓库地址')
  if (/\s/.test(remote)) fail('FORGE_INVALID', '仓库地址不能包含空白字符。')
  let url
  const scp = /^git@([^/:\s]+):([^\s]+)$/.exec(remote)
  try { url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : remote) } catch { fail('FORGE_INVALID', '仓库地址必须为 HTTPS 或 Git SSH 地址。') }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash ||
      (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) fail('FORGE_INVALID', '仓库地址不允许嵌入凭据、查询参数或不受支持的协议。')
  if (url.protocol === 'ssh:' && url.port) fail('FORGE_INVALID', '自定义 SSH 端口需要宿主显式解析仓库身份，不能自动推导 API。')
  kind ||= url.hostname === 'github.com' ? 'github' : url.hostname === 'gitlab.com' ? 'gitlab' : null
  if (!['github', 'gitlab'].includes(kind)) fail('FORGE_INVALID', '自托管仓库需要由宿主明确指定 GitLab／GitHub 类型和 API 地址。')
  const origin = `${url.protocol === 'ssh:' ? 'https:' : url.protocol}//${url.host}`
  let api
  try { api = new URL(apiBase || (kind === 'github' && url.hostname === 'github.com' ? 'https://api.github.com' : `${origin}${kind === 'gitlab' ? '/api/v4' : '/api/v3'}`)) } catch { fail('FORGE_INVALID', 'Forge API 地址无效。') }
  if (!['https:', 'http:'].includes(api.protocol) || api.username || api.password || api.search || api.hash ||
      (api.origin !== origin && !(origin === 'https://github.com' && api.origin === 'https://api.github.com'))) fail('FORGE_INVALID', 'API 必须与已授权仓库同源，不能将宿主令牌转送其他站点。')
  const apiPath = api.pathname.replace(/\/$/, '')
  const mount = kind === 'gitlab' && apiPath.endsWith('/api/v4') ? apiPath.slice(0, -7) : ''
  let project = url.pathname.replace(/^\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '')
  if (mount) {
    if (!url.pathname.startsWith(`${mount}/`)) fail('FORGE_INVALID', '仓库路径与 API 挂载路径不一致。')
    project = project.slice(mount.length)
  }
  const parts = project.split('/')
  if (parts.length < 2 || parts.length > 20 || (kind === 'github' && parts.length !== 2) ||
      parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || ['.', '..'].includes(part))) fail('FORGE_INVALID', '仓库命名空间或项目路径无效。')
  const identity = { kind, origin, project, apiBase: `${api.origin}${apiPath}` }
  return deepFreeze({ ...identity, id: digest(identity), webUrl: `${origin}${mount}/${project}`, remote })
}

export function deliveryContract(input, repository) {
  input = snapshotForgeData(input)
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('FORGE_INVALID', '缺少宿主批准的交付契约。')
  const keys = ['runId', 'repositoryId', 'sourceBranch', 'targetBranch', 'targetSha', 'candidateSha', 'requiredChecks', 'requiredApprovals', 'allowedExternalActions']
  if (Object.keys(input).some(key => !keys.includes(key))) fail('FORGE_INVALID', '交付契约包含未知字段。')
  if (input.repositoryId !== repository.id) fail('FORGE_SCOPE', '仓库身份与批准的交付目标不一致。')
  const result = {
    runId: bounded(input.runId, '任务标识', 160), repositoryId: repository.id,
    sourceBranch: branch(input.sourceBranch), targetBranch: branch(input.targetBranch),
    targetSha: sha(input.targetSha), candidateSha: sha(input.candidateSha),
    requiredChecks: input.requiredChecks || [], requiredApprovals: input.requiredApprovals ?? 1,
    allowedExternalActions: input.allowedExternalActions || []
  }
  if (result.sourceBranch === result.targetBranch) fail('FORGE_SCOPE', '任务分支不能覆盖目标分支。')
  if (!Array.isArray(result.requiredChecks) || result.requiredChecks.length > 100 || result.requiredChecks.some(check =>
    !check || !['check_run', 'status', 'job'].includes(check.kind) || typeof check.name !== 'string' || !check.name.trim() || check.name.length > 200 ||
    (check.appId !== undefined && (!Number.isSafeInteger(check.appId) || check.appId < 1)) ||
    Object.keys(check).some(key => !['kind', 'name', 'appId'].includes(key)))) fail('FORGE_INVALID', '必需 CI 检查定义无效。')
  if (!Number.isSafeInteger(result.requiredApprovals) || result.requiredApprovals < 0 || result.requiredApprovals > 100) fail('FORGE_INVALID', '必需审批数量无效。')
  const actions = ['forge.push', 'forge.draft.create', 'forge.draft.update', 'forge.comment', 'forge.ready']
  if (!Array.isArray(result.allowedExternalActions) || result.allowedExternalActions.some(action => !actions.includes(action))) fail('FORGE_INVALID', '外部动作授权无效，不支持自动合并或修改保护规则。')
  return deepFreeze(structuredClone(result))
}
