import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath, lstat, readFile, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveWorkspacePath } from '../tool/workspace-fs.mjs'
import { runStrictCommand } from '../isolation/docker-executor.mjs'
import { readPinnedFile } from '../../util/pinned-io.mjs'

const trustedServices = new WeakSet()
/** Host-only brand used by strict dispatch; a lookalike JSON/object cannot pass. */
export function isLspService(service) { return trustedServices.has(service) }
const MAX_SOURCE = 2 * 1024 * 1024
const MAX_RESULT = 2 * 1024 * 1024
const WORKER = new URL('../../lsp/worker.mjs', import.meta.url)
const PINNED_HELPER = new URL('../../util/pinned-io.mjs', import.meta.url)
const EXTENSIONS = { '.ts': ['typescript', 'typescript'], '.tsx': ['typescript', 'typescriptreact'], '.mts': ['typescript', 'typescript'], '.cts': ['typescript', 'typescript'],
  '.js': ['javascript', 'javascript'], '.jsx': ['javascript', 'javascriptreact'], '.mjs': ['javascript', 'javascript'], '.cjs': ['javascript', 'javascript'],
  '.py': ['python', 'python'], '.pyi': ['python', 'python'], '.go': ['go', 'go'], '.kt': ['kotlin', 'kotlin'], '.kts': ['kotlin', 'kotlin'] }
const PRIVATE = new Set(['.git', '.kkcode', '.ssh', '.gnupg', '.aws', '.azure', '.kube'])
export const LSP_LANGUAGES = Object.freeze(['typescript', 'javascript', 'python', 'go', 'kotlin'])
export class LanguageServiceError extends Error {
  constructor(code, message) { super(message); this.name = 'LanguageServiceError'; this.code = code }
}
const fail = (code, message) => { throw new LanguageServiceError(code, message) }
const hash = value => createHash('sha256').update(value).digest('hex')

function serverConfiguration(input, strict) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['command', 'args', 'initializationOptions'].includes(key)) ||
      typeof input.command !== 'string' || input.command.includes('\0') || !(strict ? path.posix.isAbsolute(input.command) : path.isAbsolute(input.command)) ||
      !Array.isArray(input.args || []) || (input.args || []).length > 40 ||
      (input.args || []).some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) fail('LSP_CONFIG', '语言服务器必须由宿主配置绝对路径和有限 argv，不接受 shell 或自动安装。')
  if (/^(?:npx|npm|pnpm|yarn|bunx)(?:\.cmd|\.exe)?$/i.test(path.basename(input.command))) fail('LSP_CONFIG', '语言服务不允许通过包管理器动态下载或启动。请显式配置已安装程序。')
  const options = input.initializationOptions || {}
  if (typeof options !== 'object' || Array.isArray(options) || Buffer.byteLength(JSON.stringify(options)) > 32 * 1024) fail('LSP_CONFIG', '语言服务初始化选项无效或过大。')
  return Object.freeze({ command: input.command, args: Object.freeze([...(input.args || [])]), initializationOptions: structuredClone(options) })
}

async function sourceFile(cwd, requested, signal) {
  if (typeof requested !== 'string' || requested.includes('\0')) fail('LSP_SCOPE', '请提供工作区中的源码路径。')
  const filename = await resolveWorkspacePath(cwd, requested, { mustExist: true })
  const relative = path.relative(cwd, filename)
  if (relative.split(path.sep).some(part => PRIVATE.has(part.toLowerCase()))) fail('LSP_SCOPE', '语言服务不能查询治理目录或凭据路径。')
  const bytes = await readPinnedFile(cwd, relative.split(path.sep).join('/'), { maxBytes: MAX_SOURCE, signal })
  return { path: relative.split(path.sep).join('/'), text: bytes.toString('utf8'), sha256: hash(bytes) }
}

function relativeSource(cwd, requested) {
  if (typeof requested !== 'string' || /[\0\r\n]/.test(requested)) fail('LSP_SCOPE', '请提供工作区中的源码路径。')
  const relative = path.relative(cwd, path.resolve(cwd, requested))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).some(part => PRIVATE.has(part.toLowerCase()))) fail('LSP_SCOPE', '语言服务文件必须在普通工作区目录内。')
  return relative.split(path.sep).join('/')
}

