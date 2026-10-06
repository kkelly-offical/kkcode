import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import YAML from 'yaml'
import { loadConfig } from '../config/load-config.mjs'
import { updateDeviceSettings } from './model-settings.mjs'
import { resolveManagedMcpConfig, managedMcpStore, installRemotePlugin, managePlugin } from '../kernel/index.mjs'
import { userRootDir } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { ProtocolError } from '../protocol/index.mjs'

const fail = (message, code = 'extension_input') => { throw new ProtocolError(code, message, 422) }
const nameOf = name => { if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name) || ['constructor', 'prototype'].includes(name)) fail('名称只允许字母、数字、下划线和短横线。'); return name }
const mcpNameOf = name => { if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) fail('MCP 名称无效。'); return name }
const fields = (rows, old = {}) => {
  if (!Array.isArray(rows) || rows.length > 64) fail('配置字段过多。')
  return Object.fromEntries(rows.map(row => {
    if (!row || typeof row.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(row.key) || ['__proto__', 'constructor', 'prototype'].includes(row.key)) fail('字段名称无效。')
    if (typeof row.value !== 'string' || row.value.length > 16384 || /[\r\n\0]/.test(row.value)) fail('字段值无效。')
    return [row.key, row.value || old[row.key] || '']
  }))
}
function publicConnection(name, config, health) {
  let endpoint = ''
  if (config.url) { try { const u = new URL(config.url); endpoint = u.origin } catch {} }
  return { ...health, name, transport: config.transport || config.type || 'stdio', endpoint, command: Array.isArray(config.command) ? config.command[0] : config.command || '', args: [],
    enabled: config.enabled !== false, managed: true, configurable: true, envKeys: Object.keys(config.env || {}), headerKeys: Object.keys(config.headers || {}),
    auth: config.oauth ? 'oauth' : 'none', error: health?.error ? '连接未就绪，请检查配置或重新登录。' : null }
}
export class DeviceExtensions {
  constructor(service) { this.service = service; this.auth = new Map() }
  close() { for (const flow of this.auth.values()) flow.controller.abort(); this.auth.clear() }
  async catalog(kernel) {
    await kernel.bootExtensions()
    const config = (await loadConfig(this.service.cwd)).config, health = kernel.extensions.mcp.healthSnapshot(), mcp = []
    for (const [name, value] of Object.entries(config.mcp?.servers || {})) mcp.push(publicConnection(name, await resolveManagedMcpConfig(name, value), health.find(item => item.name === name)))
    for (const item of health) if (!mcp.some(row => row.name === item.name)) mcp.push({ ...publicConnection(item.name, kernel.extensions.mcp.connectionConfig(item.name) || {}, item), managed: false })
    return { mcp, skills: kernel.extensions.skills.list().map(({ name, description }) => ({ name, description })), plugins: kernel.extensions.skills.listPluginManifests().map(({ name, description, enabled, version }) => ({ name, description, enabled, version })), device: this.service.metadata.name || this.service.metadata.id }
  }
  async dispatch(method, p, principal) {
    const service = this.service, kernel = await service.kernel(service.cwd)
    if (method === 'extensions.catalog') return this.catalog(kernel)
    if (method.startsWith('extensions.auth.')) return this.authorization(method, p, principal, kernel)
    if (service.workspaceMutation || service.configurationUpdating || service.turns.size || service.commandSessions.size) throw new ProtocolError('configuration_busy', '请等待当前任务结束后再修改连接与扩展。', 409)
    service.configurationUpdating = true
    try {
      const name = p.action?.startsWith('mcp.') ? mcpNameOf(p.name) : nameOf(p.name)
      if (p.action?.startsWith('plugin.') && name !== name.toLowerCase()) fail('插件名称请使用小写字母、数字、短横线或下划线。')
      if (p.action === 'mcp.save') {
        const source = (await loadConfig(service.cwd)).config.mcp?.servers?.[name]
        await kernel.bootExtensions()
        const old = source ? await resolveManagedMcpConfig(name, source) : kernel.extensions.mcp.connectionConfig(name) || {}
        const transport = p.transport || 'streamable-http'
        if (!['stdio', 'streamable-http', 'legacy-sse'].includes(transport)) fail('请选择本机进程、HTTP 或 SSE 连接。')
        const config = { transport, enabled: true, env: fields(p.env || [], old.env), headers: fields(p.headers || [], old.headers) }
        if (transport === 'stdio') {
          if (typeof p.command !== 'string' || !p.command.trim() || p.command.length > 1024 || /[\r\n\0]/.test(p.command)) fail('请选择可执行程序。')
          if (!Array.isArray(p.args) || p.args.length > 64 || p.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) fail('程序参数无效。')
          config.command = p.command; config.args = p.args.length || !source ? p.args : old.args || []
        } else {
          let url
          try { url = new URL(p.url || old.url) } catch { fail('请输入服务的完整地址。') }
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) fail('地址必须是 HTTP(S)，不能包含账号密码或片段。')
          if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('远程服务请使用 HTTPS。')
          config.url = url.href
          if (p.auth === 'oauth') config.oauth = true
        }
        const reference = randomUUID(), store = managedMcpStore(name, reference)
        await store.update(() => ({ config }))
        // Publish only an opaque reference; credentials never enter config views.
        await updateDeviceSettings(service, { mcp: { servers: { [name]: { credential_ref: reference, transport, enabled: true } } } })
        return { saved: true, name }
      }
      if (p.action === 'mcp.toggle') {
        if (typeof p.enabled !== 'boolean') fail('请选择启用或停用。')
        if (!(await loadConfig(service.cwd)).config.mcp?.servers?.[name]) fail('此连接由插件或项目管理，请从其来源修改。')
        await updateDeviceSettings(service, { mcp: { servers: { [name]: { enabled: p.enabled } } } })
        return { saved: true }
      }
      let result
      if (p.action === 'plugin.install') {
        if (typeof p.source !== 'string' || !(p.source.startsWith('npm:') || p.source.startsWith('https://'))) fail('请输入 HTTPS Git 仓库或 npm:包名@版本。')
        if (p.source.startsWith('https://')) {
          let url
          try { url = new URL(p.source) } catch { fail('插件仓库地址无效。') }
          if (url.username || url.password || url.search || url.hash) fail('仓库地址不能包含账号、密钥或查询参数。')
          if (!/^[0-9a-f]{40}$/i.test(p.revision || '')) fail('请填写仓库的完整提交编号，以固定插件版本。')
        }
        result = { ...await installRemotePlugin({ name, source: p.source, revision: p.revision }), source: p.source, revision: p.revision || null }
      } else if (p.action === 'plugin.manage') {
        if (!['inspect', 'enable', 'disable', 'approve', 'remove', 'update'].includes(p.operation)) fail('插件操作无效。')
        result = await managePlugin(name, p.operation, { confirmHash: p.confirmHash })
      } else if (p.action === 'skill.save') {
        if (typeof p.content !== 'string' || Buffer.byteLength(p.content) > 256 * 1024 || !/^---\r?\n/.test(p.content)) fail('请粘贴含名称和描述的完整 SKILL.md，最多 256 KiB。')
        const header = p.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
        let metadata
        try { metadata = header && YAML.parse(header[1], { maxAliasCount: 20 }) } catch { fail('技能头部格式无效。') }
        if (!metadata || metadata.name !== name || typeof metadata.description !== 'string' || !metadata.description.trim()) fail('技能头部的 name 必须与名称一致，并填写 description。')
        // Skill directories have a stricter naming boundary than MCP identifiers
        // (which can include plugin/name). Revalidate at the filesystem boundary.
        const skillName = nameOf(p.name)
        const root = path.join(userRootDir(), 'skills'), directory = path.join(root, path.basename(skillName))
        if (path.dirname(directory) !== path.resolve(root)) fail('技能目录必须直接位于用户技能目录下。')
        await mkdir(root, { recursive: true, mode: 0o700 })
        if ((await lstat(root)).isSymbolicLink()) fail('技能目录不能是符号链接。')
        try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') fail('该技能名称已经存在，请换一个名称，避免覆盖原有技能。'); throw error }
        if ((await lstat(directory)).isSymbolicLink() || path.dirname(await realpath(directory)) !== await realpath(root)) fail('技能目录无效。')
        await writePrivateFile(path.join(directory, 'SKILL.md'), p.content)
        result = { saved: true, name }
      } else fail('不支持此扩展操作。')
      await kernel.extensions.skills.initialize(kernel.extensionPolicy.config, kernel.cwd, { allowProjectSources: kernel.extensionPolicy.allowProjectSources })
      return result
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      // Third-party errors can contain credential-bearing endpoints or headers.
      throw Object.assign(new Error('扩展操作的最终状态尚未确认，请先刷新目录检查结果，再决定是否重试。'), { code: 'extension_outcome_unknown', status: 409 })
    } finally { service.configurationUpdating = false }
  }
  async authorization(method, p, principal, kernel) {
    if (['extensions.auth.start', 'extensions.auth.logout'].includes(method) && (this.service.turns.size || this.service.configurationUpdating || this.service.workspaceMutation)) throw new ProtocolError('configuration_busy', '请等待当前任务结束后再更改登录状态。', 409)
    const owner = principal.client, now = Date.now()
    for (const [id, flow] of this.auth) if (now - flow.startedAt > 300000) { flow.controller.abort(); this.auth.delete(id) }
    if (method === 'extensions.auth.start') {
      const name = mcpNameOf(p.name)
      if (this.auth.size >= 8 || [...this.auth.values()].some(flow => flow.name === name && flow.status === 'pending')) fail('此连接正在授权，请先完成或取消已有登录。')
      await kernel.bootExtensions()
      const id = randomUUID(), flow = { id, name, owner, startedAt: now, status: 'pending', url: null, controller: new AbortController(), complete: null }
      this.auth.set(id, flow)
      void kernel.extensions.mcp.authorize(name, { signal: flow.controller.signal,
        onCallbackReady: ({ complete }) => { flow.complete = complete },
        onAuthorization: value => {
          const url = new URL(value)
          if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Unsafe authorization address')
          flow.url = url.href
        },
      }).then(() => { flow.status = 'authorized'; flow.url = null }, () => { flow.status = flow.controller.signal.aborted ? 'cancelled' : 'failed'; flow.url = null }).finally(() => { flow.complete = null })
      return { id, status: flow.status }
    }
    if (method === 'extensions.auth.logout') { await kernel.bootExtensions(); return kernel.extensions.mcp.clearAuthorization(mcpNameOf(p.name)) }
    const flow = this.auth.get(p.id)
    if (!flow || flow.owner !== owner) throw new ProtocolError('authorization_missing', '登录已过期，请重新发起。', 404)
    if (method === 'extensions.auth.cancel') { flow.controller.abort(); flow.status = 'cancelled'; flow.url = null }
    if (method === 'extensions.auth.complete') {
      if (flow.status !== 'pending' || !flow.complete || typeof p.url !== 'string' || p.url.length > 16384) fail('登录尚未就绪或已经结束。')
      try { flow.complete(p.url) } catch { fail('回调地址不属于这次登录，请粘贴浏览器最后显示的完整地址。') }
    }
    return { id: flow.id, name: flow.name, status: flow.status, url: flow.url }
  }
}
