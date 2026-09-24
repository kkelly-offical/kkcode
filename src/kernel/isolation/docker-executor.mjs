import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { realpath, lstat, readdir, mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { resolveWorkspacePath } from '../tool/workspace-fs.mjs'
import { chromium } from 'playwright-core'
import { effectiveDataPolicy, intersectDataPolicies, normalizeDataPolicy } from '../permission/data-policy.mjs'
import { isToolProgramCall } from '../tool/program.mjs'
import { isBrowserRecipeCall } from '../tool/browser-recipe.mjs'
import { currentDurableRun } from '../orchestration/run-runtime.mjs'
import { prepareNpmWorkspace, resolveNpmEnvironmentMount } from '../dependencies/environment-registry.mjs'

const KNOWN_BUILTINS = new WeakSet()
const ALLOWED = Object.freeze(['bash', 'read', 'write', 'edit', 'patch', 'multiedit', 'list', 'todowrite', 'artifact_read', 'artifact_search', 'tool_program', 'lsp', 'office_capabilities', 'office_inspect', 'office_create', 'office_edit', 'office_render', 'office_pdf', 'office_ocr'])
const NETWORK_TOOLS = Object.freeze(['webfetch', 'websearch', 'codesearch', 'http_request', 'browser', 'browser_recipe'])
const PRIVATE_NAMES = new Set(['.git', '.kkcode', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker', '.npmrc', '.pypirc', '.netrc', '.envrc', '.mcp.json'])
const DEFAULT_LIMITS = Object.freeze({ cpus: 2, memory_mb: 2048, pids: 256, tmp_mb: 512, max_output_bytes: 8 * 1024 * 1024, timeout_ms: 120000 })
const PROFILE_PROBE = `const fs=require('node:fs'),os=require('node:os');const s=fs.readFileSync('/proc/self/status','utf8');if(!/^NoNewPrivs:\\s+1$/m.test(s)||!/^CapEff:\\s+0+$/m.test(s)||!/^Seccomp:\\s+2$/m.test(s))process.exit(21);if(Object.keys(os.networkInterfaces()).some(k=>k!=='lo'))process.exit(22);if(fs.existsSync('/var/run/docker.sock'))process.exit(23);try{fs.writeFileSync('/kkcode-root-probe','x');process.exit(24)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')process.exit(25)};if(process.cwd()!=='/workspace')process.exit(26);`

export function markStrictBuiltinTools(tools) { for (const tool of tools) KNOWN_BUILTINS.add(tool); return tools }
const failure = (message, code = 'strict_isolation_unavailable') => Object.assign(new Error(message), { code, operationNotStarted: code !== 'strict_cleanup_unknown' })
const sensitive = name => PRIVATE_NAMES.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /^(?:id_rsa|id_ed25519|credentials)$/i.test(name)
function abortBeforeStart(signal) {
  try { signal?.throwIfAborted() } catch (error) { error.operationNotStarted = true; throw error }
}

function limitsFor(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const [key, max] of Object.entries({ cpus: 32, memory_mb: 32768, pids: 4096, tmp_mb: 8192, max_output_bytes: 64 * 1024 * 1024, timeout_ms: 3600000 })) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > max) throw failure(`严格隔离资源配置无效：${key}`)
  }
  for (const key of Object.keys(overrides)) if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw failure('严格隔离不接受任意 Docker 参数或环境变量')
  return limits
}

function dockerEnv() {
  return Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'DOCKER_CONFIG'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
}

/** @param {string} command @param {string[]} args
 * @param {{signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, onStdout?: (text:string)=>void, onStderr?: (text:string)=>void, stdin?: string|Buffer|null}} [options] */
function commandProcess(command, args, { signal, timeoutMs = 15000, maxBytes = 1024 * 1024, onStdout, onStderr, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const child = spawn(command, args, { env: dockerEnv(), stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true })
    if (stdin !== null) { child.stdin.on('error', () => {}); child.stdin.end(stdin) }
    let stdout = '', stderr = '', bytes = 0, timedOut = false, cancelled = false, overflow = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    const abort = () => { cancelled = true; child.kill('SIGKILL') }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) { overflow = true; child.kill('SIGKILL'); return }
      stdout += chunk.toString(); try { onStdout?.(chunk.toString()) } catch { /* Observer cannot alter execution. */ }
    })
    child.stderr.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) { overflow = true; child.kill('SIGKILL'); return }
      stderr += chunk.toString(); try { onStderr?.(chunk.toString()) } catch { /* Observer cannot alter execution. */ }
    })
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error) })
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut, cancelled, overflow })
    })
  })
}

