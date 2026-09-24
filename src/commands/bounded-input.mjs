import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

const invalid = (code, message) => Object.assign(new Error(message), { code })
const same = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.isFile() && right.nlink === 1

/** Host CLI JSON input, never an unbounded readFile or a blocking FIFO open.
 * Stat before allocation, pin the ordinary leaf with NOFOLLOW/NONBLOCK, read
 * at most the observed size plus one sentinel byte and recheck both the held
 * identity and the named leaf. Parsing errors never echo file contents. */
export async function readBoundedJsonInput(filename, { maxBytes = 1024 * 1024, label = '输入文件' } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw invalid('CLI_INPUT_LIMIT', '输入读取上限无效。')
  let handle, bytes
  try {
    const target = path.resolve(filename), before = await lstat(target)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw invalid('CLI_INPUT_TYPE', `${label}必须是普通独立文件，不能是目录、符号链接、硬链接或命名管道；请复制为普通文件后重试。`)
    if (before.size > maxBytes) throw invalid('CLI_INPUT_SIZE', `${label}超过 ${maxBytes} 字节上限，未读取内容。`)
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
    const opened = await handle.stat()
    if (!same(before, opened) || opened.size > maxBytes) throw invalid('CLI_INPUT_CHANGED', `${label}在打开时发生变化，已停止。`)
    bytes = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== opened.size || !same(opened, await handle.stat()) || !same(opened, await lstat(target))) throw invalid('CLI_INPUT_CHANGED', `${label}在读取时被替换、增长或修改，结果未使用。`)
    bytes = bytes.subarray(0, length)
  } catch (error) {
    if (String(error.code || '').startsWith('CLI_INPUT_')) throw error
    throw invalid('CLI_INPUT_UNREADABLE', `${label}不存在、不可读取或已发生变化；未执行其中的内容。`)
  } finally { await handle?.close() }
  try { return JSON.parse(bytes.toString('utf8')) }
  catch { throw invalid('CLI_INPUT_JSON', `${label}不是合法 JSON；内容未回显，也未执行。`) }
}
