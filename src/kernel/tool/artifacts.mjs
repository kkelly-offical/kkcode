import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { ArtifactStore, ArtifactStoreError } from '../../storage/artifact-store.mjs'
import { userRootDir } from '../../storage/paths.mjs'
import { getSession } from '../session/store.mjs'

const digest = value => createHash('sha256').update(String(value)).digest('hex')
const accesses = new WeakSet(), references = new WeakSet()
const ARCHIVE_ATTEMPT = Symbol('host-artifact-archive-attempt')
const publicRef = metadata => Object.freeze({ id: metadata.id, sha256: metadata.sha256, size: metadata.size })
const missingAccess = () => { throw new ArtifactStoreError('artifact_host_required', '完整输出读取需要当前会话的受控运行环境。', 403) }

/** Sanitized local identity accessor. Never returns profile, gateway or tokens. */
export async function currentArtifactAccountId(stateRoot = path.resolve(userRootDir())) {
  let identity, handle
  try {
    handle = await open(path.join(stateRoot, 'device', 'identity.json'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024 || process.platform !== 'win32' && (info.mode & 0o077 || process.getuid && info.uid !== process.getuid())) throw new Error('unsafe identity')
    identity = JSON.parse(await handle.readFile('utf8'))
  }
  catch (error) { if (error.code !== 'ENOENT') throw new ArtifactStoreError('artifact_identity_invalid', '设备身份记录无法读取；完整输出未跨账号开放，请在本机修复身份记录。', 409) }
  finally { await handle?.close() }
  if (identity && (typeof identity !== 'object' || Array.isArray(identity) ||
    ['owner', 'ownerGateway', 'historyOwner', 'historyGateway', 'historyOrganization'].some(key => identity[key] != null && (typeof identity[key] !== 'string' || !identity[key]))
    || identity.profile?.organization != null && typeof identity.profile.organization !== 'string')) {
    throw new ArtifactStoreError('artifact_identity_invalid', '设备身份记录无效，已停止访问完整输出。', 409)
  }
  const owner = identity?.owner || identity?.historyOwner
  const gateway = identity?.ownerGateway || identity?.historyGateway || ''
  const organization = identity?.profile?.organization || identity?.historyOrganization || ''
  return `account_${digest(owner ? JSON.stringify(['bound', gateway, organization, owner]) : `local:${stateRoot}`)}`
}

/** Trusted local closure, never reconstructed from tool/model/RPC arguments.
 * Conversation scope deliberately spans turns; it is NOT a durable RunRecord. */
export function createConversationArtifactAccess({ sessionId, cwd, turnId, storeOptions = undefined }) {
  const stateRoot = path.resolve(userRootDir())
  let store, initialActor
  const actor = async () => {
    if (path.resolve(userRootDir()) !== stateRoot) throw new ArtifactStoreError('artifact_identity_changed', '本机私密状态目录已改变，已停止读取旧范围输出。', 403)
    const saved = await getSession(sessionId)
    if (!saved?.session?.cwd || await realpath(saved.session.cwd) !== await realpath(cwd)) {
      throw new ArtifactStoreError('artifact_session_scope', '会话工作目录已改变，无法读取原范围的完整输出。', 403)
    }
    const next = {
      accountId: await currentArtifactAccountId(stateRoot),
      projectId: `project_${digest(await realpath(saved.session.cwd))}`,
      sessionId: `session_${digest(sessionId)}`,
      runId: `conversation_${digest(sessionId)}`
    }
    if (initialActor && JSON.stringify(initialActor) !== JSON.stringify(next)) {
      throw new ArtifactStoreError('artifact_identity_changed', '设备绑定或账号已改变，旧输出仍保留；需明确迁移后才能在新账号读取。', 403)
    }
    initialActor ||= next
    store ||= new ArtifactStore({ root: path.join(stateRoot, 'artifacts'), ...storeOptions })
    return next
  }
  const access = Object.freeze({
    async authorize() { await actor(); return true },
    async put(content, callId, signal) {
      const metadata = await storeAfterActor(async scope => store.put({ actor: scope, content, mime: 'text/plain; charset=utf-8',
        source: { kind: 'tool', toolCallId: `call_${digest(callId)}`, operationId: `turn_${digest(turnId)}` }, signal }))
      const ref = publicRef(metadata)
      references.add(ref)
      return ref
    },
    async putFile({ content, mime, callId, sourceId, kind = 'web', signal }) {
      const metadata = await storeAfterActor(scope => store.put({ actor: scope, content, mime,
        source: { kind, toolCallId: `call_${digest(callId)}`, operationId: `turn_${digest(turnId)}`, ...(sourceId ? { messageId: sourceId } : {}) }, signal }))
      const ref = publicRef(metadata); references.add(ref); return ref
    },
    async read(input) { return storeAfterActor(scope => store.read({ ...input, actor: scope })) },
    async search(input) { return storeAfterActor(scope => store.search({ ...input, actor: scope })) },
    async list(input = {}) { return storeAfterActor(scope => store.list({ ...input, actor: scope })) },
    async metadata(input) { return storeAfterActor(scope => store.getMetadata({ ...input, actor: scope })) },
    async pin(input) { return storeAfterActor(scope => store.pin({ ...input, actor: scope })) },
    async reconcile(input) { return storeAfterActor(scope => store.reconcileRetention({ ...input, actor: scope })) },
    async prune() { return storeAfterActor(scope => store.prune({ actor: scope })) },
    async prepareRetirement() {
      const scope = await actor()
      // Minted while canonical session identity still exists, consumed only
      // after the host successfully removes that session. Never an RPC token.
      return Object.freeze({ async commit() {
        if (path.resolve(userRootDir()) !== stateRoot || await currentArtifactAccountId(stateRoot) !== scope.accountId) {
          throw new ArtifactStoreError('artifact_identity_changed', '账号已改变，未扩大旧产物的清理权限。', 403)
        }
        return store.reconcileRetention({ actor: scope, active: false, resolved: true, retired: true, references: {} })
      } })
    }
  })
  async function storeAfterActor(run) { const scope = await actor(); return run(scope) }
  accesses.add(access)
  return access
}

/** Trusted durable coordinator factory. resolveActor must revalidate the live
 * run lease/owner on EVERY operation; neither it nor store is model/RPC input.
 * Conversation-scoped and durable-run-scoped archives never widen each other. */
export function createTaskArtifactAccess({ store, resolveActor }) {
  if (!store || ['put', 'read', 'search', 'list', 'getMetadata'].some(name => typeof store[name] !== 'function') || typeof resolveActor !== 'function') {
    throw new ArtifactStoreError('artifact_host_required', '持久任务产物需要可信宿主存储和实时拥有者校验。', 403)
  }
  const run = async callback => {
    const actor = await resolveActor()
    // Let the canonical store validate exact scope; do not merge any caller's
    // identity fields into the coordinator's authority.
    return callback(actor)
  }
  const access = Object.freeze({
    async authorize() { return run(actor => {
      if (!actor || ['accountId', 'projectId', 'sessionId', 'runId'].some(key => typeof actor[key] !== 'string' || !/^[a-zA-Z0-9_.:@-]{1,160}$/.test(actor[key]))) missingAccess()
      return true
    }) },
    async put(content, callId, signal) {
      const metadata = await run(actor => store.put({ actor, content, mime: 'text/plain; charset=utf-8',
        source: { kind: 'tool', toolCallId: `call_${digest(callId)}`, operationId: `run_${digest(actor.runId)}` }, signal }))
      const ref = publicRef(metadata); references.add(ref); return ref
    },
    async putFile({ content, mime, callId, sourceId, kind = 'web', signal }) {
      const metadata = await run(actor => store.put({ actor, content, mime,
        source: { kind, toolCallId: `call_${digest(callId)}`, operationId: `run_${digest(actor.runId)}`, ...(sourceId ? { messageId: sourceId } : {}) }, signal }))
      const ref = publicRef(metadata); references.add(ref); return ref
    },
    async read(input) { return run(actor => store.read({ ...input, actor })) },
    async search(input) { return run(actor => store.search({ ...input, actor })) },
    async list(input = {}) { return run(actor => store.list({ ...input, actor })) },
    async metadata(input) { return run(actor => store.getMetadata({ ...input, actor })) }
  })
  accesses.add(access)
  return access
}

const BROWSER_FILE_LIMIT = 16 * 1024 * 1024

/** Check live authority BEFORE a browser download click; this creates no file. */
export async function authorizeBrowserArtifacts(access) {
  if (!accesses.has(access)) missingAccess()
  await access.authorize()
  return { authorized: true }
}
export const authorizeArtifactAccess = authorizeBrowserArtifacts

/** Trusted browser download seam. No host path and no raw URL/name enter the
 * artifact catalog; even origin/path is hashed after stripping credentials,
 * query and fragment. Files remain untrusted bytes, never opened/executed. */
export async function archiveBrowserFile({ access, content, mime = 'application/octet-stream', filename: _filename = undefined, sourceUrl = undefined, callId, signal = undefined }) {
  if (!accesses.has(access)) missingAccess()
  signal?.throwIfAborted()
  let sourceId
  if (sourceUrl) {
    if (typeof sourceUrl !== 'string' || sourceUrl.length > 8192) throw new ArtifactStoreError('artifact_invalid', '浏览器产物来源地址过长。')
    const url = new URL(sourceUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ArtifactStoreError('artifact_invalid', '浏览器产物来源地址无效。')
    sourceId = `web_${digest(`${url.origin}${url.pathname}`)}`
  }
  return putBinary({ access, content, mime, callId, sourceId, signal, kind: 'web', maxBytes: BROWSER_FILE_LIMIT })
}

/** Host-only document pipeline seam. Directory traversal and output ownership
 * must already be enforced by the isolated producer; only bytes cross here. */
export async function archiveBinaryArtifact({ access, content, mime = 'application/octet-stream', callId, kind = 'document', maxBytes = 128 * 1024 * 1024, signal = undefined }) {
  if (!accesses.has(access)) missingAccess()
  if (kind !== 'document' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) throw new ArtifactStoreError('artifact_invalid', '文档产物需要 document 来源和不超过 128 MiB 的明确上限。')
  signal?.throwIfAborted()
  return putBinary({ access, content, mime, callId, kind, maxBytes, signal })
}

async function putBinary({ access, content, mime, callId, sourceId = undefined, kind, maxBytes, signal }) {
  async function* boundedInput() {
    let size = 0
    const input = content instanceof Uint8Array ? [content] : content
    if (!input || typeof input[Symbol.asyncIterator] !== 'function' && typeof input[Symbol.iterator] !== 'function' || typeof input === 'string') throw new ArtifactStoreError('artifact_invalid', '浏览器产物需要二进制内容或有界字节流。')
    const iterator = input[Symbol.asyncIterator]?.() || input[Symbol.iterator]()
    try {
      while (true) {
        signal?.throwIfAborted()
        const next = await iterator.next()
        if (next.done) break
        const chunk = next.value
        if (!(chunk instanceof Uint8Array)) throw new ArtifactStoreError('artifact_invalid', '浏览器产物流只能包含字节。')
        size += chunk.byteLength
        if (size > maxBytes) throw new ArtifactStoreError('artifact_file_quota', `二进制归档超过 ${maxBytes} 字节上限，未发布部分产物。`, 413)
        yield chunk
      }
    } finally {
      // An untrusted stream's return() must not hold the global store lock.
      try { Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* closed */ }
    }
  }
  return access.putFile({ content: boundedInput(), mime, callId, sourceId, kind, signal })
}

/** Upload only an existing artifact in the live branded account/project/run
 * scope. Validate the complete byte stream before giving it to a browser. */
export async function readBrowserUpload({ access, id, maxBytes = BROWSER_FILE_LIMIT, signal = undefined }) {
  if (!accesses.has(access)) missingAccess()
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > BROWSER_FILE_LIMIT) throw new ArtifactStoreError('artifact_invalid', '浏览器上传上限必须介于 1 字节和 16 MiB 之间。')
  signal?.throwIfAborted()
  const metadata = await access.metadata({ id })
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes) throw new ArtifactStoreError('artifact_file_quota', '产物超过本次浏览器上传大小限制。', 413)
  const buffer = Buffer.alloc(metadata.size), hash = createHash('sha256'), cursors = new Set()
  let offset = 0, cursor
  do {
    signal?.throwIfAborted()
    const page = await access.read({ id, cursor, limit: 256 * 1024 })
    if (page.id !== id || page.sha256 !== metadata.sha256 || page.size !== metadata.size || page.offset !== offset || page.encoding !== 'base64') throw new ArtifactStoreError('artifact_corrupt', '产物分页快照发生变化，已停止上传。', 409)
    const bytes = Buffer.from(page.data, 'base64')
    if (bytes.toString('base64') !== page.data || offset + bytes.length > metadata.size || !bytes.length && page.nextCursor) throw new ArtifactStoreError('artifact_corrupt', '产物分页内容无效，已停止上传。', 409)
    bytes.copy(buffer, offset); hash.update(bytes); offset += bytes.length
    cursor = page.nextCursor
    if (cursor) {
      if (cursors.has(cursor) || cursors.size > 128) throw new ArtifactStoreError('artifact_corrupt', '产物分页游标无效，已停止上传。', 409)
      cursors.add(cursor)
    }
  } while (cursor)
  if (offset !== metadata.size || hash.digest('hex') !== metadata.sha256) throw new ArtifactStoreError('artifact_corrupt', '产物完整性校验失败，已停止上传。', 409)
  signal?.throwIfAborted()
  // A durable owner/lease may have changed while a page was being read.
  await access.metadata({ id })
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf', 'text/plain': 'txt' }[metadata.mime.split(';')[0]] || 'bin'
  return { buffer, mime: metadata.mime, filename: `${id}.${extension}` }
}