async function dockerJson(args) {
  let result
  try { result = await commandProcess('docker', args) } catch { throw failure('本机 Docker 不可用；不会回退到宿主执行') }
  if (result.exitCode !== 0 || result.timedOut || result.overflow) throw failure('Docker 检查失败，请确认本机 Docker 可用；不会回退到宿主执行')
  try { return JSON.parse(result.stdout) } catch { throw failure('Docker 返回了不可识别的检查结果') }
}

/** Local immutable image only: no implicit pull, remote daemon or image volumes. */
/** @param {{image?: string}} [options] */
export async function inspectStrictIsolation({ image } = {}) {
  if (typeof image !== 'string' || !/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64})$/.test(image)) throw failure('严格隔离需要本机已有的固定镜像摘要（sha256 或 repository@sha256），不接受浮动标签')
  const contexts = await dockerJson(['context', 'inspect'])
  const endpoint = contexts[0]?.Endpoints?.docker?.Host || ''
  if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://')) throw failure('严格隔离只支持本机 Docker socket，不允许远程 Docker 上下文')
  const info = await dockerJson(['info', '--format', '{{json .}}'])
  if (info.OSType !== 'linux' || !info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota) throw failure('Docker 未提供 Linux CPU、内存和进程限制，严格任务已停止')
  if (!(info.SecurityOptions || []).some(value => value.includes('seccomp'))) throw failure('Docker 默认 seccomp 不可用，严格任务已停止')
  const images = await dockerJson(['image', 'inspect', image])
  const entry = images[0]
  if (!/^sha256:[a-f0-9]{64}$/.test(entry?.Id || '') || entry.Os !== 'linux' || Object.keys(entry.Config?.Volumes || {}).length) throw failure('严格执行镜像无效，或声明了未经批准的额外挂载')
  return { backend: 'docker', strict: true, network: 'none', imageId: entry.Id, daemonRootless: (info.SecurityOptions || []).some(value => value.includes('rootless')) }
}

async function workspaceInfo(input) {
  try { return await inspectWorkspace(input) } catch (error) { error.operationNotStarted = true; throw error }
}

async function inspectWorkspace(input) {
  if (typeof input !== 'string' || !input.trim()) throw failure('严格执行必须指定独立工作目录')
  const workspace = await realpath(path.resolve(String(input || '')))
  if (workspace === path.parse(workspace).root || workspace === await realpath(os.homedir()) || !((await lstat(workspace)).isDirectory())) throw failure('严格任务必须使用独立工作目录，不能挂载系统根目录或用户主目录')
  if (/[,\r\n\0]/.test(workspace)) throw failure('严格工作目录包含 Docker mount 无法安全表示的字符')
  const masks = []; let visited = 0
  async function walk(dir, relative = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 250000) throw failure('工作目录超过严格安全扫描上限；请缩小任务工作区')
      const target = path.join(dir, entry.name), rel = path.join(relative, entry.name), info = await lstat(target)
      if (info.isSymbolicLink()) {
        await resolveWorkspacePath(workspace, rel, { mustExist: true })
        // Never mount an alias over a sensitive file/directory.
        if (sensitive(entry.name)) throw failure('工作目录包含敏感路径别名，请移除后重试', 'strict_workspace_violation')
        continue
      }
      if (!info.isDirectory() && !info.isFile()) throw failure('工作目录包含 socket、设备或特殊文件，严格任务已拒绝', 'strict_workspace_violation')
      if (info.isFile() && info.nlink > 1) throw failure('工作目录包含硬链接，无法证明它不引用宿主私密文件', 'strict_workspace_violation')
      if (sensitive(entry.name)) {
        if (/[,\r\n\0]/.test(rel)) throw failure('敏感路径无法安全映射到隔离容器')
        masks.push({ relative: rel.split(path.sep).join('/'), directory: info.isDirectory() })
        if (masks.length > 256) throw failure('工作目录中敏感路径过多，请准备不含凭据的任务副本')
        continue
      }
      if (info.isDirectory()) await walk(target, rel)
    }
  }
  await walk(workspace)
  return { workspace, masks, identity: await lstat(workspace) }
}