function hostEnvironment(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL'].includes(key)))
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home }
}

async function runHost(payload, cwd, signal) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kk-lsp-'))
  let child
  try {
    return await new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      child = spawn(process.execPath, [fileURLToPath(WORKER)], { cwd, env: hostEnvironment(scratch), shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', bytes = 0, failure = null
      const kill = () => {
        if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
        else child.kill('SIGKILL')
      }
      const abort = () => { failure = new LanguageServiceError('LSP_CANCELLED', '语言服务查询已取消。'); child.kill('SIGTERM') }
      const timer = setTimeout(() => { failure = new LanguageServiceError('LSP_TIMEOUT', '语言服务超过时限，已停止。'); kill() }, payload.timeoutMs + 2000)
      let abortKill
      const onAbort = () => { abort(); abortKill = setTimeout(kill, 300) }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(payload))
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_RESULT) { failure = new LanguageServiceError('LSP_LIMIT', '语言服务结果超过显示安全上限。'); kill() } else stdout += chunk.toString() })
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_RESULT) { failure = new LanguageServiceError('LSP_LIMIT', '语言服务输出超过安全上限。'); kill() } })
      child.once('error', () => { failure = new LanguageServiceError('LSP_UNAVAILABLE', '语言服务执行进程无法启动。') })
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(abortKill); signal?.removeEventListener('abort', onAbort); kill()
        if (failure) reject(failure)
        else if (code !== 0) reject(new LanguageServiceError('LSP_FAILED', '语言服务执行进程异常退出。'))
        else resolve(stdout)
      })
      if (signal?.aborted) onAbort()
    })
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

function position(value) {
  if (!value || !Number.isSafeInteger(value.line) || value.line < 0 || !Number.isSafeInteger(value.character) || value.character < 0) fail('LSP_POSITION', '位置必须为从零开始的行号和 UTF-16 字符偏移。')
  return { line: value.line, character: value.character }
}
function range(value) {
  const start = position(value?.start), end = position(value?.end)
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) fail('LSP_PROTOCOL', '语言服务返回倒置范围。')
  return { start, end }
}

/** On-demand read-only LSP operations. Host mode is explicitly NOT an OS sandbox.
 * @param {{cwd?: string, servers?: Record<string,any>, mode?: string, image?: string, authorizeStart?: Function, timeoutMs?: number, dependencyEnvironment?: object|null}} [options] */
