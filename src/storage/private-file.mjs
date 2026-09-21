import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** Credentials/configuration must never briefly become world-readable or half-written. */
export async function writePrivateFile(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt))
      }
    }
  } finally { await unlink(temporary).catch(() => {}) }
}