export function buildStrictDockerArgs({ name, token, imageId, workspace, masks = [], readOnlyMounts = [], transfer = null, transferReadOnly = true, emptyFile, emptyDir, limits = {}, argv, timeoutMs, interactive = false, readOnly = false }) {
  const cap = limitsFor(limits)
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw failure('严格执行必须提供合法 argv')
  const duration = Math.min(timeoutMs || cap.timeout_ms, cap.timeout_ms)
  if (!Number.isFinite(duration) || duration < 1) throw failure('严格执行超时配置无效')
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  const args = ['create', '--name', name, '--label', `io.kkcode.strict=${token}`, '--pull', 'never', '--restart', 'no', '--init',
    '--network', 'none', '--ipc', 'private', '--cgroupns', 'private', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--read-only',
    '--pids-limit', String(cap.pids), '--cpus', String(cap.cpus), '--memory', `${cap.memory_mb}m`, '--memory-swap', `${cap.memory_mb}m`,
    '--ulimit', 'nofile=4096:4096', '--shm-size', '64m', '--log-driver', 'none', '--stop-timeout', '1', '--no-healthcheck',
    '--user', `${uid}:${gid}`, '--workdir', '/workspace', '--tmpfs', `/tmp:rw,nosuid,nodev,size=${cap.tmp_mb}m,mode=1777`,
    '--mount', `type=bind,src=${workspace},dst=/workspace,bind-propagation=rprivate${readOnly ? ',readonly' : ''}`]
  for (const mount of readOnlyMounts) args.push('--mount', `type=bind,src=${mount.source},dst=/workspace/${mount.relative},readonly,bind-propagation=rprivate`)
  for (const mask of masks) args.push('--mount', `type=bind,src=${mask.directory ? emptyDir : emptyFile},dst=/workspace/${mask.relative},readonly,bind-propagation=rprivate`)
  if (transfer) args.push('--mount', `type=bind,src=${transfer.workspace},dst=/transfer,bind-propagation=rprivate${transferReadOnly ? ',readonly' : ''}`)
  if (interactive) args.push('--interactive')
  args.push('--entrypoint', '/usr/bin/env', imageId, '-i', 'HOME=/tmp', 'TMPDIR=/tmp', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'CI=1',
    '/usr/bin/timeout', '--signal=TERM', '--kill-after=2s', `${Math.ceil(duration / 1000)}s`, ...argv)
  return args
}

async function removeOwnedContainer(name, token) {
  const inspected = await commandProcess('docker', ['container', 'inspect', name])
  if (inspected.exitCode !== 0) {
    if (/No such (object|container)/i.test(inspected.stderr)) return
    throw failure('无法确认隔离容器状态，请恢复 Docker 后核查；不会声称任务已清理', 'strict_cleanup_unknown')
  }
  let entry
  try { entry = JSON.parse(inspected.stdout)[0] } catch { throw failure('无法核验隔离容器所有权', 'strict_cleanup_unknown') }
  if (entry.Config?.Labels?.['io.kkcode.strict'] !== token) throw failure('隔离容器所有权不匹配，拒绝删除', 'strict_cleanup_unknown')
  const result = await commandProcess('docker', ['container', 'rm', '--force', name])
  if (result.exitCode !== 0) throw failure('隔离容器停止失败，请检查 Docker；任务结果需要核查', 'strict_cleanup_unknown')
}

/** @param {{command?: string, argv?: string[]|null, workspaceDir?: string, image?: string, signal?: AbortSignal,
 * timeoutMs?: number, limits?: Record<string,number>, onStdout?: (text:string)=>void, onStderr?: (text:string)=>void,
 * stdin?: string|Buffer|null, readOnly?: boolean, readOnlyPaths?: string[], transferDir?: string|null, transferReadOnly?: boolean, dependencyEnvironment?: object|null}} [options] */
