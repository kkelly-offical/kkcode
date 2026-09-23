import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { mkdir, open, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { userRootDir } from './paths.mjs'
import { writePrivateFile } from './private-file.mjs'
import { acquireProcessLock } from './process-lock.mjs'

async function privateRead(file, limit) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > limit || process.getuid && (info.uid !== process.getuid() || info.mode & 0o077)) throw new Error('Credential storage must be private and owned by this OS user')
    return await handle.readFile()
  } finally { await handle.close() }
}

/** Local encrypted-at-rest storage; the master key remains private on this OS account. */
export function encryptedStore(namespace, root = path.join(userRootDir(), 'credentials')) {
  const id = createHash('sha256').update(namespace).digest('hex'), file = path.join(root, `${id}.enc`), keyFile = path.join(root, 'master.key')
  async function key() {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const existing = await privateRead(keyFile, 32).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    let value = existing
    if (!value) {
      let lock
      for (let attempt = 0; !lock; attempt++) {
        try { lock = await acquireProcessLock(path.join(root, 'master-key.lock')) }
        catch (error) { if (error.code !== 'device_in_use' || attempt >= 100) throw error; await new Promise(resolve => setTimeout(resolve, 20)) }
      }
      try {
        value = await privateRead(keyFile, 32).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (!value) { value = randomBytes(32); await writePrivateFile(keyFile, value) }
      } finally { await lock.release() }
    }
    if (value.length !== 32) throw new Error('Credential encryption key is invalid; restore the private key backup')
    return value
  }
  async function read() {
    let bytes
    try { bytes = await privateRead(file, 1024 * 1024) } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
    if (bytes.length < 29) throw new Error('Encrypted credentials are invalid')
    try {
      const decipher = createDecipheriv('aes-256-gcm', await key(), bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from(namespace)); decipher.setAuthTag(bytes.subarray(12, 28))
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
    } catch { throw new Error('Encrypted credentials could not be opened; restore their matching private key or log in again') }
  }
  async function update(change) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    let lock
    for (let attempt = 0; !lock; attempt++) {
      try { lock = await acquireProcessLock(`${file}.lock`) }
      catch (error) { if (error.code !== 'device_in_use' || attempt >= 100) throw error; await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    try {
      const next = await change(await read())
      if (next === null) { await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error }); return {} }
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), iv)
      cipher.setAAD(Buffer.from(namespace))
      const body = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()])
      await writePrivateFile(file, Buffer.concat([iv, cipher.getAuthTag(), body]))
      return next
    } finally { await lock.release() }
  }
  return { read, update, clear: () => update(() => null) }
}
