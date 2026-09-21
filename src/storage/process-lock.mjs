import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdir, writeFile, readFile, link, unlink, rmdir } from 'node:fs/promises'

const busy = message => Object.assign(new Error(message), { code: 'device_in_use', status: 409 })
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
const validOwner = owner => owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid <= 2147483647 && typeof owner.host === 'string' && typeof owner.token === 'string' && /^[0-9a-f-]{36}$/.test(owner.token)

/** Lifetime exclusion: never evict a live process merely because its lock is old. */
export async function acquireProcessLock(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const token = randomUUID(), candidate = `${file}.${process.pid}.${token}.candidate`, recovery = `${file}.recovery`
  const metadata = { token, pid: process.pid, host: os.hostname(), createdAt: Date.now() }
  // Publish a fully written inode atomically, rather than an empty lock whose PID
  // could be missing if the process crashes between open and write.
  await writeFile(candidate, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' })
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await link(candidate, file); return { file, token, async release() { const current = await readFile(file, 'utf8').then(JSON.parse).catch(() => null); if (current?.token === token) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error }) } } }
      catch (error) { if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error }
      let owner
      try { owner = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw busy('Device lock is unreadable; inspect it locally before recovery') }
      if (!validOwner(owner)) throw busy('Device lock metadata is invalid; inspect it locally before recovery')
      if (owner.host !== os.hostname() || alive(owner.pid)) throw busy('Another live process owns this device state; stop its WebUI or remote hub first')
      // One recovery actor only. Without this guard, two stale-lock removers
      // could unlink a newly acquired lock between their read and unlink calls.
      try { await mkdir(recovery, { mode: 0o700 }) } catch { throw busy('Device lock recovery is already in progress; inspect the recovery marker if a recovery process crashed') }
      try {
        const current = await readFile(file, 'utf8').then(JSON.parse).catch(() => null)
        if (validOwner(current) && current.host === os.hostname() && current.token === owner.token && !alive(current.pid)) await unlink(file)
      } finally { await rmdir(recovery) }
    }
    throw busy('Device state was acquired by another process')
  } finally { await unlink(candidate).catch(() => {}) }
}