export async function runStrictCommand({ command, argv = null, workspaceDir, image, signal, timeoutMs, limits = {}, onStdout, onStderr, stdin = null, readOnly = false, readOnlyPaths = [], transferDir = null, transferReadOnly = true, dependencyEnvironment = null } = {}) {
  if (stdin !== null && Buffer.byteLength(stdin) > 8 * 1024 * 1024) throw failure('严格执行输入超过 8 MiB')
  if (command !== undefined && (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 1024 * 1024)) throw failure('严格命令为空或超过 1 MiB')
  abortBeforeStart(signal)
  const report = await inspectStrictIsolation({ image })
  const cap = limitsFor(limits), prepared = await workspaceInfo(workspaceDir)
  // Host-only file exchange for fixed document helpers, never exposed through
  // executeTool/model arguments. The parser itself receives only its private job.
  const transfer = transferDir === null ? null : await workspaceInfo(transferDir)
  const nested = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) }
  if (typeof transferReadOnly !== 'boolean' || (transfer && (transfer.masks.length
    || nested(prepared.workspace, transfer.workspace) || nested(transfer.workspace, prepared.workspace)))) {
    throw failure('私有文件交换目录必须与任务工作区分离，且不能包含凭据或治理路径')
  }
  if (!Array.isArray(readOnlyPaths) || readOnlyPaths.some(item => typeof item !== 'string' || !item)) throw failure('只读验收路径列表无效')
  const readOnlyMounts = [], seen = new Set()
  let dependencyBinding = null
  if (dependencyEnvironment !== null) {
    const mount = await resolveNpmEnvironmentMount({ environment: dependencyEnvironment, cwd: prepared.workspace, image: report.imageId, signal })
    readOnlyMounts.push({ source: mount.source, relative: mount.relative }); seen.add('node_modules')
    dependencyBinding = Object.freeze({ id: mount.id, planId: mount.planId, treeHash: mount.treeHash, imageId: mount.imageId })
  }
  for (const item of readOnlyPaths) {
    const resolved = await resolveWorkspacePath(prepared.workspace, item, { mustExist: true })
    const top = path.relative(prepared.workspace, resolved).split(path.sep)[0]
    if (!top) { readOnly = true; continue }
    if (sensitive(top) || seen.has(top)) continue
    if (/[,\r\n\0]/.test(top)) throw failure('只读验收路径无法安全挂载')
    seen.add(top)
    readOnlyMounts.push({ source: path.join(prepared.workspace, top), relative: top })
  }
  const token = randomUUID(), name = `kkcode-strict-${token}`
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kkcode-strict-'))
  if (/[,\r\n\0]/.test(scratch)) { await rm(scratch, { recursive: true, force: true }); throw failure('临时路径无法安全映射到隔离容器') }
  const emptyFile = path.join(scratch, 'empty'), emptyDir = path.join(scratch, 'directory')
  await mkdir(emptyDir, { mode: 0o555 }); await writeFile(emptyFile, '', { mode: 0o444, flag: 'wx' })
  let created = false, started = false
  try {
    const args = buildStrictDockerArgs({ name, token, imageId: report.imageId, ...prepared, readOnlyMounts, transfer, transferReadOnly, emptyFile, emptyDir, limits: cap,
      argv: argv || ['/bin/sh', '-c', String(command || '')], timeoutMs, interactive: stdin !== null, readOnly })
    signal?.throwIfAborted()
    const current = await lstat(prepared.workspace)
    if (!current.isDirectory() || current.ino !== prepared.identity.ino || current.dev !== prepared.identity.dev || await realpath(workspaceDir) !== prepared.workspace) throw failure('工作目录在执行前发生替换，已拒绝执行', 'strict_workspace_violation')
    if (transfer) {
      const currentTransfer = await lstat(transfer.workspace)
      if (!currentTransfer.isDirectory() || currentTransfer.ino !== transfer.identity.ino || currentTransfer.dev !== transfer.identity.dev
        || await realpath(transferDir) !== transfer.workspace) throw failure('私有文件交换目录在执行前发生替换', 'strict_workspace_violation')
    }
    const creation = await commandProcess('docker', args)
    // Even a failed create may have reached the daemon. Inspect only our unique
    // name during cleanup; no wildcard/container prune operations are allowed.
    created = true
    if (creation.exitCode !== 0 || creation.timedOut) throw failure('隔离容器创建失败；没有回退到宿主 Shell')
    signal?.throwIfAborted()
    started = true
    const result = await commandProcess('docker', ['start', '--attach', ...(stdin === null ? [] : ['--interactive']), name], {
      signal, timeoutMs: Math.min(timeoutMs || cap.timeout_ms, cap.timeout_ms) + 3000,
      maxBytes: cap.max_output_bytes, onStdout, onStderr, stdin
    })
    const inspected = await dockerJson(['container', 'inspect', name])
    const state = inspected[0]?.State
    if (state?.Running && !result.cancelled && !result.timedOut && !result.overflow) throw failure('Docker 客户端已断开但命令仍在运行，结果需要核查', 'strict_cleanup_unknown')
    return { ...result, exitCode: result.cancelled || result.timedOut || result.overflow ? 1 : state?.ExitCode ?? result.exitCode,
      timedOut: result.timedOut || state?.ExitCode === 124, oomKilled: state?.OOMKilled === true,
      isolation: { ...report, workspace: prepared.workspace, containerId: inspected[0]?.Id, credentialMasks: prepared.masks.length,
        ...(dependencyBinding ? { dependencyEnvironment: dependencyBinding } : {}) } }
  } catch (error) {
    error.operationNotStarted = !started
    throw error
  } finally {
    try { if (created) await removeOwnedContainer(name, token) }
    finally { await rm(scratch, { recursive: true, force: true }) }
  }
}

