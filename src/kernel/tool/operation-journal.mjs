import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { userRootDir } from '../../storage/paths.mjs'
import { writePrivateFile } from '../../storage/private-file.mjs'
import { acquireProcessLock } from '../../storage/process-lock.mjs'

const active = new Set()
const hash = value => createHash('sha256').update(value).digest('hex')
function journalPath(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session identifier')
  return path.join(userRootDir(), 'operations', `${sessionId}.json`)
}
async function read(file) {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size > 1024 * 1024 || info.nlink !== 1 || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077))) throw new Error('Operation journal must be a private regular file')
    const value = JSON.parse(await handle.readFile('utf8'))
    if (value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > 512) throw new Error('Invalid operation journal; inspect it locally')
    return value.operations
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  finally { await handle?.close() }
}
async function update(sessionId, change) {
  const file = journalPath(sessionId)
  let lock
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await acquireProcessLock(file + '.lock') }
    catch (error) { if (error.code !== 'device_in_use' || attempt >= 100) throw error; await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  try {
    const rows = await read(file), result = change(rows)
    // Unresolved outcomes are never evicted by capacity management.
    const unresolved = rows.filter(row => ['pending', 'uncertain'].includes(row.state))
    const settled = rows.filter(row => !['pending', 'uncertain'].includes(row.state)).slice(-256)
    await writePrivateFile(file, JSON.stringify({ version: 1, operations: [...settled, ...unresolved] }))
    return result
  } finally { await lock.release() }
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value

export async function beginToolOperation({ sessionId, turnId, tool, args }) {
  if (!sessionId || !turnId) return null
  const fingerprint = hash(JSON.stringify([tool, canonical(args)])), id = randomUUID()
  await update(sessionId, rows => {
    const unresolved = rows.filter(row => ['pending', 'uncertain'].includes(row.state))
    const previous = unresolved.find(row => row.fingerprint === fingerprint)
    if (previous) throw Object.assign(new Error(`Previous ${tool} outcome is unknown (operation ${previous.id}). Do not repeat it blindly. Inspect actual state with read-only tools; the owner can acknowledge inspection with kkcode session operations --id ${sessionId} --resolve ${previous.id} --confirm-inspected.`), { code: 'tool_outcome_unknown' })
    if (unresolved.length >= 32) throw new Error('Too many unresolved operations; inspect the operation journal before continuing mutations')
    rows.push({ id, tool, turnId, fingerprint, state: 'pending', pid: process.pid, host: os.hostname(), updatedAt: Date.now() })
  })
  active.add(id)
  return { id, async finish(state) {
    try { await update(sessionId, rows => { const row = rows.find(item => item.id === id); if (row) Object.assign(row, { state, updatedAt: Date.now() }) }) }
    finally { active.delete(id) }
  } }
}
export async function listToolOperations(sessionId) {
  return (await read(journalPath(sessionId))).map(({ fingerprint, ...row }) => row)
}
export async function resolveToolOperation(sessionId, id, confirmed = false) {
  if (!confirmed) throw new Error('Inspect the actual operation outcome first, then pass --confirm-inspected')
  return update(sessionId, rows => {
    const row = rows.find(item => item.id === id)
    if (!row || !['pending', 'uncertain'].includes(row.state)) throw new Error('No unresolved operation with that id')
    let live = active.has(id)
    if (row.state === 'pending' && row.host === os.hostname() && row.pid !== process.pid) {
      try { process.kill(row.pid, 0); live = true } catch (error) { if (error.code !== 'ESRCH') live = true }
    }
    if (live) throw new Error('This operation may still be executing; wait for its process to finish')
    Object.assign(row, { state: 'acknowledged', updatedAt: Date.now() })
    return { acknowledged: true, id, note: 'Acknowledgement does not undo, verify or replay any action.' }
  })
}
