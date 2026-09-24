import { constants } from 'node:fs'
import { open, lstat, mkdir, realpath, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { acquireProcessLock } from './process-lock.mjs'
import { writePrivateFile } from './private-file.mjs'
import { runStoreError } from './run-store-contracts.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const fail = (code, message) => { throw runStoreError(code, message) }
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value)

async function canonicalDestination(directory) {
  let cursor = path.resolve(directory)
  const missing = []
  for (;;) {
    try { return path.join(await realpath(cursor), ...missing.reverse()) }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(cursor) === cursor) throw error
      missing.push(path.basename(cursor)); cursor = path.dirname(cursor)
    }
  }
}
export async function resolveMigrationBackupDirectory(source, directory) {
  const sourceBoundary = await realpath(path.resolve(source)), destination = await canonicalDestination(directory)
  if (destination === sourceBoundary || destination.startsWith(sourceBoundary + path.sep)) fail('MIGRATION_UNSAFE_BACKUP', '备份必须放在原会话目录之外，不能覆盖原件。')
  return destination
}

async function readSnapshot(file, maxBytes = 64 * 1024 * 1024) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > Math.min(maxBytes, 64 * 1024 * 1024)) fail('MIGRATION_UNSAFE_SOURCE', '旧会话来源必须是有限大小的普通文件，不能是链接或超过剩余迁移容量。')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const actual = await handle.stat()
    if (actual.ino !== info.ino || actual.dev !== info.dev) fail('MIGRATION_SOURCE_CHANGED', '读取时来源文件已被替换。')
    const chunks = []; let length = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length
      if (length > Math.min(maxBytes, 64 * 1024 * 1024)) fail('MIGRATION_TOO_LARGE', '读取期间会话内容超出迁移上限，未继续分配内存。')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks, length)
    const after = await handle.stat()
    if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs || bytes.length !== actual.size) fail('MIGRATION_SOURCE_CHANGED', '读取时来源文件发生变化。')
    let value
    try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('MIGRATION_CORRUPT_SOURCE', '旧会话 JSON 损坏，未创建替代历史；请先恢复原件。') }
    return { file, bytes, hash: digest(bytes), value }
  } finally { await handle.close() }
}

function validateData(value) {
  if (!isObject(value) || !Array.isArray(value.messages) || !Array.isArray(value.parts) || value.messages.some(message => !isObject(message)) || value.parts.some(part => !isObject(part))) fail('MIGRATION_CORRUPT_SOURCE', '会话消息或事件结构不完整，迁移已停止。')
}

async function collect(source) {
  const info = await lstat(source)
  if (info.isSymbolicLink()) fail('MIGRATION_UNSAFE_SOURCE', '会话来源不能是链接。')
  const files = [], sessions = []
  let totalBytes = 0
  if (info.isDirectory()) {
    const index = await readSnapshot(path.join(source, 'index.json'))
    if (!isObject(index.value) || index.value.version !== 2 || !isObject(index.value.sessions)) fail('MIGRATION_UNSUPPORTED_SOURCE', '仅支持已知的第二版分片索引；未知版本不能降级导入。')
    files.push(index)
    totalBytes += index.bytes.length
    if (Object.keys(index.value.sessions).length > 10000) fail('MIGRATION_TOO_LARGE', '迁移会话超过10000项，请分批处理。')
    for (const [id, metadata] of Object.entries(index.value.sessions)) {
      if (!sessionId(id) || !isObject(metadata)) fail('MIGRATION_CORRUPT_SOURCE', '会话索引中的标识或元信息无效。')
      const snapshot = await readSnapshot(path.join(source, `${id}.json`), 256 * 1024 * 1024 - totalBytes)
      totalBytes += snapshot.bytes.length
      validateData(snapshot.value)
      files.push(snapshot)
      sessions.push({ id, metadata, ...snapshot.value })
    }
  } else {
    const snapshot = await readSnapshot(source)
    const legacy = snapshot.value
    if (!isObject(legacy) || legacy.version && ![1, 2].includes(legacy.version) || !isObject(legacy.sessions) || !isObject(legacy.messages) || !isObject(legacy.parts)) fail('MIGRATION_UNSUPPORTED_SOURCE', '单文件会话格式未知或不完整，未将损坏数据视为空历史。')
    files.push(snapshot)
    if (Object.keys(legacy.sessions).length > 10000) fail('MIGRATION_TOO_LARGE', '迁移会话超过10000项，请分批处理。')
    for (const [id, metadata] of Object.entries(legacy.sessions)) {
      if (!sessionId(id) || !isObject(metadata)) fail('MIGRATION_CORRUPT_SOURCE', '会话标识或元信息无效。')
      const data = { messages: legacy.messages[id] ?? [], parts: legacy.parts[id] ?? [] }
      validateData(data); sessions.push({ id, metadata, ...data })
    }
  }
  if (sessions.length > 10_000 || files.reduce((sum, item) => sum + item.bytes.length, 0) > 256 * 1024 * 1024) fail('MIGRATION_TOO_LARGE', '迁移快照超过安全容量，请分批处理。')
  return { files, sessions }
}

