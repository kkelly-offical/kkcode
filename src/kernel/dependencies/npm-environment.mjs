import path from 'node:path'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { realpath, mkdir, mkdtemp, readFile, writeFile, lstat, readdir, rm } from 'node:fs/promises'
import { guardedFetch } from '../../net/url-guard.mjs'
import { buildRequestHeaders } from '../../http/identity.mjs'
import { inspectStrictIsolation, runStrictCommand } from '../isolation/docker-executor.mjs'
import { boundedSchemaJson } from '../tool/schema-validation.mjs'
import { readPinnedFile } from '../../util/pinned-io.mjs'
import { userRootDir } from '../../storage/paths.mjs'
import { registerNpmEnvironment } from './environment-registry.mjs'

const plans = new WeakMap(), environments = new WeakMap()
const DEFAULT_LIMITS = Object.freeze({ packages: 2000, tarballBytes: 64 * 1024 * 1024, downloadBytes: 512 * 1024 * 1024, unpackBytes: 1024 * 1024 * 1024, unpackEntries: 200000, timeoutMs: 120000 })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const scriptFingerprint = ({ planId, imageId, scripts }) => hash(JSON.stringify({ schema: 'kk.npm-offline-script-approval.v1', planId, imageId, scripts }))
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
const snapshot = value => freeze(JSON.parse(boundedSchemaJson(value, 8 * 1024 * 1024)))
const defaultRoot = () => path.join(userRootDir(), 'dependency-environments')
const packagePath = value => /^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i.test(value)
  && value.split('/').every(part => !part.startsWith('.') && part !== '..')
const nested = (parent, child) => { const relative = path.relative(parent, child); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) }
function register(handle, state) {
  environments.set(handle, state)
  registerNpmEnvironment(handle, {
    prepare: options => prepareNpmWorkspace({ ...options, environment: handle }),
    mount: options => resolveNpmEnvironmentMount({ ...options, environment: handle })
  })
}

