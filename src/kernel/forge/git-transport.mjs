import { spawn } from 'node:child_process'
import { realpath, stat, access, mkdtemp, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { runControlledGit } from '../../util/controlled-git.mjs'
import { assertFetchableUrl } from '../../net/url-guard.mjs'
import { KKCODE_USER_AGENT } from '../../http/identity.mjs'
import { parseForgeRemote, branch, sha, fail, ForgeError, snapshotForgeData } from './repository.mjs'

const MAX_PACK = 128 * 1024 * 1024, MAX_BLOB = 64 * 1024 * 1024
const disabled = os.devNull
const digest = value => createHash('sha256').update(value).digest('hex')
const within = (root, file) => { const relative = path.relative(root, file); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

async function hostGit(cwd) {
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue
    try {
      const candidate = await realpath(path.join(entry, process.platform === 'win32' ? 'git.exe' : 'git'))
      if (within(cwd, candidate) || !(await stat(candidate)).isFile()) continue
      await access(candidate, constants.X_OK)
      return candidate
    } catch { /* Only explicit host PATH binaries outside the workspace. */ }
  }
  fail('FORGE_GIT_UNAVAILABLE', '需要工作区外的可信 Git 程序；不会执行项目提供的 Git。')
}
function environment(scratch, extra = {}) {
  return { ...Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: disabled, GIT_CONFIG_GLOBAL: disabled, GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_PROTOCOL_FROM_USER: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: '', PAGER: '', ...extra }
}
const gitOptions = ['--no-pager', '-c', `core.hooksPath=${disabled}`, '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${disabled}`,
  '-c', 'credential.helper=', '-c', `core.askPass=${disabled}`, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.http.allow=always',
  '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'http.proxy=', '-c', 'http.extraHeader=', '-c', `http.userAgent=${KKCODE_USER_AGENT}`,
  '-c', 'submodule.recurse=false', '-c', 'push.followTags=false', '-c', 'push.gpgSign=false', '-c', 'pack.threads=1']

/** Binary-safe bounded Git command. No raw server output escapes this module. */
function command(binary, args, { cwd, env, input = null, signal = null, timeoutMs = 30000, maxBytes = 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ForgeError('FORGE_CANCELLED', 'Git 交付已取消。')); return }
    const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    let size = 0, stopped = false, errorCode = null
    const chunks = []
    const kill = () => {
      stopped = true
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
      else {
        const system = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR
        if (system && child.pid) { const cleanup = spawn(path.join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); cleanup.on('error', () => {}) }
        child.kill('SIGKILL')
      }
    }
    const abort = () => { errorCode = 'FORGE_CANCELLED'; kill() }
    const timer = setTimeout(() => { errorCode = 'FORGE_GIT_TIMEOUT'; kill() }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBytes) { errorCode = 'FORGE_GIT_LIMIT'; kill() } else chunks.push(chunk) })
    child.stderr.on('data', chunk => { size += chunk.length; if (size > maxBytes) { errorCode = 'FORGE_GIT_LIMIT'; kill() } })
    child.on('error', () => { errorCode = 'FORGE_GIT_UNAVAILABLE' })
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (stopped || errorCode || code !== 0) reject(new ForgeError(errorCode || 'FORGE_GIT_FAILED', '受控 Git 操作未完整成功；不会输出服务端原始错误或凭据，推送结果需要只读核查。'))
      else resolve(Buffer.concat(chunks))
    })
    if (signal?.aborted) abort()
  })
}

/** A host-only, immutable candidate snapshot and HTTPS push transport. Workspace
 * config is never consulted by any network/pack command. No SSH, helpers, hooks,
 * URL rewrites, credential files, automatic fetch or force-push are supported.
 * @param {Record<string, any>} options */
