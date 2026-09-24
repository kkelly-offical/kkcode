import path from 'node:path'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { userRootDir } from '../../storage/paths.mjs'
import { writePrivateFile } from '../../storage/private-file.mjs'
import { createLanguageService, isLspService, LSP_LANGUAGES } from '../lsp/service.mjs'
import { createOfficeService, isOfficeService } from '../office/service.mjs'
import { isNpmEnvironment } from '../dependencies/npm-environment.mjs'

const location = () => path.join(userRootDir(), 'host-services.json')
const fail = message => { throw Object.assign(new Error(message), { code: 'host_services_config' }) }
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('宿主服务配置包含不支持的字段。不能设置环境变量、凭据或宿主执行模式。')
}
const image = value => {
  if (typeof value !== 'string' || !/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64})$/.test(value)) fail('服务镜像必须为本机已有的不可变摘要，不能使用浮动标签或自动安装。')
  return value
}
export function normalizeHostServices(value) {
  object(value, ['schemaVersion', 'office', 'lsp'])
  if (value.schemaVersion !== 1) fail('不支持的宿主服务配置版本。')
  const output = { schemaVersion: 1 }
  if (value.office !== undefined) { object(value.office, ['image']); output.office = { image: image(value.office.image) } }
  if (value.lsp !== undefined) {
    object(value.lsp, ['image', 'servers'])
    object(value.lsp.servers, LSP_LANGUAGES)
    const servers = {}
    for (const [language, raw] of Object.entries(value.lsp.servers)) {
      const server = /** @type {any} */ (raw)
      object(server, ['command', 'args', 'initializationOptions'])
      if (typeof server.command !== 'string' || !path.posix.isAbsolute(server.command) || /[\x00-\x1f\x7f]/.test(server.command) || /^(?:npm|npx|pnpm|yarn|bunx)(?:\.cmd|\.exe)?$/i.test(path.posix.basename(server.command))) fail('语言服务器必须是镜像内已安装的绝对程序路径，不允许动态包下载。')
      const args = server.args || [], options = server.initializationOptions || {}
      if (!Array.isArray(args) || args.length > 40 || args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')) || !options || typeof options !== 'object' || Array.isArray(options) || JSON.stringify(options).length > 32768) fail('语言服务器参数或初始化选项无效。')
      servers[language] = { command: server.command, args: [...args], initializationOptions: structuredClone(options) }
    }
    if (!Object.keys(servers).length) fail('至少明确配置一个语言服务器。')
    output.lsp = { image: image(value.lsp.image), servers }
  }
  return output
}
export function hostServicesHash(configuration) { return createHash('sha256').update(JSON.stringify(normalizeHostServices(configuration))).digest('hex') }
export async function readHostServicesFile(file, { privateFile = false } = {}) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || privateFile && process.platform !== 'win32' && (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid())) fail('服务配置必须为不超过64 KiB的普通文件；已保存配置必须仅当前账号可读。')
    const chunks = []; let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 8192 })) {
      size += chunk.length
      if (size > 65536) fail('服务配置在读取期间超过大小限制。')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks, size), after = await handle.stat()
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || size !== stat.size) fail('服务配置在读取期间发生变化，请重新检查。')
    let value
    try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('服务配置不是有效 JSON；未输出可能包含私密数据的原文。') }
    return normalizeHostServices(value)
  } finally { await handle.close() }
}
export async function readHostServices() {
  try { return await readHostServicesFile(location(), { privateFile: true }) }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1 }; throw error }
}
export async function configureHostServices(configuration, confirmedHash) {
  const normalized = normalizeHostServices(configuration), hash = hostServicesHash(normalized)
  if (confirmedHash !== hash) fail(`请核查固定镜像和启动程序后，使用 --confirm-hash ${hash} 确认。`)
  await writePrivateFile(location(), JSON.stringify(normalized))
  return { saved: true, configuration: normalized, hash, note: '新会话或重启设备服务后生效。只启用离线隔离服务，不授权工具越过会话/任务权限。' }
}

/** Branded instances only. Private host configuration is never merged from a
 * workspace, a model tool argument, a remote settings request or a task result. */
export async function createHostServices(cwd, injected, { dependencyEnvironment = null } = {}) {
  if (dependencyEnvironment && !isNpmEnvironment(dependencyEnvironment)) fail('依赖环境必须由宿主正式 SDK 准备或验证恢复，不能从项目 JSON 注入。')
  const services = /** @type {{lsp?: import('../../sdk/lsp.mjs').LanguageService, office?: import('../../sdk/office.mjs').OfficeService}} */ ({}), owned = [], diagnostics = []
  if (injected !== undefined) {
    object(injected, ['lsp', 'office'])
    if (injected.lsp && !isLspService(injected.lsp) || injected.office && !isOfficeService(injected.office)) fail('宿主服务必须由正式 SDK 工厂创建，不能传入仿造的普通对象。')
    Object.assign(services, injected)
  } else {
    let configuration
    try { configuration = await readHostServices() } catch (error) { diagnostics.push({ service: 'configuration', available: false, code: error.code || 'host_services_config', message: '宿主服务配置无法可靠读取；Office/LSP未启用，普通会话仍可使用。' }); configuration = { schemaVersion: 1 } }
    for (const kind of ['lsp', 'office']) {
      if (!configuration[kind]) continue
      try {
        const instance = kind === 'lsp'
          ? await createLanguageService({ ...configuration.lsp, cwd, mode: 'strict', dependencyEnvironment, authorizeStart: () => true })
          : await createOfficeService({ ...configuration.office, cwd })
        services[kind] = instance; owned.push(instance)
        diagnostics.push({ service: kind, available: true, mode: 'strict', readiness: 'configured-not-probed' })
      } catch (error) { diagnostics.push({ service: kind, available: false, code: error.code || 'host_service_unavailable', message: '隔离服务初始化失败；未退回宿主执行。请检查固定镜像和工作目录。' }) }
    }
  }
  return { services: Object.freeze(services), diagnostics: Object.freeze(diagnostics), async close() { await Promise.allSettled(owned.map(service => service.dispose?.() ?? service.close?.())) } }
}
