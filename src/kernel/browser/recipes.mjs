import path from 'node:path'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { mkdir, lstat, open, readdir, rename, unlink, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { acquireProcessLock } from '../../storage/process-lock.mjs'
import { userRootDir } from '../../storage/paths.mjs'
import { currentArtifactAccountId } from '../tool/artifacts.mjs'

const authorities = new WeakMap()
const ID = /^recipe_[a-f0-9-]{36}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_BYTES = 1024 * 1024
const SECRET = /password|passwd|api.?key|access.?token|refresh.?token|private.?key|client.?secret|credential|密码|口令|私钥|密钥|令牌|凭据/i
const ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'option', 'tab', 'menuitem'])
const KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space'])
const PUBLIC_LABELS = new Set(['Search', 'Save', 'Submit', 'Next', 'Back', 'Confirm', 'Cancel', 'Close', 'Name', 'Email', '搜索', '查询', '保存', '提交', '下一步', '返回', '确认', '取消', '关闭', '姓名', '名称', '邮箱'])
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const clone = value => structuredClone(value)
const plain = value => value && typeof value === 'object' && !Array.isArray(value)

export class BrowserRecipeError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'BrowserRecipeError'; this.code = code; this.details = details }
}
const fail = (code, message, details = {}) => { throw new BrowserRecipeError(code, message, details) }
const invalid = message => fail('browser_recipe_invalid', message)
const unsafe = () => fail('browser_recipe_unsafe_storage', 'Recipe 状态目录或文件权限/链接状态不安全；未读取或覆盖。')