export async function createLanguageService({ cwd, servers = {}, mode = 'strict', image, authorizeStart, timeoutMs = 30000, dependencyEnvironment = null } = {}) {
  if (!['strict', 'host'].includes(mode) || typeof authorizeStart !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) fail('LSP_CONFIG', '语言服务需要宿主启动授权和有效时限。')
  const workspace = await realpath(cwd)
  const strict = mode === 'strict'
  if (dependencyEnvironment !== null && !strict) fail('LSP_CONFIG', '宿主语言服务不能使用严格任务的私有依赖挂载。')
  if (strict && (typeof image !== 'string' || !/^(?:sha256:[a-f0-9]{64}|[\w./:-]+@sha256:[a-f0-9]{64})$/.test(image))) fail('LSP_ISOLATION_REQUIRED', '严格任务需要已安装的固定隔离镜像；不会回退到宿主启动语言服务器。')
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || Object.keys(servers).some(language => !LSP_LANGUAGES.includes(language))) fail('LSP_CONFIG', '不支持的语言服务器配置。')
  const configured = Object.fromEntries(Object.entries(servers).map(([language, configuration]) => [language, serverConfiguration(configuration, strict)]))
  let closed = false
  const active = new Set()
  /** @param {{operation?: string, path?: string, line?: number, character?: number, signal?: AbortSignal}} [options] */
  async function inspect({ operation, path: requested, line, character, signal } = {}) {
    if (closed) fail('LSP_CLOSED', '语言服务已关闭。')
    if (!['diagnostics', 'symbols', 'definition', 'references'].includes(operation)) fail('LSP_INVALID', '不支持的语言服务操作；此接口不执行重命名或代码编辑。')
    const route = EXTENSIONS[path.extname(String(requested || '')).toLowerCase()]
    if (!route) fail('LSP_UNSUPPORTED', '此文件类型尚未配置语言服务。')
    const [language, languageId] = route
    const configuration = configured[language] || (language === 'javascript' ? configured.typescript : null)
    if (!configuration) fail('LSP_UNAVAILABLE', `${language} 语言服务器未由宿主配置；请使用现有搜索／构建工具，不会自动下载。`)
    // Strict mode never reads user source bytes on the host. The same pinned
    // collector executes inside the read-only container before didOpen.
    const doc = strict ? { path: relativeSource(workspace, requested), text: null, sha256: null } : await sourceFile(workspace, requested, signal)
    const queryPosition = operation === 'definition' || operation === 'references' ? position({ line, character }) : undefined
    if (queryPosition && !strict) {
      const lines = doc.text.split('\n')
      if (queryPosition.line >= lines.length || queryPosition.character > lines[queryPosition.line].replace(/\r$/, '').length) fail('LSP_POSITION', '查询位置超出当前文件。')
    }
    if (!strict) {
      const executable = await realpath(configuration.command).catch(() => null)
      if (!executable || !(await lstat(executable)).isFile()) fail('LSP_UNAVAILABLE', '已配置语言服务器不存在，请由用户安装后指定绝对路径。')
    }
    const fingerprint = hash(JSON.stringify({ workspace, mode, image: image || null, language, ...configuration }))
    if (await authorizeStart(Object.freeze({ workspace, mode, image: image || null, language, command: configuration.command, args: [...configuration.args], fingerprint })) !== true) fail('LSP_APPROVAL_REQUIRED', '当前语言服务器启动尚未获得宿主授权。')
    if (closed) fail('LSP_CLOSED', '语言服务已关闭，未启动新进程。')
    if (active.size >= 2) fail('LSP_BUSY', '当前工作区已有两个语言查询在运行，请等待结果后再查询。')
    const cancellation = new AbortController()
    active.add(cancellation)
    const abort = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal
    try {
      abort.throwIfAborted()
      const payload = { ...configuration, operation, path: doc.path, language: languageId, ...(strict ? { collectSource: true } : { text: doc.text }), position: queryPosition, timeoutMs }
      let output, isolation = null
      if (strict) {
        const helper = `data:text/javascript;base64,${(await readFile(PINNED_HELPER)).toString('base64')}`
        const worker = (await readFile(WORKER, 'utf8')).replace("'../util/pinned-io.mjs'", JSON.stringify(helper))
        const result = await runStrictCommand({ argv: ['node', '--input-type=module', '-e', worker], workspaceDir: workspace, image, dependencyEnvironment,
          stdin: JSON.stringify(payload), readOnly: true, timeoutMs: timeoutMs + 1000, signal: abort, limits: { max_output_bytes: MAX_RESULT } })
        if (result.exitCode !== 0 || result.cancelled || result.timedOut || result.overflow) fail('LSP_FAILED', '隔离语言服务未完整结束，结果不可用。')
        output = result.stdout; isolation = result.isolation
      } else output = await runHost(payload, workspace, abort)
      let reply
      try { reply = JSON.parse(output) } catch { fail('LSP_PROTOCOL', '语言服务没有返回有效回执。') }
      if (reply?.ok !== true) fail(/^LSP_[A-Z_]+$/.test(reply?.code) ? reply.code : 'LSP_FAILED', reply?.message || '语言服务未成功完成。')
      if (strict) {
        if (!/^[a-f0-9]{64}$/.test(reply.sourceHash || '')) fail('LSP_PROTOCOL', '隔离语言服务缺少实际源码校验回执。')
        doc.sha256 = reply.sourceHash
      } else {
        const after = await sourceFile(workspace, requested, abort)
        if (after.sha256 !== doc.sha256) fail('LSP_SOURCE_CHANGED', '查询过程中源码已变化，本次结果已失效，请重新查询。')
      }
      let filtered = 0
      async function location(uri, itemRange) {
        try {
          const url = new URL(uri)
          if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw new Error()
          const requestedPath = strict ? path.posix.relative('/workspace', decodeURIComponent(url.pathname)) : fileURLToPath(url)
          if (strict && (requestedPath === '..' || requestedPath.startsWith('../') || path.posix.isAbsolute(requestedPath))) throw new Error()
          const relative = strict ? relativeSource(workspace, requestedPath) : path.relative(workspace, await resolveWorkspacePath(workspace, requestedPath, { mustExist: true }))
          if (relative.split(path.sep).some(part => PRIVATE.has(part.toLowerCase()))) throw new Error()
          return { path: relative.split(path.sep).join('/'), range: range(itemRange) }
        } catch { filtered++; return null }
      }
      const items = []
      if (operation === 'diagnostics') {
        if (!Array.isArray(reply.result)) fail('LSP_PROTOCOL', '诊断结果不是列表。')
        for (const item of reply.result.slice(0, 1000)) items.push({ path: doc.path, range: range(item.range), severity: item.severity || null, message: String(item.message || '').slice(0, 8192), source: String(item.source || '').slice(0, 120) })
      } else if (operation === 'symbols') {
        async function visit(symbols, depth = 0) {
          if (!Array.isArray(symbols) || depth > 20) return
          for (const item of symbols) {
            if (items.length >= 1000) return
            const place = item.location ? await location(item.location.uri, item.location.range) : { path: doc.path, range: range(item.range) }
            if (place) items.push({ ...place, name: String(item.name || '').slice(0, 512), kind: item.kind || null })
            await visit(item.children, depth + 1)
          }
        }
        if (reply.result !== null && !Array.isArray(reply.result)) fail('LSP_PROTOCOL', '符号结果不是列表。')
        await visit(reply.result || [])
      } else {
        const raw = reply.result == null ? [] : Array.isArray(reply.result) ? reply.result : [reply.result]
        for (const item of raw.slice(0, 1000)) {
          const place = await location(item.uri || item.targetUri, item.range || item.targetSelectionRange || item.targetRange)
          if (place) items.push(place)
        }
      }
      return { operation, language, path: doc.path, sourceHash: doc.sha256, items, filteredLocations: filtered,
        diagnosticMode: reply.diagnosticMode, truncated: items.length >= 1000, readOnlyProtocol: true,
        isolation: isolation ? { backend: isolation.backend, strict: true, network: isolation.network,
          ...(isolation.dependencyEnvironment ? { dependencyEnvironment: {
            id: isolation.dependencyEnvironment.id, planId: isolation.dependencyEnvironment.planId,
            treeHash: isolation.dependencyEnvironment.treeHash, imageId: isolation.dependencyEnvironment.imageId
          } } : {}) } : { backend: 'host', strict: false },
        note: operation === 'diagnostics' ? '语言诊断是当前源码快照的辅助信息，不能替代构建、测试或独立验收。' : undefined }
    } finally { active.delete(cancellation) }
  }
  const service = Object.freeze({ inspect, strict, workspace,
    status: () => ({ mode, configured: Object.keys(configured), running: active.size, closed }),
    close() { closed = true; for (const controller of active) controller.abort(); active.clear() } })
  trustedServices.add(service)
  return service
}

export function createLspTools() {
  return [{
    name: 'lsp', description: 'Read language-server diagnostics, symbols, definitions or references for a current-workspace source file. On demand, host-approved servers only; never installs servers or executes edits. Errors are not evidence of clean code.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['diagnostics', 'symbols', 'definition', 'references'] },
      path: { type: 'string', minLength: 1 }, line: { type: 'integer', minimum: 0 }, character: { type: 'integer', minimum: 0 }
    }, required: ['operation', 'path'], additionalProperties: false }, capabilityFor: () => 'read',
    async execute(args, ctx) {
      if (!trustedServices.has(ctx?.lspService)) fail('LSP_HOST_REQUIRED', '当前会话没有宿主批准的语言服务配置。')
      if (await realpath(ctx.cwd) !== ctx.lspService.workspace) fail('LSP_SCOPE', '语言服务不属于当前工作目录。')
      return { output: JSON.stringify(await ctx.lspService.inspect({ ...args, signal: ctx.signal }), null, 2) }
    }
  }]
}