export function artifactReceipt(ref, complete = true) {
  return `[Context artifact ${ref.id} | ${ref.size} bytes | sha256=${ref.sha256}]\n${complete
    ? '完整工具文本已保存在本机当前会话。'
    : '仅保存已捕获的部分文本：命令超时、取消或输出达到进程捕获上限，不代表完整执行结果。'} 使用 artifact_read 分页读取或 artifact_search 搜索，不要为了找回日志重跑有副作用的操作。`
}

export function trustedArtifactRef(result) {
  const ref = result?.metadata?.artifactRef
  return ref && references.has(ref) ? ref : null
}

export function trustedArtifactRefs(result) {
  const all = [result?.metadata?.artifactRef, ...(Array.isArray(result?.metadata?.artifactRefs) ? result.metadata.artifactRefs : [])]
  return [...new Map(all.filter(ref => ref && references.has(ref)).map(ref => [ref.id, ref])).values()]
}

export function artifactArchiveAttempted(result) { return result?.metadata?.[ARCHIVE_ATTEMPT] === true }

/** Archive BEFORE display truncation. Failure never re-executes the tool, and
 * never changes its already-settled side-effect status into a retry instruction. */
export async function archiveToolText({ output, access, callId, limit, signal = null, complete = true }) {
  const text = String(output ?? '')
  if (text.length <= limit) return { output: text, metadata: {} }
  const preview = text.slice(0, limit)
  try {
    if (!accesses.has(access)) missingAccess()
    const ref = await access.put(text, callId, signal)
    return { output: `${artifactReceipt(ref, complete)}\n\n${preview}\n[显示已截断：${limit}/${text.length} chars]`,
      metadata: { [ARCHIVE_ATTEMPT]: true, artifactRef: ref, artifactComplete: complete } }
  } catch (error) {
    const reason = error instanceof ArtifactStoreError ? error.message
      : signal?.aborted ? '本轮已取消，未发布不完整的归档。' : '本地归档失败，请检查磁盘和私密状态目录。'
    return { output: `[完整输出未归档：${reason}]\n${preview}\n[显示已截断：${limit}/${text.length} chars；工具操作没有重试，勿假定可恢复被省略部分。]`,
      metadata: { [ARCHIVE_ATTEMPT]: true, artifactArchiveError: error instanceof ArtifactStoreError ? error.code : signal?.aborted ? 'aborted' : 'artifact_io_error' } }
  }
}

