import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { createRunStoreBackup, restoreRunStoreBackup } from '../../src/storage/run-store-backup.mjs'

const [file, destination, mask] = process.argv.slice(2)
assert.match(mask, /^(?:077|022)$/)
process.umask(Number.parseInt(mask, 8))
const readonly = fs.openSync(file, 'r')
try { assert.throws(() => fs.writeSync(readonly, Buffer.alloc(0)), 'portability check must reject the old read-only handle') }
finally { fs.closeSync(readonly) }
const realFsync = fs.fsyncSync
let writableFileFlushes = 0
fs.fsyncSync = fd => {
  if (fs.fstatSync(fd).isFile()) {
    // The zero-byte write checks handle access on POSIX too; it changes no
    // bytes. The real native fsync still executes, including on Windows CI.
    assert.equal(fs.writeSync(fd, Buffer.alloc(0)), 0)
    writableFileFlushes++
  }
  return realFsync(fd)
}
syncBuiltinESMExports()
try {
  const backup = createRunStoreBackup(file)
  const snapshotMode = fs.lstatSync(path.join(path.dirname(file), 'backups', `${backup.id}.sqlite`)).mode & 0o777
  if (process.platform !== 'win32') assert.equal(snapshotMode, 0o600, 'VACUUM output must remain private independently of umask')
  assert.equal(restoreRunStoreBackup(file, backup.id, destination).restored, true)
  const restoredMode = fs.lstatSync(path.join(destination, 'runs.sqlite')).mode & 0o777
  if (process.platform !== 'win32') assert.equal(restoredMode, 0o600)
  console.log(JSON.stringify({ version: backup.version, writableFileFlushes, umask: process.umask(), snapshotMode, restoredMode }))
} finally { fs.fsyncSync = realFsync; syncBuiltinESMExports() }
