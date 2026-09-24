import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createRunStoreBackup, restoreRunStoreBackup } from '../../src/storage/run-store-backup.mjs'

const [file, destination] = process.argv.slice(2)
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
  assert.equal(restoreRunStoreBackup(file, backup.id, destination).restored, true)
  console.log(JSON.stringify({ version: backup.version, writableFileFlushes }))
} finally { fs.fsyncSync = realFsync; syncBuiltinESMExports() }