function governedAccess(ctx) {
  if (!accesses.has(ctx?.artifactAccess)) missingAccess()
  return ctx.artifactAccess
}

export function createArtifactTools() {
  const identity = { artifact_id: { type: 'string', pattern: '^art_[0-9a-f-]{36}$', description: 'Opaque artifact ID returned by this conversation. Never a filesystem path.' },
    cursor: { type: 'string', maxLength: 2048, description: 'Snapshot-bound nextCursor from the previous page. For artifact_read, a search match readCursor jumps directly to that match. Omit for the first page.' } }
  return [{
    name: 'artifact_read',
    description: 'Read an archived tool text without rerunning the operation. Only the current account/project/conversation is accessible. Pages are byte-based; use encoding=base64 for exact byte reconstruction, utf8 for reading. Preserve nextCursor to continue.',
    inputSchema: { type: 'object', properties: { ...identity, limit: { type: 'integer', minimum: 1, maximum: 16000 }, encoding: { type: 'string', enum: ['utf8', 'base64'] } }, required: ['artifact_id'], additionalProperties: false },
    capabilityFor: () => 'read',
    async execute(args, ctx) {
      // JSON can expand control characters sixfold. Reserve envelope/cursor
      // space so reading an artifact never recursively archives its own page.
      const page = await governedAccess(ctx).read({ id: args.artifact_id, cursor: args.cursor, limit: Math.min(Number(args.limit) || 4000, Math.max(1, Math.floor(((ctx.toolResultLimit || 16000) - 1000) / 8))) })
      const content = args.encoding === 'base64' ? page.data : Buffer.from(page.data, 'base64').toString('utf8')
      return { output: JSON.stringify({ ...page, data: content, encoding: args.encoding === 'base64' ? 'base64' : 'utf8',
        ...(args.encoding === 'base64' ? {} : { note: 'UTF-8 display at arbitrary byte boundaries can show replacement characters; base64 preserves exact bytes.' }) }) }
    }
  }, {
    name: 'artifact_search',
    description: 'Search literal UTF-8 text inside an archived tool result in the current conversation. Each match has a readCursor: pass it to artifact_read to read directly at that match. nextCursor continues searching, not reading. Bounded scan; no rerunning tools or regex.',
    inputSchema: { type: 'object', properties: { ...identity, query: { type: 'string', minLength: 1, maxLength: 256 }, max_matches: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['artifact_id', 'query'], additionalProperties: false },
    capabilityFor: () => 'search',
    async execute(args, ctx) {
      // Per-match cursors add bounded metadata; keep the complete search page
      // below the display cap so it does not recursively archive itself.
      const maxMatches = Math.min(args.max_matches || 20, Math.max(1, Math.floor(((ctx.toolResultLimit || 16000) - 1000) / 400)))
      const result = await governedAccess(ctx).search({ id: args.artifact_id, query: args.query, cursor: args.cursor, maxMatches, maxBytes: 1024 * 1024 })
      return { output: JSON.stringify(result) }
    }
  }]
}
