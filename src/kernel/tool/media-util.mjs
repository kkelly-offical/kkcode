import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_MEDIA_BYTES, mediaBlockError, sniffMediaType } from '../core/media.mjs'
import { readClipboardImage, sniffImageMediaType } from './image-util.mjs'

const executeDefault = promisify(execFile)
const readOptions = { timeout: 5000, maxBuffer: MAX_MEDIA_BYTES + 1, windowsHide: true }
const errorBlock = message => ({ type: 'error', message })

function fromBytes(bytes) {
  if (bytes.length > MAX_MEDIA_BYTES) return errorBlock('Clipboard media exceeds the 20 MiB limit')
  const mediaType = sniffMediaType(bytes)
  if (!mediaType) return errorBlock('The clipboard file is not a supported audio/video file')
  const block = { type: mediaType.startsWith('audio/') ? 'audio' : 'video', mediaType, data: bytes.toString('base64'), bytes: bytes.length }
  const invalid = mediaBlockError(block)
  return invalid ? errorBlock(invalid) : block
}

export async function readMediaFileAsBlock(file) {
  // Clipboard file references are explicitly selected local files, never URLs,
  // Windows UNC paths or remote share lookups that could disclose credentials.
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file) || file.includes('\0')) return errorBlock('Choose a local absolute media file path; network shares are not read from the clipboard')
  let handle
  try {
    const target = await realpath(file)
    if (!(await stat(target)).isFile()) return errorBlock('Clipboard media must be a regular file')
    handle = await open(target, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0))
    const info = await handle.stat()
    if (!info.isFile()) return errorBlock('Clipboard media must be a regular file')
    if (info.size > MAX_MEDIA_BYTES) return errorBlock('Clipboard media exceeds the 20 MiB limit')
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_MEDIA_BYTES + 1))
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > info.size) return errorBlock('The clipboard file changed while being read; copy it again')
    const bytes = buffer.subarray(0, used)
    const imageType = sniffImageMediaType(bytes)
    if (imageType) return { type: 'image', mediaType: imageType, data: bytes.toString('base64'), bytes: bytes.length }
    return fromBytes(bytes)
  } catch {
    return errorBlock('The clipboard media file is missing or unreadable')
  } finally { await handle?.close().catch(() => {}) }
}

function selectedFile(raw, platform) {
  let files
  try {
    files = platform === 'win32' ? JSON.parse(String(raw).trim() || '[]')
      : String(raw).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !['copy', 'cut'].includes(line))
  } catch { return null }
  if (typeof files === 'string') files = [files]
  if (!Array.isArray(files) || !files.length) return null
  if (files.length !== 1) return errorBlock('Copy one media file at a time')
  const value = files[0]
  if (typeof value !== 'string') return null
  if (value.startsWith('file:')) {
    try {
      const url = new URL(value)
      if (url.hostname && url.hostname !== 'localhost') return errorBlock('Network clipboard files are not supported')
      return fileURLToPath(url)
    } catch { return errorBlock('Invalid local clipboard file URL') }
  }
  return platform === 'linux' ? errorBlock('Clipboard file lists must contain local file URLs') : value
}

/** Image screenshots, native copied file references and Linux audio/video MIME targets. */
/** @param {{platform?: string, executeFile?: typeof executeDefault, onStatus?: (status: string) => void, tempDir?: string}} [options] */
export async function readClipboardMedia({ platform = process.platform, executeFile = executeDefault, onStatus, ...imageOptions } = {}) {
  const status = typeof onStatus === 'function' ? onStatus : () => {}
  status('Reading clipboard…')
  try {
    let fileData = null
    if (platform === 'win32') {
      try {
        const script = 'Add-Type -AssemblyName System.Windows.Forms; ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ })'
        fileData = (await executeFile('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], readOptions)).stdout
      } catch { /* Screenshot/text fallback below. */ }
    } else if (platform === 'darwin') {
      try {
        fileData = (await executeFile('osascript', ['-e', 'try\nreturn POSIX path of (the clipboard as alias)\non error\nreturn ""\nend try'], readOptions)).stdout
      } catch { /* Screenshot/text fallback below. */ }
    } else {
      for (const command of ['wl-paste', 'xclip']) {
        try {
          const listArgs = command === 'wl-paste' ? ['--list-types'] : ['-selection', 'clipboard', '-t', 'TARGETS', '-o']
          const types = String((await executeFile(command, listArgs, readOptions)).stdout).split(/\s+/)
          const mime = types.find(type => /^(audio|video)\//.test(type))
            || types.find(type => ['text/uri-list', 'x-special/gnome-copied-files'].includes(type))
          if (!mime) continue
          const args = command === 'wl-paste' ? ['--no-newline', '--type', mime] : ['-selection', 'clipboard', '-t', mime, '-o']
          const { stdout } = await executeFile(command, args, { ...readOptions, encoding: 'buffer' })
          if (/^(audio|video)\//.test(mime)) return fromBytes(Buffer.from(stdout))
          fileData = Buffer.from(stdout).toString('utf8')
          break
        } catch (error) {
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return errorBlock('Clipboard media exceeds the 20 MiB limit')
          if (error.killed || error.code === 'ETIMEDOUT') return errorBlock('Clipboard media read timed out')
        }
      }
    }
    if (fileData) {
      const file = selectedFile(fileData, platform)
      if (typeof file === 'object' && file?.type === 'error') return file
      if (file) return await readMediaFileAsBlock(file)
    }
    return await readClipboardImage({ ...imageOptions, platform, executeFile, onStatus: status })
  } finally { status('') }
}