/** @param {{image?: string, limits?: Record<string,number>, readOnlyPaths?: string[], networkOrigins?: string[], delegationEnabled?: boolean, dependencyEnvironment?: object|null, prepareDependencyPlaceholder?: boolean}} [options] */
export function createDockerExecutionBackend({ image, limits = {}, readOnlyPaths = [], networkOrigins = [], delegationEnabled = false, dependencyEnvironment = null, prepareDependencyPlaceholder = false } = {}) {
  const cap = limitsFor(limits)
  const immutablePaths = structuredClone(readOnlyPaths)
  const networkCeiling = normalizeDataPolicy({ web_origins: networkOrigins })
  const allowedTools = Object.freeze([...ALLOWED, ...(networkCeiling.web_origins.length ? NETWORK_TOOLS : []), ...(delegationEnabled === true ? ['task', 'task_group'] : [])])
  let binding = null, chain = Promise.resolve()
  const readHashes = {}
  const backend = {
    allowedToolNames: allowedTools,
    /** @param {{cwd?: string, contract?: {allowedPaths?: string[], allowedTools?: string[]}, signal?: AbortSignal}} [options] */
    async ensureReady({ cwd, contract = {}, signal } = {}) {
      const allowedPaths = contract.allowedPaths ?? []
      if (!Array.isArray(allowedPaths) || (allowedPaths.length !== 0 && (allowedPaths.length !== 1 || allowedPaths[0] !== '.'))) throw failure('严格 Docker 初版只支持只读合同或 allowedPaths: ["."] 的整工作区合同；不会把细粒度路径限制静默扩大')
      abortBeforeStart(signal)
      const checked = await workspaceInfo(cwd)
      if (dependencyEnvironment && prepareDependencyPlaceholder) {
        await prepareNpmWorkspace({ environment: dependencyEnvironment, cwd: checked.workspace, image, signal })
      }
      const probe = await runStrictCommand({ image, workspaceDir: checked.workspace, argv: ['node', '-e', PROFILE_PROBE], signal, timeoutMs: 10000, limits: cap, readOnly: true, readOnlyPaths: immutablePaths, dependencyEnvironment })
      if (probe.exitCode !== 0 || probe.cancelled || probe.timedOut) throw failure('Docker 实际隔离探针未通过，严格任务不会开始')
      const report = probe.isolation
      binding = { cwd: checked.workspace, signal, readOnly: allowedPaths.length === 0, imageId: report.imageId, delegationTools: (contract.allowedTools || []).filter(name => ['task', 'task_group'].includes(name)) }
      return { ...report, workspace: checked.workspace, readOnly: binding.readOnly }
    },
    createVerificationBackend({ readOnlyPaths = [] } = {}) {
      if (!binding) throw failure('主严格执行后端尚未完成镜像验收')
      return createDockerExecutionBackend({ image: binding.imageId, limits: cap, readOnlyPaths, dependencyEnvironment, prepareDependencyPlaceholder: true })
    },
    /** @param {{command?: string, args?: string[], cwd?: string, shell?: boolean, timeoutMs?: number, signal?: AbortSignal}} [options] */
    async runCommand({ command, args = [], cwd, shell = false, timeoutMs, signal } = {}) {
      if (!binding || shell !== false || await realpath(cwd) !== binding.cwd) throw failure('严格执行未绑定当前任务工作目录', 'strict_workspace_violation')
      return runStrictCommand({ argv: [command, ...args], workspaceDir: binding.cwd, image, limits: cap, timeoutMs, readOnly: binding.readOnly, readOnlyPaths: immutablePaths, dependencyEnvironment,
        signal: binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal || signal })
    },
    executeTool(input) {
      // Composite tools cannot hold the leaf queue while awaiting their own
      // governed leaves. Their callbacks are opaque host capabilities; every
      // actual leaf re-enters this broker and the durable operation boundary.
      if (['tool_program', 'task', 'task_group', 'browser_recipe'].includes(input.tool?.name)) return (async () => {
        const { tool, context = {}, signal, invoke } = input
        if (!binding || await realpath(context.cwd) !== binding.cwd || !KNOWN_BUILTINS.has(tool) || !allowedTools.includes(tool.name)) throw failure('严格组合工具不属于当前任务的可信能力', 'strict_tool_denied')
        abortBeforeStart(binding.signal); abortBeforeStart(signal)
        if (tool.name === 'tool_program') {
          if (!isToolProgramCall(context.runToolProgramCall)) throw failure('严格组合工具缺少受控叶工具桥', 'strict_tool_denied')
        } else if (tool.name === 'browser_recipe') {
          if (!isBrowserRecipeCall(context.runBrowserRecipeCall)) throw failure('严格 Recipe 缺少逐叶治理桥；不会直接驱动浏览器', 'strict_tool_denied')
        } else {
          const { isTaskGraphHost } = await import('../orchestration/task-graph.mjs')
          if (!binding.delegationTools.includes(tool.name) || !isTaskGraphHost(currentDurableRun()?.taskGraph)) throw failure('合同或宿主未授权任务图委派；不会调用旧后台执行路径', 'strict_tool_denied')
        }
        return invoke()
      })()
      const work = chain.catch(() => {}).then(async () => {
        const { tool, args = {}, context = {}, signal, invoke } = input
        if (!binding || await realpath(context.cwd) !== binding.cwd) throw failure('工具不属于当前严格任务工作目录', 'strict_workspace_violation')
        const abort = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal || signal
        abortBeforeStart(abort)
        if (!allowedTools.includes(tool.name) || !KNOWN_BUILTINS.has(tool)) throw failure('严格任务不允许未经隔离的扩展、MCP 或此类工具', 'strict_tool_denied')
        if (tool.name === 'lsp') {
          const { isLspService } = await import('../lsp/service.mjs')
          if (!isLspService(context.lspService) || context.lspService.strict !== true || context.lspService.workspace !== binding.cwd) throw failure('严格任务缺少同工作区的隔离语言服务', 'strict_tool_denied')
          return invoke()
        }
        if (tool.name.startsWith('office_')) {
          const { isOfficeService } = await import('../office/service.mjs')
          if (!isOfficeService(context.officeService) || context.officeService.strict !== true || context.officeService.cwd !== binding.cwd) throw failure('严格任务缺少同工作区的隔离文档服务', 'strict_tool_denied')
          if (binding.readOnly && !['office_capabilities', 'office_inspect'].includes(tool.name)) throw failure('只读合同不允许文档输出写入工作区', 'strict_tool_denied')
          return invoke()
        }
        if (NETWORK_TOOLS.includes(tool.name)) {
          const policy = intersectDataPolicies(effectiveDataPolicy(context.configState || {}), context.config?.data_policy, networkCeiling)
          if (!policy.web_origins.length) throw failure('合同或项目策略不允许此网络目标', 'strict_tool_denied')
          if (tool.name === 'http_request') {
            if (!['GET', 'HEAD'].includes(String(args.method || 'GET').toUpperCase()) || args.body !== undefined) throw failure('严格通用 HTTP 只允许无 body 的 GET／HEAD；写操作须使用专用授权适配器', 'strict_tool_denied')
            if (args.headers && (typeof args.headers !== 'object' || Array.isArray(args.headers) || Object.keys(args.headers).some(name => !['accept', 'accept-language', 'content-type'].includes(name.toLowerCase())))) throw failure('严格通用 HTTP 不转发认证或任意自定义请求头', 'strict_tool_denied')
          }
          if (tool.name === 'browser' && context.config?.tool?.browser?.chromium_sandbox === false) throw failure('严格 Browser 不允许关闭 Chromium 沙箱；请使用支持沙箱的非 root 运行环境', 'strict_tool_denied')
          const config = { ...(context.config || {}), data_policy: policy }
          if (tool.name === 'browser') config.tool = { ...(config.tool || {}), browser: { ...(config.tool?.browser || {}), chromium_sandbox: true, executable_path: chromium.executablePath() } }
          // Deliberately call only this finite set of host-owned, guarded
          // adapters with a tighter context; never a generic plugin invoker.
          const result = await tool.execute(args, { ...context, config, configState: undefined, strictManagedBrowser: tool.name === 'browser', signal: abort })
          return typeof result === 'string' ? { output: result, metadata: { managedNetwork: true } } : { ...result, metadata: { ...(result.metadata || {}), managedNetwork: true } }
        }
        if (tool.name === 'bash') {
          if (args.run_in_background || args.env) throw failure('严格 Shell 不接受后台宿主进程或环境变量注入', 'strict_tool_denied')
          const result = await runStrictCommand({ command: args.command, workspaceDir: binding.cwd, image, limits: cap, timeoutMs: args.timeout_ms, signal: abort, readOnly: binding.readOnly, readOnlyPaths: immutablePaths, dependencyEnvironment })
          return { output: `${result.stdout}${result.stderr}${result.overflow ? '\n[输出达到隔离执行上限，内容不完整]' : ''}` || '(empty output)', status: result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'completed' : 'error', metadata: { isolation: result.isolation, outputComplete: !result.overflow && !result.cancelled && !result.timedOut },
            exitCode: result.exitCode, cancelled: result.cancelled, timedOut: result.timedOut }
        }
        if (['todowrite', 'artifact_read', 'artifact_search'].includes(tool.name)) return invoke()
        if (binding.readOnly && !['read', 'list'].includes(tool.name)) throw failure('合同只允许读取，不允许编辑工作区', 'strict_tool_denied')
        await workspaceInfo(binding.cwd)
        const paths = Array.isArray(args.changes) ? args.changes.map(change => change.path) : ['list', 'todowrite'].includes(tool.name) ? [args.path || '.'] : [args.path]
        const normalized = structuredClone(args)
        for (const requested of paths) {
          if (typeof requested !== 'string') throw failure('严格文件工具缺少路径', 'strict_workspace_violation')
          const resolved = await resolveWorkspacePath(binding.cwd, requested)
          if (path.relative(binding.cwd, resolved).split(path.sep).some(sensitive)) throw failure('严格任务不能访问 Git 治理面、凭据或私密配置路径', 'strict_workspace_violation')
        }
        abort?.throwIfAborted()
        if (Array.isArray(normalized.changes)) for (const change of normalized.changes) change.path = path.relative(binding.cwd, path.resolve(binding.cwd, change.path)).split(path.sep).join('/')
        else normalized.path = path.relative(binding.cwd, path.resolve(binding.cwd, normalized.path || '.')).split(path.sep).join('/') || '.'
        const bridge = await readFile(new URL('../../isolation/file-bridge.mjs', import.meta.url), 'utf8')
        const result = await runStrictCommand({ argv: ['node', '--input-type=module', '-e', bridge],
          stdin: JSON.stringify({ tool: tool.name, args: normalized, baseline: readHashes }), workspaceDir: binding.cwd, image, limits: cap, signal: abort, readOnly: binding.readOnly, readOnlyPaths: immutablePaths, dependencyEnvironment })
        if (result.cancelled || result.timedOut || result.overflow) throw failure('严格文件操作被中断，结果需要核查', 'strict_cleanup_unknown')
        let reply
        try { reply = JSON.parse(result.stdout) } catch { throw failure('严格文件操作未返回有效回执，结果需要核查', 'strict_cleanup_unknown') }
        if (reply.readHashes) Object.assign(readHashes, reply.readHashes)
        delete reply.readHashes
        return { ...reply, metadata: { ...(reply.metadata || {}), isolation: result.isolation } }
      })
      chain = work.then(() => {}, () => {})
      return work
    }
  }
  return backend
}