async function snapshotSource(source) {
  const sourcePath = path.resolve(source), info = await lstat(sourcePath)
  if (info.isSymbolicLink()) fail('MIGRATION_UNSAFE_SOURCE', '会话来源不能是链接。')
  const lockFile = info.isDirectory() ? path.join(sourcePath, '.store.lock') : path.join(path.dirname(sourcePath), 'sessions', '.store.lock')
  const lock = await acquireProcessLock(lockFile)
  let snapshots
  try { snapshots = await collect(sourcePath) } finally { await lock.release() }
  const manifest = { schema: 'kk.session-migration.v1', source: await realpath(sourcePath),
    files: snapshots.files.map((snapshot, index) => ({ name: `${index.toString().padStart(6, '0')}.json`, sourceName: path.basename(snapshot.file), sha256: snapshot.hash, size: snapshot.bytes.length })), historyCompleteness: 'source_snapshot_only' }
  return { snapshots, manifest, migrationId: digest(JSON.stringify(manifest)) }
}
/** Read-only source inspection under the normal session lock; no RunRecord or
 * backup is created. Exact snapshot hash must be rechecked by import. */
export async function inspectLegacySessions(source) {
  const { snapshots, manifest, migrationId } = await snapshotSource(source)
  return { migrationId, source: manifest.source, sessions: snapshots.sessions.length, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), originalPreserved: true, historyCompleteness: manifest.historyCompleteness }
}

async function publishBackup(directory, snapshots, manifest) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077)) fail('MIGRATION_UNSAFE_BACKUP', '备份目录必须是当前用户的私密普通目录。')
  for (let index = 0; index < snapshots.length; index++) {
    const name = `${index.toString().padStart(6, '0')}.json`
    const file = path.join(directory, name)
    try {
      const existing = await readSnapshot(file)
      if (existing.hash !== snapshots[index].hash) fail('MIGRATION_BACKUP_CONFLICT', '已有备份内容不匹配，未覆盖备份。')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const handle = await open(file, 'wx', 0o600)
      try { await handle.writeFile(snapshots[index].bytes); await handle.sync() } finally { await handle.close() }
    }
  }
  const manifestPath = path.join(directory, 'manifest.json')
  try {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (existing.id !== manifest.id || JSON.stringify(existing.files) !== JSON.stringify(manifest.files)) fail('MIGRATION_BACKUP_CONFLICT', '已有备份清单不匹配。')
  } catch (error) { if (error.code !== 'ENOENT') throw error; await writePrivateFile(manifestPath, JSON.stringify(manifest, null, 2)) }
  if (process.platform !== 'win32') { const handle = await open(directory, constants.O_RDONLY); try { await handle.sync() } finally { await handle.close() } }
}

/**
 * Explicit host migration: copy and verify first, never delete or rewrite the
 * original sessions. Imported histories are paused evidence, not approved runs.
 */
