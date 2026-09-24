import path from "node:path"
import { constants } from "node:fs"
import { open, mkdir, lstat, readdir, readlink } from "node:fs/promises"

function unsafe(message = "文件路径包含符号链接或目录已被替换，已停止读取／交付。") {
  return Object.assign(new Error(message), { code: "pinned_scope" })
}
function normalize(error) { return ["ELOOP", "ENOTDIR"].includes(error.code) ? unsafe() : error }

function components(relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || /[\\\x00-\x1f\x7f]/.test(relative)) throw unsafe()
  const parts = relative.split("/")
  if (parts.some(part => !part || part === "." || part === "..")) throw unsafe()
  return parts
}

/** Linux openat equivalent using the kernel's /proc/self/fd directory handles.
 * Every parent is pinned before resolving its child; no user-controlled ancestor
 * is traversed again. O_NOFOLLOW applies to every component, not only the leaf.
 * No path-based fallback is allowed on platforms lacking this primitive. */
function directory(handle) {
  let closed = false
  const fdPath = () => {
    if (closed) throw unsafe("目录句柄已关闭。")
    return `/proc/self/fd/${handle.fd}`
  }
  async function descend(parts, create = false) {
    let current = api, owned = false
    try {
      for (const part of parts) {
        const location = `${current.fdPath()}/${part}`
        if (create) await mkdir(location, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
        const next = directory(await open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW))
        if (owned) await current.close()
        current = next; owned = true
      }
      return current
    } catch (error) { if (owned) await current.close(); throw normalize(error) }
  }
  const api = {
    fdPath,
    async openDirectory(relative) { return descend(components(relative)) },
    async exists(relative) {
      const parts = components(relative), name = parts.pop()
      let parent
      try {
        parent = await descend(parts)
        const stat = await lstat(`${parent.fdPath()}/${name}`)
        if (stat.isSymbolicLink()) throw unsafe()
        return true
      } catch (error) { if (error.code === "ENOENT") return false; throw error }
      finally { if (parent && parent !== api) await parent.close() }
    },
    async openFile(relative, { create = false } = {}) {
      const parts = components(relative), name = parts.pop()
      const parent = await descend(parts)
      try {
        return await open(`${parent.fdPath()}/${name}`,
          (create ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY | constants.O_NONBLOCK) | constants.O_NOFOLLOW, 0o600)
      } catch (error) { throw normalize(error)
      } finally { if (parent !== api) await parent.close() }
    },
    async createDirectory(relative) {
      const parts = components(relative), name = parts.pop()
      const parent = await descend(parts, true)
      try {
        const location = `${parent.fdPath()}/${name}`
        await mkdir(location, { mode: 0o700 })
        const result = directory(await open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW))
        await parent.sync()
        return result
      } finally { if (parent !== api) await parent.close() }
    },
    async list() { return readdir(fdPath()) },
    async sync() { await handle.sync() },
    async close() { if (!closed) { closed = true; await handle.close() } }
  }
  return Object.freeze(api)
}

export async function openPinnedDirectory(absolute) {
  if (process.platform !== "linux" || !constants.O_DIRECTORY || !constants.O_NOFOLLOW || !path.isAbsolute(absolute)) {
    throw unsafe("当前系统缺少安全的目录句柄原语，宿主文件访问已禁用；请使用严格 Linux 容器或受支持的 Linux 宿主。")
  }
  const root = directory(await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW))
  try {
    // Confirm the fd namespace really addresses this process's open directory.
    if (await readlink(root.fdPath()) !== "/") throw unsafe()
    const relative = absolute.slice(1)
    if (!relative) return root
    const result = await root.openDirectory(relative)
    await root.close()
    return result
  } catch (error) { await root.close(); throw error }
}

/** Read through pinned parents and a held leaf descriptor; never reopen a path
 * after checking it. Caller supplies the policy-specific maximum byte count. */
export async function readPinnedFile(root, relative, { maxBytes, signal = null }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw unsafe('文件读取上限无效。')
  signal?.throwIfAborted()
  const directory = await openPinnedDirectory(root)
  let file
  try {
    file = await directory.openFile(relative)
    const before = await file.stat()
    if (!before.isFile() || before.nlink > 1 || before.size > maxBytes) throw unsafe('只允许读取大小受限的普通独立文件。')
    const chunks = []; let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted(); size += chunk.length
      if (size > maxBytes) throw unsafe('文件读取超过安全上限。')
      chunks.push(chunk)
    }
    const after = await file.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw unsafe('文件在读取过程中变化，结果已失效。')
    return Buffer.concat(chunks)
  } finally { await file?.close(); await directory.close() }
}
