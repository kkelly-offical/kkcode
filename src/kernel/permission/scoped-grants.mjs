import path from 'node:path'
import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, lstat, realpath, open, rename, unlink } from 'node:fs/promises'
import { acquireProcessLock } from '../../storage/process-lock.mjs'
import { userRootDir } from '../../storage/paths.mjs'

const reject = message => Object.assign(new Error(message), { code: 'scoped_grant_denied', operationNotStarted: true })
const text = (value, field) => {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw reject(`授权字段无效：${field}`)
  return value
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw reject('授权参数必须是有限的 JSON 数据')
}

function binding(input) {
  const serialized = canonical(input.args ?? {})
  if (Buffer.byteLength(serialized) > 65536) throw reject('授权参数超过 64 KiB')
  return { principal: text(input.principal, 'principal'), taskId: text(input.taskId, 'taskId'),
    action: text(input.action, 'action'), resourceHash: createHash('sha256').update(text(input.resource, 'resource')).digest('hex'),
    resourceVersion: text(input.resourceVersion, 'resourceVersion'), operationId: text(input.operationId, 'operationId'),
    parametersHash: createHash('sha256').update(serialized).digest('hex') }
}

/** Host-only authority. Never expose issue/revoke as model tools or persist the
 * authority key in a workspace. Confirmation is supplied by the authenticated
 * human/organization host, not inferred from model text or a tool argument. */
export async function createScopedGrantAuthority({ rootDir = path.join(userRootDir(), 'scoped-grants'), now = Date.now } = {}) {
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  const rootInfo = await lstat(rootDir)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (process.platform !== 'win32' && (rootInfo.mode & 0o077))) throw reject('授权存储不允许路径别名或过宽目录权限')
  rootDir = await realpath(rootDir)
  const keyPath = path.join(rootDir, 'authority.key'), statePath = path.join(rootDir, 'grants.json'), lockPath = path.join(rootDir, 'authority.lock')
  async function locked(fn) {
    const started = Date.now()
    let lock
    while (!lock) {
      try { lock = await acquireProcessLock(lockPath) }
      catch (error) {
        if (error.code !== 'device_in_use' || Date.now() - started > 3000) throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    try { return await fn() } finally { await lock.release() }
  }
  const key = await locked(async () => {
    try { await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const info = await lstat(keyPath)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 32 || (process.platform !== 'win32' && (info.mode & 0o077))) throw reject('授权密钥文件无效或权限过宽')
    return readFile(keyPath)
  })
  const sign = payload => createHmac('sha256', key).update(payload).digest('base64url')
  async function save(store) {
    const temporary = `${statePath}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(store)); await file.sync() }
    finally { await file.close() }
    try {
      await rename(temporary, statePath)
      if (process.platform !== 'win32') {
        const directory = await open(rootDir, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  async function state() {
    let raw
    try {
      const info = await lstat(statePath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 32 * 1024 * 1024) throw reject('授权记录文件不安全或过大')
      raw = await readFile(statePath, 'utf8')
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, grants: {} }; throw reject('无法读取授权记录，拒绝执行') }
    try {
      const parsed = JSON.parse(raw)
      if (parsed.version !== 1 || !parsed.grants || typeof parsed.grants !== 'object' || Array.isArray(parsed.grants)) throw new Error()
      return parsed
    } catch { throw reject('授权记录损坏，拒绝重新建立空授权历史') }
  }
  function decode(token) {
    if (typeof token !== 'string' || token.length > 16384) throw reject('授权令牌无效')
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) throw reject('授权令牌无效')
    const expected = Buffer.from(sign(payload)), received = Buffer.from(signature)
    if (received.length !== expected.length || !timingSafeEqual(expected, received)) throw reject('授权签名不匹配')
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw reject('授权载荷无效') }
  }
  async function verify(token, expected, { allowConsumedForOperation = false } = {}) {
    const grant = decode(token), intended = binding(expected)
    for (const key of Object.keys(intended)) if (grant[key] !== intended[key]) throw reject('授权与当前主体、任务、目标、版本或操作参数不匹配')
    return locked(async () => {
      if (grant.version !== 1 || now() >= grant.expiresAt || now() < grant.issuedAt) throw reject('授权已过期或时钟状态不可信')
      const store = await state(), record = store.grants[grant.id]
      if (!record || (record.status !== 'active' && !(allowConsumedForOperation && record.status === 'consumed')) || record.tokenHash !== createHash('sha256').update(token).digest('hex')) throw reject('授权已撤销、已使用或缺少记录')
      return { id: grant.id, operationId: grant.operationId, confirmedBy: grant.confirmedBy, status: record.status }
    })
  }
  return {
    verify,
    // Recheck authorization immediately before the SAME durable operation's
    // external dispatch. This is not permission to execute a completed effect
    // again: the operation journal must independently prohibit replay.
    async verifyContinuation(token, expected) {
      const result = await verify(token, expected, { allowConsumedForOperation: true })
      if (result.status !== 'consumed') throw reject('操作尚未消费授权，不能直接继续提交')
      return result
    },
    async issue(input, confirmation) {
      const confirmedBy = text(confirmation?.confirmedBy, 'confirmedBy'), confirmationId = text(confirmation?.confirmationId, 'confirmationId')
      const issuedAt = now(), expiresAt = input.expiresAt
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt > issuedAt + 24 * 60 * 60 * 1000) throw reject('授权有效期必须在未来 24 小时内')
      const grant = { version: 1, id: randomUUID(), ...binding(input), issuedAt, expiresAt, confirmedBy, confirmationId }
      const payload = Buffer.from(JSON.stringify(grant)).toString('base64url'), token = `${payload}.${sign(payload)}`
      await locked(async () => {
        const store = await state()
        if (Object.keys(store.grants).length >= 100000) throw reject('授权记录已达到容量上限，请由管理员归档')
        store.grants[grant.id] = { status: 'active', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt }
        await save(store)
      })
      return { id: grant.id, token, expiresAt }
    },
    async verifyAndConsume(token, expected) {
      const grant = decode(token), intended = binding(expected)
      for (const key of Object.keys(intended)) if (grant[key] !== intended[key]) throw reject('授权与当前主体、任务、目标、版本或操作参数不匹配')
      if (grant.version !== 1 || now() >= grant.expiresAt || now() < grant.issuedAt) throw reject('授权已过期或时钟状态不可信')
      await locked(async () => {
        const store = await state(), record = store.grants[grant.id]
        if (now() >= grant.expiresAt || now() < grant.issuedAt) throw reject('授权在等待执行期间已过期')
        if (!record || record.status !== 'active' || record.tokenHash !== createHash('sha256').update(token).digest('hex')) throw reject('授权已撤销、已使用或缺少记录')
        record.status = 'consumed'; record.consumedAt = now()
        await save(store)
      })
      return { id: grant.id, operationId: grant.operationId, confirmedBy: grant.confirmedBy }
    },
    async revoke(id) {
      text(id, 'grant id')
      await locked(async () => {
        const store = await state(), record = store.grants[id]
        if (!record) throw reject('授权记录不存在')
        record.status = 'revoked'; record.revokedAt = now()
        await save(store)
      })
    }
  }
}
