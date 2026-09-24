import { DatabaseSync } from 'node:sqlite'
import { constants, mkdirSync, lstatSync, openSync, closeSync, readSync, writeSync, fsyncSync, readFileSync, readdirSync, writeFileSync, realpathSync, linkSync, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { runStoreError } from './run-store-contracts.mjs'

const APP_ID = 0x4b4b5255
const identifier = /^v[12]-[0-9]{10,16}-[a-f0-9-]{36}$/
const fail = message => { throw runStoreError('BACKUP_INVALID', message) }

function privatePath(file, directory = false) {
  const info = lstatSync(file)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || process.getuid && info.uid !== process.getuid() || process.platform !== 'win32' && (info.mode & 0o077)) fail('Backup paths must be private, owned ordinary files and directories')
  return info
}

function fileHash(file) {
  const before = privatePath(file)
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024)
    for (let size; (size = readSync(fd, chunk, 0, chunk.length, null));) hash.update(chunk.subarray(0, size))
    const after = privatePath(file)
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('Backup changed while being verified')
    return { sha256: hash.digest('hex'), size: after.size }
  } finally { closeSync(fd) }
}

function sync(file, directory = false) {
  if (directory && process.platform === 'win32') return
  // Windows FlushFileBuffers requires GENERIC_WRITE. These are files just
  // created by this backup operation, not read-only inspection targets. Open
  // without O_CREAT/O_TRUNC so durability never truncates or recreates them.
  const fd = openSync(file, (directory ? constants.O_RDONLY : constants.O_RDWR) | (constants.O_NOFOLLOW || 0))
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Caller holds BEGIN IMMEDIATE on the live DB. A separate read-only connection
 * obtains a consistent VACUUM snapshot while all competing writes are fenced. */
export function createRunStoreBackup(databaseFile) {
  const root = path.join(path.dirname(databaseFile), 'backups')
  mkdirSync(root, { recursive: true, mode: 0o700 }); privatePath(root, true)
  const source = new DatabaseSync(databaseFile, { readOnly: true })
  let version, id, target
  try {
    source.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=10000')
    version = source.prepare('PRAGMA user_version').get().user_version
    if (![1, 2].includes(version) || source.prepare('PRAGMA application_id').get().application_id !== APP_ID) fail('Cannot back up an unknown run-store schema')
    id = `v${version}-${Date.now()}-${randomUUID()}`
    target = path.join(root, `${id}.sqlite`)
    source.prepare('VACUUM INTO ?').run(target)
  } finally { source.close() }
  sync(target)
  const manifest = { schema: 'kk.run-store-backup.v1', id, version, applicationId: APP_ID, createdAt: Date.now(), ...fileHash(target) }
  const manifestPath = path.join(root, `${id}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
  sync(manifestPath); sync(root, true)
  verifyRunStoreBackup(databaseFile, id)
  return manifest
}

export function listRunStoreBackups(databaseFile) {
  const root = path.join(path.dirname(databaseFile), 'backups')
  try { privatePath(root, true) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return readdirSync(root).filter(name => name.endsWith('.json') && identifier.test(name.slice(0, -5))).sort().map(name => readManifest(root, name.slice(0, -5)))
}

function readManifest(root, id) {
  if (!identifier.test(id)) fail('Invalid backup identifier')
  const file = path.join(root, `${id}.json`)
  if (privatePath(file).size > 4096) fail('Backup manifest is too large')
  let metadata
  try { metadata = JSON.parse(readFileSync(file, 'utf8')) } catch { fail('Backup manifest is unreadable or corrupt') }
  if (!metadata || metadata.schema !== 'kk.run-store-backup.v1' || metadata.id !== id || ![1, 2].includes(metadata.version) || metadata.applicationId !== APP_ID || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.size) || metadata.size < 1) fail('Backup manifest does not describe a supported complete snapshot')
  return metadata
}

export function verifyRunStoreBackup(databaseFile, id) {
  const root = path.join(path.dirname(databaseFile), 'backups')
  privatePath(root, true)
  const manifest = readManifest(root, id), file = path.join(root, `${id}.sqlite`)
  for (const suffix of ['-wal', '-journal']) {
    try { if (privatePath(file + suffix).size) fail('Backup has unsealed journal data and is not a self-contained snapshot') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const observed = fileHash(file)
  if (observed.sha256 !== manifest.sha256 || observed.size !== manifest.size) fail('Backup checksum does not match; do not restore it')
  const backup = new DatabaseSync(file, { readOnly: true })
  try {
    backup.exec('PRAGMA trusted_schema=OFF')
    if (backup.prepare('PRAGMA user_version').get().user_version !== manifest.version || backup.prepare('PRAGMA application_id').get().application_id !== APP_ID || backup.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok') || backup.prepare('PRAGMA foreign_key_check').all().length) fail('Backup SQLite integrity check failed')
    const count = backup.prepare('SELECT COUNT(*) AS count FROM runs').get().count
    return { ...manifest, valid: true, runCount: count }
  } finally { backup.close() }
}

/** Restore into a new directory only. Never overwrite an active database. */
export function restoreRunStoreBackup(databaseFile, id, targetDirectory) {
  if (typeof targetDirectory !== 'string' || !path.isAbsolute(targetDirectory)) fail('Restore requires an explicit absolute new directory')
  let target = path.resolve(targetDirectory)
  if ([path.parse(target).root, path.resolve(os.homedir()), path.resolve(os.tmpdir())].includes(target)) fail('Restore target cannot be a broad system or home directory')
  const manifest = verifyRunStoreBackup(databaseFile, id)
  mkdirSync(target, { recursive: true, mode: 0o700 }); privatePath(target, true)
  target = realpathSync(target)
  if ([path.parse(target).root, realpathSync(os.homedir()), realpathSync(os.tmpdir())].includes(target) || readdirSync(target).length) fail('Restore requires an empty private directory')
  const temporary = path.join(target, `.restore-${randomUUID()}`)
  const source = path.join(path.dirname(databaseFile), 'backups', `${id}.sqlite`)
  const from = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  let to, failure
  try {
    to = openSync(temporary, 'wx', 0o600)
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    for (let size; (size = readSync(from, buffer, 0, buffer.length, null));) {
      const chunk = buffer.subarray(0, size); digest.update(chunk)
      for (let offset = 0; offset < size;) offset += writeSync(to, chunk, offset, size - offset)
    }
    if (digest.digest('hex') !== manifest.sha256) fail('Backup changed during restore')
    fsyncSync(to)
    linkSync(temporary, path.join(target, 'runs.sqlite')) // Atomic no-overwrite publication.
  } catch (error) { failure = error }
  for (const fd of [from, to]) if (fd !== undefined) { try { closeSync(fd) } catch (error) { failure ||= error } }
  try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') failure ||= error }
  if (failure) throw failure
  sync(target, true)
  return { restored: true, directory: target, backupId: id, version: manifest.version, sha256: manifest.sha256 }
}