function waitForSignal(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new BrowserRecipeError('browser_recipe_cancelled', 'Recipe 隔离验证已取消或超过 60 秒，未启用。'))
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function originOf(value) {
  let url
  try { url = new URL(value) } catch { invalid('Recipe 需要明确的 HTTP(S) 站点 origin。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== `${url.origin}/`) invalid('Recipe 站点只接受 origin，不能包含路径、查询或凭据。')
  return url.origin
}
function identity(value) { if (typeof value !== 'string' || !ID.test(value)) invalid('Recipe 标识无效。'); return value }
function fingerprint(value) { if (typeof value !== 'string' || !HASH.test(value)) invalid('站点指纹必须由宿主提供 SHA-256。'); return value }
function canonicalRoot(rootDir) {
  const resolved = path.resolve(rootDir), suffix = [path.basename(resolved)]
  try { if (lstatSync(resolved).isSymbolicLink()) unsafe() } catch (error) { if (error.code !== 'ENOENT') throw error }
  let parent = path.dirname(resolved)
  for (;;) {
    try { return path.join(realpathSync(parent), ...suffix) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      suffix.unshift(path.basename(parent)); parent = path.dirname(parent)
    }
  }
}
function privateStat(info, directory = false) {
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) unsafe()
  if (process.platform !== 'win32' && (info.mode & 0o077 || process.getuid && info.uid !== process.getuid())) unsafe()
}

/** Host-only constructor. confirm must obtain an actual local/remote user's
 * decision. The returned authority is unforgeable from model JSON. It is not a
 * bearer token, and no `confirmed: true` field is accepted by recipe methods. */
export function createBrowserRecipeAuthority({ confirm }) {
  if (typeof confirm !== 'function') invalid('Recipe 授权需要宿主用户确认处理器。')
  const authority = Object.freeze({})
  authorities.set(authority, confirm)
  return authority
}

function validateCandidate(candidate) {
  if (!plain(candidate) || candidate.schema !== 'kk.browser-recipe.v1' || originOf(candidate.origin) !== candidate.origin || !HASH.test(candidate.fingerprint) || !Array.isArray(candidate.steps) || !candidate.steps.length || candidate.steps.length > 64 || !plain(candidate.parameters)) invalid('Recipe 候选结构无效。')
  if (Object.keys(candidate).some(key => !['schema', 'origin', 'fingerprint', 'steps', 'parameters'].includes(key))) invalid('Recipe 含未知字段。')
  const keys = Object.keys(candidate.parameters)
  if (keys.length > 128) invalid('Recipe 参数过多。')
  for (const key of keys) {
    const spec = candidate.parameters[key]
    if (!/^(?:input|path|target)_[1-9][0-9]{0,2}$/.test(key) || !plain(spec) || !['text', 'path', 'target'].includes(spec.kind) || Object.keys(spec).some(name => !['kind', 'maxLength'].includes(name)) || spec.maxLength !== (spec.kind === 'text' ? 4096 : spec.kind === 'path' ? 2048 : 120)) invalid('Recipe 参数声明无效。')
  }
  const used = new Set()
  for (const step of candidate.steps) {
    if (!plain(step) || !['snapshot', 'open', 'click', 'fill', 'press'].includes(step.action)) invalid('Recipe 只允许有限语义动作，不执行代码。')
    const allowed = step.action === 'snapshot' ? ['action'] : step.action === 'open' ? ['action', 'pathParameter'] : ['action', 'role', 'name', 'nameParameter', ...(step.action === 'fill' ? ['valueParameter', 'inputType'] : step.action === 'press' ? ['key'] : [])]
    if (Object.keys(step).some(key => !allowed.includes(key))) invalid('Recipe 动作含未授权字段。')
    if (['click', 'fill', 'press'].includes(step.action)) {
      if (!ROLES.has(step.role) || Boolean(step.name) === Boolean(step.nameParameter)) invalid('Recipe 需要明确 role 与一个名称定位方式。')
      if (step.name && (typeof step.name !== 'string' || step.name.length > 120 || SECRET.test(step.name))) invalid('Recipe 不录制敏感表单定位。')
    }
    if (step.action === 'fill' && !['text', 'search', 'email', 'number', 'url', 'tel', 'textarea'].includes(step.inputType)) invalid('Recipe 不录制密码/未知类型输入。')
    if (step.action === 'press' && !KEYS.has(step.key)) invalid('Recipe 按键不受支持。')
    for (const [field, kind] of [['nameParameter', 'target'], ['valueParameter', 'text'], ['pathParameter', 'path']]) if (step[field]) {
      if (candidate.parameters[step[field]]?.kind !== kind) invalid('Recipe 引用了不存在的参数。')
      used.add(step[field])
    }
    if (step.action === 'fill' && !step.valueParameter || step.action === 'open' && !step.pathParameter) invalid('Recipe 不能存储原始输入值或导航路径。')
  }
  if (used.size !== keys.length) invalid('Recipe 存在未使用的参数。')
  return candidate
}

/** Callbacks are constructor-only trusted host integrations, never model args.
 * executor.observe must compute a live version-level site fingerprint, not
 * echo a fingerprint supplied by a page, model or recipe file. fixtureRunner
 * must use a separate fresh, network-blocked fixture (not the live executor).
 */
export function createBrowserRecipeStore({ rootDir = path.join(userRootDir(), 'browser-recipes'), authority = undefined, executor = undefined, fixtureRunner = undefined, now = Date.now } = {}) {
  const root = canonicalRoot(rootDir), recordings = new Map()
  let rootIdentity
  async function ensure() {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const info = await lstat(root)
    if (info.isSymbolicLink()) unsafe()
    privateStat(info, true)
    if (rootIdentity && (rootIdentity.ino !== info.ino || rootIdentity.dev !== info.dev)) unsafe()
    rootIdentity ||= info
  }
  async function locked(callback) {
    await ensure()
    const lock = await acquireProcessLock(path.join(root, '.catalog.lock'))
    try { await ensure(); return await callback() } finally { await lock.release() }
  }
  async function read(id) {
    let handle
    try {
      handle = await open(path.join(root, `${identity(id)}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      const info = await handle.stat(); privateStat(info)
      if (info.size > MAX_BYTES) invalid('Recipe 状态文件过大。')
      const bytes = Buffer.alloc(info.size + 1)
      let count = 0
      while (count < bytes.length) { const value = await handle.read(bytes, count, bytes.length - count, count); if (!value.bytesRead) break; count += value.bytesRead }
      if (count !== info.size || (await handle.stat()).mtimeMs !== info.mtimeMs) unsafe()
      let record
      try { record = JSON.parse(bytes.subarray(0, count).toString('utf8')) } catch { invalid('Recipe 记录损坏；未自动删除。') }
      if (!plain(record) || record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1 || !['candidate', 'reviewed', 'validated', 'enabled', 'disabled', 'invalidated'].includes(record.state) || record.hash !== hash(validateCandidate(record.candidate))) invalid('Recipe 内容与固定哈希不一致，已拒绝使用。')
      return record
    } catch (error) {
      if (error.code === 'ENOENT') fail('browser_recipe_not_found', '未找到该 Recipe。')
      if (error.code === 'ELOOP') unsafe()
      throw error
    } finally { await handle?.close() }
  }
  async function write(record) {
    const data = JSON.stringify(record)
    if (Buffer.byteLength(data) > MAX_BYTES) invalid('Recipe 记录超过容量限制。')
    await ensure()
    const target = path.join(root, `${identity(record.id)}.json`), temporary = path.join(root, `.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
      await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null
      await ensure()
      try { const info = await lstat(target); if (info.isSymbolicLink()) unsafe(); privateStat(info) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await rename(temporary, target)
    } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  async function current(id, expectedHash) {
    const record = await locked(() => read(id))
    if (!HASH.test(expectedHash || '') || record.hash !== expectedHash) fail('browser_recipe_stale', 'Recipe 哈希已改变，请重新查看候选。')
    return record
  }
  async function transition(record, mutate) {
    return locked(async () => {
      const fresh = await read(record.id)
      if (fresh.revision !== record.revision || fresh.hash !== record.hash) fail('browser_recipe_stale', 'Recipe 状态已被其他操作修改，本次确认/验证未覆盖新状态。')
      const next = { ...fresh, ...mutate, revision: fresh.revision + 1, updatedAt: now() }
      await write(next); return clone(next)
    })
  }
  async function confirm(action, details) {
    const callback = authorities.get(authority)
    if (!callback) fail('browser_recipe_host_required', 'Recipe 录制、审核与启用只接受宿主的真实用户确认，不接受模型自动批准。')
    if (await callback(Object.freeze({ action, ...clone(details) })) !== true) fail('browser_recipe_declined', '用户未批准本次 Recipe 操作。')
  }
  async function observe(signal) {
    signal?.throwIfAborted()
    if (typeof executor?.observe !== 'function') fail('browser_recipe_unsupported', '宿主尚未提供受控浏览器站点指纹。')
    const value = await executor.observe({ signal })
    return { origin: originOf(value?.origin), fingerprint: fingerprint(value?.fingerprint) }
  }
  async function assertSite(record, signal) {
    const seen = await observe(signal)
    if (seen.origin !== record.candidate.origin || seen.fingerprint !== record.candidate.fingerprint) {
      await transition(record, { state: 'invalidated', invalidation: 'site_fingerprint_changed' })
      fail('browser_recipe_site_changed', '站点来源或界面版本指纹已变化，Recipe 已停用；需重新录制、审核和隔离验证。')
    }
  }
  const store = {
    async list() {
      return locked(async () => {
        const files = (await readdir(root)).filter(name => /^recipe_[a-f0-9-]{36}\.json$/.test(name))
        if (files.length > 256) invalid('Recipe 数量超过容量限制。')
        const result = []
        for (const file of files.sort()) { const record = await read(file.slice(0, -5)); result.push({ id: record.id, hash: record.hash, state: record.state, origin: record.candidate.origin, steps: record.candidate.steps.length, updatedAt: record.updatedAt }) }
        return result
      })
    },
    async get({ id }) { return clone(await locked(() => read(id))) },
    async start({ origin, minutes = 10, signal = undefined }) {
      const requested = originOf(origin)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30 || recordings.size >= 4) invalid('录制时限为 1–30 分钟，最多同时录制 4 个。')
      const seen = await observe(signal)
      if (seen.origin !== requested) fail('browser_recipe_site_changed', '当前页面不是申请录制的站点。')
      await confirm('record', { origin: requested, fingerprint: seen.fingerprint, minutes, warning: '只接收宿主显式提供的语义动作，不抓包、不记录输入原文、密码、Cookie 或请求头。' })
      signal?.throwIfAborted()
      const confirmedSite = await observe(signal)
      if (confirmedSite.origin !== seen.origin || confirmedSite.fingerprint !== seen.fingerprint) fail('browser_recipe_site_changed', '确认期间页面已变化，请重新开始录制。')
      const id = `recipe_${randomUUID()}`, candidate = { schema: 'kk.browser-recipe.v1', origin: requested, fingerprint: seen.fingerprint, steps: [], parameters: {} }
      const lifecycle = new AbortController()
      const expiresAt = now() + minutes * 60000
      let closed = false, discarded = false, completion = null, sequence = 0, admitted = 0, timer, feed = Promise.resolve(), feedError = false
      const stopFeed = () => { closed = true; lifecycle.abort(); clearTimeout(timer); recordings.delete(id); signal?.removeEventListener('abort', abort) }
      const finish = async () => {
        if (completion) return completion
        stopFeed()
        completion = feed.then(async () => {
          if (discarded) return { id, cancelled: true }
          if (feedError) fail('browser_recipe_recording_failed', '语义录制未完整完成，未发布可能缺失动作的候选。')
          if (!candidate.steps.length) return { id, closed: true, empty: true }
          validateCandidate(candidate)
          const record = { id, hash: hash(candidate), candidate, state: 'candidate', revision: 1, createdAt: now(), updatedAt: now() }
          await locked(async () => {
            if ((await readdir(root)).filter(name => ID.test(name.slice(0, -5))).length >= 256) invalid('Recipe 已达 256 条，请先在宿主管理记录。')
            await write(record)
          })
          return clone(record)
        })
        return completion
      }
      const abort = () => { void finish().catch(() => {}) }
      const parameter = kind => { const key = `${kind === 'text' ? 'input' : kind}_${++sequence}`; candidate.parameters[key] = { kind, maxLength: kind === 'text' ? 4096 : kind === 'path' ? 2048 : 120 }; return key }
      const recorder = Object.freeze({
        id, origin: requested, expiresAt, signal: lifecycle.signal, isActive: () => !closed && !signal?.aborted && now() < expiresAt,
        async record(event) {
          if (closed || signal?.aborted || now() >= expiresAt) { await finish(); return { recorded: false, reason: 'recording_closed' } }
          if (!plain(event) || !['snapshot', 'open', 'click', 'fill', 'press'].includes(event.action)) return { recorded: false, reason: 'unsupported_action' }
          for (const [key, limit] of Object.entries({ role: 32, name: 120, inputType: 24, key: 24 })) if (event[key] !== undefined && (typeof event[key] !== 'string' || event[key].length > limit)) return { recorded: false, reason: 'invalid_semantic_field' }
          if (admitted >= 64) { void finish().catch(() => {}); return { recorded: false, reason: 'event_limit' } }
          admitted++
          // Snapshot only semantic fields at admission. Values, cookies and
          // network data are not retained even in the pending event queue.
          const semantic = { action: event.action, role: event.role, name: event.name, inputType: event.inputType, key: event.key }
          const pending = feed.then(() => processEvent(semantic))
          feed = pending.then(() => {}, () => { feedError = true; stopFeed() })
          return pending
        },
        finish,
        async cancel() { discarded = true; stopFeed(); completion ||= feed.then(() => ({ id, cancelled: true })); return completion }
      })
      async function processEvent(event) {
          if (discarded || feedError) return { recorded: false, reason: 'recording_cancelled' }
          const seenNow = await observe(signal)
          if (seenNow.origin !== candidate.origin || seenNow.fingerprint !== candidate.fingerprint) { void finish().catch(() => {}); return { recorded: false, reason: 'site_changed' } }
          if (discarded) return { recorded: false, reason: 'recording_cancelled' }
          if (candidate.steps.length >= 64) { void finish().catch(() => {}); return { recorded: false, reason: 'step_limit' } }
          let step = { action: event.action }
          if (event.action === 'open') step.pathParameter = parameter('path')
          if (['click', 'fill', 'press'].includes(event.action)) {
            if (!ROLES.has(event.role) || typeof event.name !== 'string' || !event.name.trim() || event.name.length > 120 || SECRET.test(event.name)) return { recorded: false, reason: 'sensitive_or_unsupported_target' }
            if (event.action === 'fill' && !['text', 'search', 'email', 'number', 'url', 'tel', 'textarea'].includes(event.inputType)) return { recorded: false, reason: 'sensitive_or_unknown_input' }
            if (event.action === 'press' && !KEYS.has(event.key)) return { recorded: false, reason: 'unsupported_key' }
            // Keep only well-known generic interface words. Unknown labels
            // (including account names, emails and document titles) become
            // runtime parameters; the original text is never persisted.
            step = { ...step, role: event.role, ...(PUBLIC_LABELS.has(event.name.trim()) ? { name: event.name.trim() } : { nameParameter: parameter('target') }) }
            if (event.action === 'fill') Object.assign(step, { valueParameter: parameter('text'), inputType: event.inputType })
            if (event.action === 'press') step.key = event.key
          }
          candidate.steps.push(step)
          return { recorded: true, steps: candidate.steps.length }
      }
      timer = setTimeout(abort, minutes * 60000); timer.unref()
      signal?.addEventListener('abort', abort, { once: true })
      recordings.set(id, recorder)
      return recorder
    },
    async review({ id, hash: expectedHash }) {
      const record = await current(id, expectedHash)
      if (record.state === 'invalidated') fail('browser_recipe_site_changed', '已失效的 Recipe 需要重新录制，不能再次直接启用。')
      await confirm('review', { id, hash: record.hash, candidate: record.candidate })
      return transition(record, { state: 'reviewed', reviewedAt: now(), validation: null, invalidation: null })
    },
    async validate({ id, hash: expectedHash, signal = undefined }) {
      const record = await current(id, expectedHash)
      if (record.state !== 'reviewed') fail('browser_recipe_not_reviewed', '必须先由用户审核这个固定哈希的候选。')
      if (typeof fixtureRunner !== 'function' || fixtureRunner === executor?.execute) fail('browser_recipe_unsupported', '尚未配置独立、全新且网络隔离的 Recipe fixture runner。')
      signal?.throwIfAborted()
      const validationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)
      let receipt
      try { receipt = await waitForSignal(Promise.resolve().then(() => fixtureRunner({ id, hash: record.hash, candidate: clone(record.candidate), signal: validationSignal })), validationSignal) }
      catch (error) { if (error.code === 'browser_recipe_cancelled') throw error; fail('browser_recipe_validation_failed', '隔离 Browser fixture 执行失败，未启用。请检查独立测试页面、参数和浏览器环境；错误原文已省略以保护输入内容。') }
      validationSignal.throwIfAborted()
      if (!receipt || receipt.isolated !== true || receipt.network !== 'blocked' || receipt.hash !== record.hash || receipt.executedSteps !== record.candidate.steps.length || !HASH.test(receipt.fixtureHash || '') || receipt.fixtureHash === record.hash || !Array.isArray(receipt.assertions) || !receipt.assertions.length || receipt.assertions.length > 64 || receipt.assertions.some(value => value !== true)) fail('browser_recipe_validation_failed', '独立隔离 fixture 未完成全部动作/断言，Recipe 未启用。')
      return transition(record, { state: 'validated', validation: { recipeHash: record.hash, fixtureHash: receipt.fixtureHash, isolated: true, network: 'blocked', executedSteps: receipt.executedSteps, assertions: receipt.assertions.length, at: now() } })
    },
    async enable({ id, hash: expectedHash }) {
      const record = await current(id, expectedHash)
      if (record.state !== 'validated' || record.validation?.recipeHash !== record.hash) fail('browser_recipe_not_validated', '只有同一哈希通过人工审核与独立隔离验证后才能启用。')
      await confirm('enable', { id, hash: record.hash, candidate: record.candidate, validation: record.validation })
      return transition(record, { state: 'enabled', enabledAt: now() })
    },
    async disable({ id }) { const record = await locked(() => read(id)); return transition(record, { state: 'disabled' }) },
    async run({ id, hash: expectedHash, parameters = {}, signal = undefined }) {
      const record = await current(id, expectedHash)
      if (record.state !== 'enabled' || record.validation?.recipeHash !== record.hash) fail('browser_recipe_not_enabled', 'Recipe 未启用，模型不能自行审核或启用。')
      if (typeof executor?.execute !== 'function') fail('browser_recipe_unsupported', '宿主未提供受控语义动作执行器。')
      if (!plain(parameters) || Object.keys(parameters).length !== Object.keys(record.candidate.parameters).length || Object.entries(record.candidate.parameters).some(([key, spec]) => typeof parameters[key] !== 'string' || parameters[key].length > spec.maxLength) || Object.keys(parameters).some(key => !Object.hasOwn(record.candidate.parameters, key))) invalid('请只提供候选中声明的有界字符串参数；参数不会落盘。')
      const prepared = record.candidate.steps.map(template => {
        const step = { action: template.action }
        if (template.role) Object.assign(step, { role: template.role, name: template.name || parameters[template.nameParameter] })
        if (step.name && SECRET.test(step.name)) invalid('Recipe 不能运行敏感表单定位。')
        if (template.valueParameter) step.value = parameters[template.valueParameter]
        if (template.key) step.key = template.key
        if (template.pathParameter) {
          const value = parameters[template.pathParameter]
          if (!value.startsWith('/') || value.startsWith('//') || /[\\?#\u0000-\u001f]/.test(value)) invalid('导航参数只允许同站点绝对路径，不接受查询、fragment 或跨站地址。')
          step.url = new URL(value, record.candidate.origin).href
          if (new URL(step.url).origin !== record.candidate.origin) invalid('Recipe 不能跨站导航。')
        }
        return step
      })
      let completedSteps = 0
      const authorize = async () => {
        signal?.throwIfAborted()
        const fresh = await current(id, expectedHash)
        if (fresh.state !== 'enabled' || fresh.revision !== record.revision) fail('browser_recipe_stale', 'Recipe 已停用或修改，不能继续执行。', { completedSteps })
        return true
      }
      for (const step of prepared) {
        signal?.throwIfAborted()
        const fresh = await current(id, expectedHash)
        if (fresh.state !== 'enabled' || fresh.revision !== record.revision) fail('browser_recipe_stale', '运行中 Recipe 已被停用或修改；已停止后续动作。', { completedSteps })
        await assertSite(fresh, signal)
        signal?.throwIfAborted()
        try { await executor.execute(Object.freeze(step), { signal, recipeId: id, hash: record.hash, origin: record.candidate.origin, fingerprint: record.candidate.fingerprint, authorize, recordedInputType: record.candidate.steps[completedSteps].inputType }) }
        catch (error) { fail('browser_recipe_execution_failed', 'Recipe 动作未完成，已停止且不会自动重试；请检查页面，前一步可能已产生效果。', { completedSteps, attemptedStep: completedSteps, outcomeUnknown: error.operationNotStarted !== true && error.outcomeUnknown !== false && step.action !== 'snapshot' }) }
        completedSteps++
        if (signal?.aborted) fail('browser_recipe_cancelled', 'Recipe 已取消，已完成的动作不会自动撤销或重做。', { completedSteps })
      }
      return { id, hash: record.hash, completedSteps, status: 'completed' }
    },
    async shutdown() { await Promise.allSettled([...recordings.values()].map(recorder => recorder.finish())) }
  }
  return Object.freeze(store)
}

/** Safe default for CLI/model integrations: bindings come from the device's
 * private identity and canonical workspace, never model-provided account ids.
 * Raw/global host stores are not automatically imported or promoted. */
export async function createScopedBrowserRecipeStore({ cwd = process.cwd(), authority = undefined, executor = undefined, fixtureRunner = undefined, now = Date.now } = {}) {
  const stateRoot = path.resolve(userRootDir()), project = await realpath(cwd), account = await currentArtifactAccountId(stateRoot)
  const check = async () => {
    if (path.resolve(userRootDir()) !== stateRoot || await realpath(cwd) !== project || await currentArtifactAccountId(stateRoot) !== account) fail('browser_recipe_scope_changed', '设备账号/组织/网关或工作目录已改变，旧 Recipe 授权不转移，请在新范围重新录制和批准。')
  }
  const confirmCallback = authorities.get(authority)
  const scopedAuthority = confirmCallback ? createBrowserRecipeAuthority({ confirm: async request => { await check(); const approved = await confirmCallback(request); await check(); return approved } }) : undefined
  const scopedExecutor = executor ? {
    observe: async options => { await check(); const seen = await executor.observe(options); await check(); return seen },
    execute: async (step, options) => {
      await check()
      const authorize = async () => { await check(); if (await options.authorize() !== true) fail('browser_recipe_stale', 'Recipe 授权复核未通过。'); await check(); return true }
      return executor.execute(step, { ...options, authorize })
    }
  } : undefined
  const store = createBrowserRecipeStore({ rootDir: path.join(stateRoot, 'browser-recipes', 'scopes', account, `project_${hash(project)}`), authority: scopedAuthority, executor: scopedExecutor,
    fixtureRunner: fixtureRunner ? async input => { await check(); const receipt = await fixtureRunner(input); await check(); return receipt } : undefined, now })
  const wrapped = { ...store }
  for (const key of ['list', 'get', 'review', 'validate', 'enable', 'disable', 'run']) wrapped[key] = async (...args) => { await check(); const result = await store[key](...args); await check(); return result }
  wrapped.start = async options => {
    await check()
    const recorder = await store.start(options)
    await check()
    return Object.freeze({ ...recorder,
      async record(event) { await check(); return recorder.record(event) },
      async finish() { await check(); return recorder.finish() }
    })
  }
  wrapped.shutdown = () => store.shutdown()
  return Object.freeze(wrapped)
}