export async function importLegacySessions(input) {
  const { source, backupDirectory, store, artifacts, actor, ownerId, expectedMigrationId, expectedBackupDirectory } = input || {}
  if (!source || !backupDirectory || !store?.createRun || !artifacts?.put || !actor?.accountId || !actor?.projectId || !ownerId) fail('MIGRATION_INVALID_INPUT', '必须由宿主提供来源、独立备份目录、账本与账号范围。')
  const sourcePath = path.resolve(source)
  const sourceInfo = await lstat(sourcePath)
  if (sourceInfo.isSymbolicLink()) fail('MIGRATION_UNSAFE_SOURCE', '会话来源不能是链接。')
  const sourceRoot = sourceInfo.isDirectory() ? sourcePath : path.dirname(sourcePath)
  const backupRoot = await resolveMigrationBackupDirectory(sourcePath, backupDirectory)
  if (expectedBackupDirectory !== undefined && path.resolve(expectedBackupDirectory) !== backupRoot) fail('MIGRATION_UNSAFE_BACKUP', '确认后备份目录的实际目标已变化，未导入。')
  const { snapshots, manifest, migrationId } = await snapshotSource(sourcePath)
  if (expectedMigrationId !== undefined && expectedMigrationId !== migrationId) fail('MIGRATION_SOURCE_CHANGED', '来源会话在确认后发生变化；未导入，请重新检查快照。')
  if (await canonicalDestination(backupDirectory) !== backupRoot || await canonicalDestination(backupRoot) !== backupRoot) fail('MIGRATION_UNSAFE_BACKUP', '备份目录别名在核查期间发生变化，未继续写入。')
  const backup = path.join(backupRoot, migrationId)
  await publishBackup(backup, snapshots.files, { ...manifest, id: migrationId })
  const migrationLock = await acquireProcessLock(path.join(backupRoot, `${migrationId}.lock`))
  try {
    const imported = []
    for (const session of snapshots.sessions) {
      const runId = `legacy_${digest(`${migrationId}:${session.id}`).slice(0, 40)}`
      const archiveContent = JSON.stringify({ schema: 'kk.imported-session.v1', migrationId, historyCompleteness: 'source_snapshot_only', session })
      let existing
      try { existing = await store.getRun(runId) } catch (error) { if (error.code !== 'RUN_NOT_FOUND') throw error }
      if (existing) {
        if (existing.binding?.sessionId !== session.id || existing.binding?.accountId !== actor.accountId || existing.binding?.projectId !== actor.projectId || !existing.binding?.importedSessionRef) fail('MIGRATION_TARGET_CONFLICT', '目标导入编号已被其他内容占用。')
        const artifact = await artifacts.getMetadata({ actor: { ...actor, sessionId: session.id, runId }, id: existing.binding.importedSessionRef })
        if (artifact.sha256 !== digest(archiveContent)) fail('MIGRATION_TARGET_CONFLICT', '已有导入产物不匹配原始快照。')
        if (existing.state === 'running') {
          if (existing.actions.length || existing.lastTurn) fail('MIGRATION_TARGET_CONFLICT', '导入记录已经开始执行，不能通过重试迁移改变它。')
          existing = await store.claimRun({ runId, expectedRevision: existing.revision, expectedOwnerId: existing.ownerId, expectedOwnerEpoch: existing.ownerEpoch, ownerId, approval: { approved: true, actorId: ownerId, reason: 'Host retries a verified historical import, not agent execution' } })
        }
        imported.push({ runId, sessionId: session.id, artifactId: existing.binding.importedSessionRef, alreadyImported: true }); continue
      }
      const archive = await artifacts.put({ actor: { ...actor, sessionId: session.id, runId }, content: archiveContent, mime: 'application/json', source: { kind: 'system' } })
      let run = await store.createRun({ id: runId, ownerId, contract: { objective: `Imported conversation ${session.id}; explicit new contract required before execution`, requiredCriteria: [] }, binding: { ...actor, sessionId: session.id, cwd: path.resolve(session.metadata.cwd || sourceRoot), importedSessionRef: archive.id } })
      run = await store.transitionRun({ runId, expectedRevision: run.revision, ownerId, ownerEpoch: run.ownerEpoch, state: 'paused', reason: 'Historical import is not authorization to execute' })
      imported.push({ runId, sessionId: session.id, artifactId: archive.id, alreadyImported: false })
    }
    const result = { migrationId, backupDirectory: backup, imported, originalPreserved: true, historyCompleteness: 'source_snapshot_only' }
    await writePrivateFile(path.join(backup, 'completed.json'), JSON.stringify(result, null, 2))
    return result
  } finally { await migrationLock.release() }
}