function limitsFor(input = {}) {
  const value = { ...DEFAULT_LIMITS, ...input }
  for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > DEFAULT_LIMITS[key]) fail('DEPENDENCY_LIMIT', '依赖准备配额无效或超过宿主上限。')
  return value
}
async function helper({ cwd, image, operation, signal, readOnly = true, maxBytes = DEFAULT_LIMITS.unpackBytes, scripts = [], timeoutMs = 120000 }) {
  const source = await readFile(new URL('../../dependencies/environment-worker.mjs', import.meta.url), 'utf8')
  const pinned = await readFile(new URL('../../util/pinned-io.mjs', import.meta.url), 'utf8')
  const code = source.replace("'../util/pinned-io.mjs'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(pinned).toString('base64')}`))
  const result = await runStrictCommand({ workspaceDir: cwd, image, argv: ['node', '--input-type=module', '-e', code],
    stdin: JSON.stringify({ operation, maxBytes, scripts }), readOnly, signal, timeoutMs,
    limits: { timeout_ms: timeoutMs, max_output_bytes: 12 * 1024 * 1024 } })
  if (result.exitCode || result.cancelled || result.timedOut || result.overflow) fail('DEPENDENCY_HELPER', '离线依赖检查／构建未完成；不会把部分环境标为可用。')
  let reply
  try { reply = JSON.parse(result.stdout) } catch { fail('DEPENDENCY_HELPER', '隔离依赖助手没有返回完整回执。') }
  if (reply?.ok !== true) fail('DEPENDENCY_HELPER', '隔离依赖助手拒绝了路径、结构或内容；未跳过检查。')
  return reply
}
function originList(values, allowPrivate) {
  if (!Array.isArray(values) || !values.length || values.length > 16) fail('DEPENDENCY_ORIGIN', '请明确批准 1–16 个包下载来源。')
  return [...new Set(values.map(value => {
    let url
    try { url = new URL(value) } catch { fail('DEPENDENCY_ORIGIN', '包下载来源必须是有效的 HTTP(S) origin。') }
    if (url.username || url.password || url.origin !== value || (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) fail('DEPENDENCY_ORIGIN', '包来源必须为不含凭据／路径的 HTTPS origin；HTTP 仅允许显式本机验收。')
    return url.origin
  }))].sort()
}
function integrity(value) {
  if (typeof value !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('DEPENDENCY_INTEGRITY', '每个依赖必须有单一 SHA-256／384／512 integrity；不支持 Git、目录、无完整性校验的 URL 或旧 SHA-1 包。')
  const [algorithm, digest] = value.split('-'), decoded = Buffer.from(digest, 'base64')
  if (decoded.length !== { sha256: 32, sha384: 48, sha512: 64 }[algorithm] || decoded.toString('base64') !== digest) fail('DEPENDENCY_INTEGRITY', '依赖 integrity 编码无效。')
  return { algorithm, digest }
}
function onPlatform(values, actual) {
  if (values === undefined) return true
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) fail('DEPENDENCY_LOCK', '锁文件的平台约束无效。')
  return !values.includes(`!${actual}`) && (!values.some(value => !value.startsWith('!')) || values.includes(actual) || values.includes('any'))
}

/** Host-only inspection: no fetch or package code is executed. Manifests are
 * read inside the approved fixed image, not by walking project paths on host.
 * @param {{cwd?: string, image?: string, registryOrigins?: string[], allowPrivate?: boolean, limits?: object, signal?: AbortSignal}} [options] */
export async function inspectNpmEnvironment({ cwd, image, registryOrigins, allowPrivate = false, limits = {}, signal } = {}) {
  const options = snapshot({ registryOrigins, allowPrivate, limits })
  if (typeof options.allowPrivate !== 'boolean') fail('DEPENDENCY_ORIGIN', '私网许可必须由宿主明确选择。')
  const origins = originList(options.registryOrigins, allowPrivate), cap = limitsFor(options.limits)
  const workspace = await realpath(cwd), isolation = await inspectStrictIsolation({ image })
  const collected = await helper({ cwd: workspace, image: isolation.imageId, operation: 'collect', signal })
  const rawPackage = Buffer.from(collected.packageJson, 'base64'), rawLock = Buffer.from(collected.packageLock, 'base64')
  let manifest, lock
  try { manifest = JSON.parse(rawPackage.toString('utf8')); lock = JSON.parse(rawLock.toString('utf8')) } catch { fail('DEPENDENCY_LOCK', 'package.json 或 package-lock.json 不是有效 JSON。') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || ![2, 3].includes(lock?.lockfileVersion) || !lock.packages || !Object.hasOwn(lock.packages, '') || manifest.workspaces || manifest.packageManager && !/^npm@/.test(manifest.packageManager)) fail('DEPENDENCY_UNSUPPORTED', '当前依赖环境仅支持无 workspaces 的 npm lockfile v2/v3；其他包管理器需专门适配，不会在线回退。')
  const packages = []
  for (const [key, item] of Object.entries(lock.packages)) {
    if (key === '') continue
    if (!packagePath(key) || !item || typeof item !== 'object' || item.link || item.inBundle || typeof item.version !== 'string' || typeof item.resolved !== 'string') fail('DEPENDENCY_UNSUPPORTED', '锁文件含不支持的目录链接、捆绑依赖或非注册表依赖。')
    integrity(item.integrity)
    let url
    try { url = new URL(item.resolved) } catch { fail('DEPENDENCY_ORIGIN', '依赖下载 URL 无效。') }
    if (!origins.includes(url.origin) || url.username || url.password || url.hash || url.search) fail('DEPENDENCY_ORIGIN', '锁文件包含未批准的来源、查询凭据或重定向形式。请先核对并批准真实注册表来源。')
    packages.push({ path: key, version: item.version, resolved: url.href, integrity: item.integrity,
      selected: onPlatform(item.os, collected.platform.os) && onPlatform(item.cpu, collected.platform.arch) })
    if (packages.length > cap.packages) fail('DEPENDENCY_LIMIT', '依赖数量超过准备上限。')
  }
  packages.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const data = { schema: 'kk.npm-plan.v1', imageId: isolation.imageId, manifestHashes: collected.manifestHashes, platform: collected.platform,
    registryOrigins: origins, allowPrivate, limits: cap, packages, offlineScripts: 'separate_approval' }
  const plan = snapshot({ ...data, id: hash(JSON.stringify(data)) })
  plans.set(plan, { workspace, rawPackage, rawLock, manifest, lock })
  return plan
}

async function auditArchive(file, maxBytes, signal) {
  signal?.throwIfAborted()
  const worker = new Worker(new URL('../../dependencies/archive-worker.mjs', import.meta.url), { workerData: { file, maxBytes }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } })
  let timer, abort
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(Object.assign(new Error('依赖归档检查已取消。'), { code: 'DEPENDENCY_CANCELLED' }))
      timer = setTimeout(() => reject(Object.assign(new Error('依赖归档检查超时。'), { code: 'DEPENDENCY_ARCHIVE' })), 15000)
      signal?.addEventListener('abort', abort, { once: true })
      const done = (error, value = null) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value) }
      worker.once('message', value => value?.ok ? done(null, value) : done(Object.assign(new Error('依赖归档包含不安全链接、路径或不支持结构。'), { code: 'DEPENDENCY_ARCHIVE' })))
      worker.once('error', () => done(Object.assign(new Error('依赖归档隔离检查失败。'), { code: 'DEPENDENCY_ARCHIVE' })))
      worker.once('exit', code => { if (code !== 0) done(Object.assign(new Error('依赖归档检查提前退出。'), { code: 'DEPENDENCY_ARCHIVE' })) })
    })
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await worker.terminate() }
}
async function privateRoot(requested = defaultRoot()) {
  const absolute = path.resolve(requested)
  await mkdir(absolute, { recursive: true, mode: 0o700 })
  if (await realpath(absolute) !== absolute) fail('DEPENDENCY_STORAGE', '依赖存储不能通过符号链接或路径别名访问。')
  const info = await lstat(absolute)
  if (!info.isDirectory() || info.mode & 0o077 || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('DEPENDENCY_STORAGE', '依赖存储必须属于当前用户且仅当前用户可访问（0700）。')
  let key
  try { key = await readPinnedFile(absolute, 'signing.key', { maxBytes: 32 }) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    try { await writeFile(path.join(absolute, 'signing.key'), randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    key = await readPinnedFile(absolute, 'signing.key', { maxBytes: 32 })
  }
  if (key.length !== 32) fail('DEPENDENCY_STORAGE', '依赖存储签名密钥格式无效。')
  const keyInfo = await lstat(path.join(absolute, 'signing.key'))
  if (keyInfo.mode & 0o077) fail('DEPENDENCY_STORAGE', '依赖环境签名密钥权限过宽。')
  return { root: absolute, key }
}
async function persist(state) {
  const { root, key } = await privateRoot(state.storageRoot)
  const proof = snapshot({ schema: 'kk.npm-environment.v1', id: path.basename(state.directory), directory: state.directory, planId: state.plan.id,
    imageId: state.plan.imageId, manifestHashes: state.plan.manifestHashes, platform: state.plan.platform, registryOrigins: state.plan.registryOrigins,
    limits: state.plan.limits, status: state.status, scripts: state.scripts,
    scriptsHash: scriptFingerprint({ planId: state.plan.id, imageId: state.plan.imageId, scripts: state.scripts }), treeHash: state.seal.treeHash,
    files: state.seal.files, bytes: state.seal.bytes, jobManifestHashes: state.jobManifestHashes })
  const json = JSON.stringify(proof), signature = createHmac('sha256', key).update(json).digest('hex')
  await writeFile(path.join(state.directory, 'environment.json'), JSON.stringify({ proof, signature }), { flag: 'wx', mode: 0o600 })
  const handle = snapshot(proof)
  register(handle, { ...state, storageRoot: root, proof: handle })
  return handle
}

/** Downloads only individually approved URLs. npm executes offline with scripts
 * disabled; install hooks have a separate immutable host approval boundary.
 * @param {{plan?: any, authorize?: Function, authorizeScripts?: Function, storageRoot?: string, signal?: AbortSignal}} [options] */
export async function prepareNpmEnvironment({ plan, authorize, authorizeScripts, storageRoot, signal } = {}) {
  const source = plans.get(plan)
  if (!source || typeof authorize !== 'function') fail('DEPENDENCY_APPROVAL', '依赖准备需要本次宿主检查生成的计划和明确授权。')
  if (await authorize(plan) !== true) fail('DEPENDENCY_DENIED', '用户未批准依赖下载与离线准备。')
  signal?.throwIfAborted()
  const current = await helper({ cwd: source.workspace, image: plan.imageId, operation: 'collect', signal })
  if (JSON.stringify(current.manifestHashes) !== JSON.stringify(plan.manifestHashes)) fail('DEPENDENCY_STALE', '授权期间依赖清单已变化，请重新检查计划。')
  const requestedStorage = path.resolve(storageRoot || defaultRoot())
  if (nested(source.workspace, requestedStorage) || nested(requestedStorage, source.workspace)) fail('DEPENDENCY_STORAGE', '宿主依赖存储必须在项目之外，不能向模型工作区暴露签名密钥。')
  const storage = await privateRoot(requestedStorage), directory = await mkdtemp(path.join(storage.root, 'npm-'))
  const job = path.join(directory, 'job'), cache = path.join(job, 'cache'), lock = JSON.parse(source.rawLock.toString('utf8'))
  const scripts = [], downloaded = new Map(); let bytes = 0, unpacked = 0, entries = 1, complete = false
  await mkdir(cache, { recursive: true, mode: 0o700 })
  try {
    for (const item of plan.packages) {
      signal?.throwIfAborted()
      const cacheName = `${hash(item.integrity)}.tgz`, filename = path.join(cache, cacheName)
      // Only this private job copy is rewritten. Original lock + versions + SRI
      // remain the authority; npm receives no external URL to resolve offline.
      lock.packages[item.path].resolved = `file:/workspace/cache/${cacheName}`
      if (!item.selected) continue
      let audited = downloaded.get(item.integrity)
      if (!audited) {
        let content
        try {
          const remaining = Math.min(plan.limits.tarballBytes, plan.limits.downloadBytes - bytes)
          if (remaining < 1) fail('DEPENDENCY_LIMIT', '依赖下载总量已达上限。')
          const { response } = await guardedFetch(item.resolved, { headers: buildRequestHeaders({ target: 'npm', accept: 'application/octet-stream' }), signal },
            { allowPrivate: plan.allowPrivate, maxRedirects: 0, maxWireBytes: remaining, maxDecodedBytes: remaining,
              assertTarget: url => { if (!plan.registryOrigins.includes(url.origin)) fail('DEPENDENCY_ORIGIN', '依赖来源发生变化。') } })
          if (!response.ok) fail('DEPENDENCY_DOWNLOAD', '依赖注册表没有返回成功响应。')
          content = Buffer.from(await response.arrayBuffer())
        } catch (error) { if (String(error.code || '').startsWith('DEPENDENCY_')) throw error; fail('DEPENDENCY_DOWNLOAD', '依赖下载失败或触及网络策略／大小限制；不会在线安装回退。') }
        if ((bytes += content.length) > plan.limits.downloadBytes) fail('DEPENDENCY_LIMIT', '依赖下载总量超过上限。')
        const expected = integrity(item.integrity), actual = createHash(expected.algorithm).update(content).digest('base64')
        if (actual !== expected.digest) fail('DEPENDENCY_INTEGRITY', '依赖包完整性校验失败；已停止准备。')
        await writeFile(filename, content, { mode: 0o600, flag: 'wx' })
        audited = await auditArchive(filename, plan.limits.unpackBytes - unpacked, signal)
        downloaded.set(item.integrity, audited)
      }
      // Reused archives installed at multiple lock paths still occupy disk at
      // every path. Count expanded bytes per installation, not per download.
      if ((unpacked += audited.bytes) > plan.limits.unpackBytes) fail('DEPENDENCY_LIMIT', '依赖安装展开总量超过上限。')
      const manifest = audited.manifest
      const binCount = typeof manifest.bin === 'string' ? 1 : manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin) ? Object.keys(manifest.bin).length : 0
      // Account before npm creates any inode: tar members, each installation
      // path's parents and a conservative .bin directory/link allowance. Empty
      // files and reused tarballs consume entries even when byte count is zero.
      entries += audited.entries + item.path.split('/').length + binCount * 2
      if (entries > plan.limits.unpackEntries) fail('DEPENDENCY_LIMIT', '依赖展开文件／目录数量超过上限；未启动 npm 解包。')
      if (manifest.version !== item.version || typeof manifest.name !== 'string' || !item.path.endsWith(`/node_modules/${manifest.name}`) && item.path !== `node_modules/${manifest.name}`) fail('DEPENDENCY_ARCHIVE', '包名称／版本与锁文件不一致，或使用了当前不支持的别名包。')
      if ((manifest.gypfile || audited.hasBindingGyp) && !manifest.scripts?.install) fail('DEPENDENCY_UNSUPPORTED', '需要隐式 node-gyp 构建的包暂不支持；请提供显式且受审查的离线构建脚本。')
      for (const event of ['preinstall', 'install', 'postinstall']) if (manifest.scripts?.[event] !== undefined) {
        const command = manifest.scripts[event]
        if (typeof command !== 'string' || !command.trim() || command.length > 8192 || command.includes('\0')) fail('DEPENDENCY_ARCHIVE', '依赖安装脚本无效或过长。')
        scripts.push({ path: item.path, event, command, sha256: hash(command) })
      }
    }
    await writeFile(path.join(job, 'package.json'), source.rawPackage, { flag: 'wx', mode: 0o600 })
    const jobLock = JSON.stringify(lock)
    await writeFile(path.join(job, 'package-lock.json'), jobLock, { flag: 'wx', mode: 0o600 })
    const jobManifestHashes = { packageJson: hash(source.rawPackage), packageLock: hash(jobLock) }
    const installation = await runStrictCommand({ workspaceDir: job, image: plan.imageId, signal, timeoutMs: plan.limits.timeoutMs,
      argv: ['/usr/bin/env', 'npm_config_userconfig=/tmp/kk-empty-user-config', 'npm_config_globalconfig=/tmp/kk-empty-global-config', 'npm_config_cache=/tmp/npm-cache', 'npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=http://127.0.0.1:9'],
      limits: { timeout_ms: plan.limits.timeoutMs, max_output_bytes: 1024 * 1024 } })
    if (installation.exitCode || installation.cancelled || installation.timedOut || installation.overflow) fail('DEPENDENCY_INSTALL', `npm 离线安装失败（锁文件不匹配、缺包或镜像能力不足）；没有访问网络或执行安装脚本。${installation.stderr.match(/npm (?:error|ERR!) code ([A-Z0-9_]+)/)?.[1] || ''}`)
    // npm legitimately omits node_modules for an empty lock. This is the
    // private preparation job, never an implicit change to the source project.
    await mkdir(path.join(job, 'node_modules'), { recursive: true, mode: 0o755 })
    // npm skips unsupported optional-platform packages; hooks for packages that
    // are not present must not be offered as if they had executed successfully.
    const installed = []
    for (const item of scripts) { try { const info = await lstat(path.join(job, item.path)); if (info.isDirectory() && !info.isSymbolicLink()) installed.push(item) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    const scriptPlan = snapshot({ schema: 'kk.npm-offline-scripts.v1', planId: plan.id, imageId: plan.imageId, scripts: installed,
      scriptsHash: scriptFingerprint({ planId: plan.id, imageId: plan.imageId, scripts: installed }), network: 'none', limits: plan.limits })
    let status = installed.length ? 'needs_offline_build' : 'ready'
    if (installed.length && typeof authorizeScripts === 'function' && await authorizeScripts(scriptPlan) === true) {
      await helper({ cwd: job, image: plan.imageId, operation: 'scripts', scripts: installed, readOnly: false, signal, timeoutMs: plan.limits.timeoutMs })
      status = 'ready'
    }
    const after = await helper({ cwd: job, image: plan.imageId, operation: 'collect', signal })
    if (JSON.stringify(after.manifestHashes) !== JSON.stringify(jobManifestHashes)) fail('DEPENDENCY_STALE', '依赖安装修改了项目清单副本，环境已拒绝。')
    const seal = await helper({ cwd: job, image: plan.imageId, operation: 'seal', maxBytes: plan.limits.unpackBytes, signal })
    if (seal.files > plan.limits.unpackEntries) fail('DEPENDENCY_LIMIT', '安装后的依赖文件／目录数量超过批准上限。')
    const handle = await persist({ storageRoot: storage.root, directory, job, plan, status, scripts: installed, seal, jobManifestHashes })
    complete = true; return handle
  } finally { if (!complete) await rm(directory, { recursive: true, force: true }) }
}

export function isNpmEnvironment(value) { return environments.has(value) }
/** @param {{directory?: string, storageRoot?: string, signal?: AbortSignal}} [options] */
export async function restoreNpmEnvironment({ directory, storageRoot, signal } = {}) {
  const storage = await privateRoot(storageRoot), location = path.resolve(directory)
  if (path.dirname(location) !== storage.root || !/^npm-[a-zA-Z0-9]+$/.test(path.basename(location)) || await realpath(location) !== location) fail('DEPENDENCY_STORAGE', '依赖环境不在指定宿主私有存储中。')
  let record
  try { record = JSON.parse((await readPinnedFile(location, 'environment.json', { maxBytes: 4 * 1024 * 1024, signal })).toString('utf8')) } catch { fail('DEPENDENCY_PROOF', '依赖环境回执缺失或无法安全读取。') }
  const proof = snapshot(record.proof), signature = createHmac('sha256', storage.key).update(JSON.stringify(proof)).digest('hex')
  if (typeof record.signature !== 'string' || record.signature.length !== signature.length || !timingSafeEqual(Buffer.from(record.signature), Buffer.from(signature)) || proof.schema !== 'kk.npm-environment.v1' || proof.directory !== location) fail('DEPENDENCY_PROOF', '依赖环境回执签名无效，不能把任意目录当成可信依赖。')
  const state = { directory: location, job: path.join(location, 'job'), storageRoot: storage.root, proof, status: proof.status }
  await verifyStored(state, signal)
  register(proof, state)
  return proof
}
async function verifyStored(state, signal) {
  const after = await helper({ cwd: state.job, image: state.proof.imageId, operation: 'collect', signal })
  if (JSON.stringify(after.manifestHashes) !== JSON.stringify(state.proof.jobManifestHashes)) fail('DEPENDENCY_STALE', '依赖环境内的清单发生变化。')
  const seal = await helper({ cwd: state.job, image: state.proof.imageId, operation: 'seal', maxBytes: state.proof.limits.unpackBytes, signal })
  if (seal.treeHash !== state.proof.treeHash || seal.files !== state.proof.files || seal.bytes !== state.proof.bytes) fail('DEPENDENCY_STALE', '只读依赖环境内容已改变，请重新准备，不能继续使用旧验收。')
}
/** @param {{environment?: any, cwd?: string, image?: string, signal?: AbortSignal}} [options] */
export async function verifyNpmEnvironment({ environment, cwd, image, signal } = {}) {
  const state = environments.get(environment)
  if (!state || environment.status !== 'ready') fail('DEPENDENCY_NOT_READY', '依赖环境未完成授权的离线构建，或不是宿主创建的真实句柄。')
  const workspace = await realpath(cwd)
  if (nested(workspace, state.storageRoot) || nested(state.storageRoot, workspace)) fail('DEPENDENCY_STORAGE', '任务工作区与宿主私有依赖存储不能重叠；不能把签名密钥挂入任务。')
  const report = await inspectStrictIsolation({ image })
  if (report.imageId !== environment.imageId) fail('DEPENDENCY_STALE', '运行镜像与依赖准备镜像不一致。')
  const current = await helper({ cwd: workspace, image: report.imageId, operation: 'collect', signal })
  if (JSON.stringify(current.manifestHashes) !== JSON.stringify(environment.manifestHashes)) fail('DEPENDENCY_STALE', 'package.json／package-lock.json 已改变，旧依赖环境失效；需要重新准备和验收。')
  await verifyStored(state, signal)
  return { valid: true, id: environment.id, planId: environment.planId, treeHash: environment.treeHash, imageId: report.imageId }
}
/** Explicit host operation for an isolated task/verification copy, not source.
 * @param {{environment?: any, cwd?: string, image?: string, signal?: AbortSignal}} [options] */
export async function prepareNpmWorkspace({ environment, cwd, image, signal } = {}) {
  await verifyNpmEnvironment({ environment, cwd, image, signal })
  const workspace = await realpath(cwd), target = path.join(workspace, 'node_modules')
  try { await mkdir(target, { mode: 0o755 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(target)).length) fail('DEPENDENCY_MOUNT', '依赖挂载点必须是独立工作树中的空 node_modules 目录；不会覆盖现有依赖。')
  return { prepared: true, workspace, environmentId: environment.id }
}
/** Internal host bridge. Model JSON cannot supply an arbitrary mount.
 * @param {{environment?: any, cwd?: string, image?: string, signal?: AbortSignal}} [options] */
export async function resolveNpmEnvironmentMount({ environment, cwd, image, signal } = {}) {
  await verifyNpmEnvironment({ environment, cwd, image, signal })
  const info = await lstat(path.join(cwd, 'node_modules')).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink() || (await readdir(path.join(cwd, 'node_modules'))).length) fail('DEPENDENCY_MOUNT', '请先为独立任务副本准备空的 node_modules 挂载点。')
  const state = environments.get(environment)
  return Object.freeze({ source: path.join(state.job, 'node_modules'), relative: 'node_modules', id: environment.id, planId: environment.planId, treeHash: environment.treeHash, imageId: environment.imageId })
}