export async function createGitPushTransport({ cwd, repository, candidateSha, sourceBranch, targetBranch, targetSha, token, allowPrivate = false, timeoutMs = 60000 }) {
  repository = snapshotForgeData(repository)
  const root = await realpath(cwd), repo = parseForgeRemote(repository?.remote, { kind: repository?.kind, apiBase: repository?.apiBase })
  if (repo.id !== repository.id) fail('FORGE_SCOPE', 'Git 推送仓库身份不一致。')
  sha(candidateSha); sha(targetSha); branch(sourceBranch); branch(targetBranch)
  if (sourceBranch === targetBranch || typeof token !== 'string' || !token || /[\r\n\0]/.test(token) || token.length > 16384 ||
      typeof allowPrivate !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) fail('FORGE_INVALID', '受控 Git 推送配置无效。')
  const url = new URL(`${repo.webUrl}.git`)
  if (url.protocol !== 'https:' && !(allowPrivate && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) fail('FORGE_INVALID', 'Git 推送必须使用 HTTPS；本机验收需显式允许回环 HTTP。')
  await assertFetchableUrl(url.href, { allowPrivate, resolve: false })
  const binary = await hostGit(root), scratch = await mkdtemp(path.join(os.tmpdir(), 'kk-forge-git-'))
  let closed = false
  const active = new Set()
  const env = environment(scratch)
  const git = (args, options = {}) => {
    if (closed) fail('FORGE_CLOSED', 'Git 交付快照已关闭。')
    const work = command(binary, [...gitOptions, ...args], { cwd: scratch, env, timeoutMs, ...options })
    active.add(work)
    void work.finally(() => active.delete(work)).catch(() => {})
    return work
  }
  try {
    await git(['init', '--bare', '--template=', `--object-format=${candidateSha.length === 64 ? 'sha256' : 'sha1'}`, '.'])
    if (!net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !(await git(['help', '--config'])).toString().split(/\r?\n/).includes('http.curloptResolve')) fail('FORGE_GIT_UNAVAILABLE', '当前 Git 不支持 http.curloptResolve 固定 DNS 地址，请升级 Git；不会回退到不受控解析。IP 字面地址不需要 DNS。')
    const located = await runControlledGit(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: root, maxBuffer: 4096 })
    if (!located.ok) fail('FORGE_GIT_SOURCE', '无法定位已批准工作区的 Git 对象目录。')
    const objects = await realpath(located.stdout.trim())
    if (/[:\r\n\0]/.test(objects.replace(/^[A-Za-z]:[\\/]/, ''))) fail('FORGE_GIT_SOURCE', 'Git 对象路径不能安全表示为独立对象源。')
    // Source config is never loaded. Only objects reachable from the fixed SHA
    // enter an independently verified pack, then source aliases are discarded.
    const pack = await git(['pack-objects', '--stdout', '--revs'], { input: `${candidateSha}\n`, env: environment(scratch, { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }), maxBytes: MAX_PACK })
    await git(['index-pack', '--stdin', '--strict'], { input: pack, maxBytes: 1024 * 1024 })
    await git(['cat-file', '-e', `${candidateSha}^{commit}`])
    const tree = sha((await git(['rev-parse', `${candidateSha}^{tree}`])).toString().trim())
    async function files() {
      const entries = (await git(['ls-tree', '-r', '-z', '--full-tree', candidateSha], { maxBytes: 16 * 1024 * 1024 })).toString('utf8').split('\0').filter(Boolean)
      if (entries.length > 100000) fail('FORGE_GIT_LIMIT', '候选文件清单超过上限。')
      const result = [], cache = new Map()
      for (const entry of entries) {
        const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(entry)
        if (!match) fail('FORGE_GIT_SOURCE', '候选包含未支持的 Git 条目（例如子模块），不能假称完整映射。')
        const [, mode, oid, filename] = match
        let bytes = cache.get(oid)
        if (!bytes) { bytes = await git(['cat-file', 'blob', oid], { maxBytes: MAX_BLOB }); if (cache.size < 8 && bytes.length < 1024 * 1024) cache.set(oid, bytes) }
        result.push(mode === '120000' ? { path: filename, kind: 'symlink', hash: digest(JSON.stringify(bytes.toString('utf8'))) }
          : { path: filename, kind: 'file', executable: mode === '100755', size: bytes.length, hash: digest(bytes) })
      }
      return result
    }
    async function networkEnv() {
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true })
      await assertFetchableUrl(url.href, { allowPrivate, lookup: async () => addresses })
      const address = addresses.map(item => item.family === 6 ? `[${item.address}]` : item.address).join(',')
      const values = [ ['http.curloptResolve', `${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}:${address}`],
        [`http.${url.origin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`${repo.kind === 'github' ? 'x-access-token' : 'oauth2'}:${token}`).toString('base64')}`] ]
      return environment(scratch, { GIT_CONFIG_COUNT: String(values.length), ...Object.fromEntries(values.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])) })
    }
    const push = async request => {
      const signal = request?.signal
      const supplied = request && snapshotForgeData({ repositoryId: request.repository?.id, candidateSha: request.candidateSha, sourceBranch: request.sourceBranch, refspec: request.refspec, force: request.force })
      const refspec = `${candidateSha}:refs/heads/${sourceBranch}`
      if (!supplied || supplied.repositoryId !== repo.id || supplied.candidateSha !== candidateSha || supplied.sourceBranch !== sourceBranch || supplied.refspec !== refspec || supplied.force !== false || signal && !(signal instanceof AbortSignal)) fail('FORGE_SCOPE', 'Git 推送请求不匹配固定候选及目标分支。')
      const network = await networkEnv()
      const remote = await git(['ls-remote', '--refs', url.href, `refs/heads/${targetBranch}`], { env: network, signal })
      if (remote.toString().trim() !== `${targetSha}\trefs/heads/${targetBranch}`) fail('FORGE_TARGET_MOVED', '目标分支已变化；未推送候选，请重新集成和验收。')
      // Plain fixed SHA refspec, no '+' or --force/--mirror/--all/delete/options.
      await git(['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--signed=false', url.href, refspec], { env: network, signal })
      return { candidateSha, sourceBranch, targetSha, repositoryId: repo.id, tree }
    }
    return Object.freeze({ push, files, candidateSha, tree, repositoryId: repo.id,
      async close() { if (!closed) { closed = true; await Promise.allSettled([...active]); await rm(scratch, { recursive: true, force: true }) } } })
  } catch (error) { closed = true; await rm(scratch, { recursive: true, force: true }); throw error }
}
