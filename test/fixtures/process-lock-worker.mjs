import { acquireProcessLock } from '../../src/storage/process-lock.mjs'

let lock
process.on('message', async message => {
  try {
    if (message.action === 'acquire') lock = await acquireProcessLock(process.argv[2])
    if (message.action === 'release') { await lock?.release(); lock = null }
    process.send?.({ id: message.id, ok: true, pid: process.pid, token: lock?.token })
  } catch (error) { process.send?.({ id: message.id, ok: false, code: error.code, message: error.message }) }
})
process.on('disconnect', () => process.exit(0))
