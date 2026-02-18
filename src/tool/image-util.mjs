import { readFile, unlink, writeFile as fsWriteFile } from "node:fs/promises"
import { access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"

const execFileAsync = promisify(execFile)

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"
])

const MIME_MAP = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml"
}

const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB

export function isImagePath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

export function mimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase()
  return MIME_MAP[ext] || "application/octet-stream"
}

/**
 * Extract image file references from user input text.
 * Supports:
 *   @path/to/image.png  (explicit file)
 *   @https://example.com/image.png  (explicit URL)
 *   Bare paths ending in image extensions
 *   Bare http(s) URLs ending in image extensions
 * Returns { text, imagePaths, imageUrls } where text has image refs removed.
 */
export function extractImageRefs(text, cwd = process.cwd()) {
  const raw = String(text || "")
  const imagePaths = []
  const imageUrls = []

  // Match @"url" or @url for http(s) URLs with image extensions
  const atUrlPattern = /@"(https?:\/\/[^"]+\.(png|jpe?g|gif|webp|bmp|svg)(?:\?[^"]*)?)"|@(https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|svg)(?:\?\S*)?)/gi
  let cleaned = raw.replace(atUrlPattern, (match, quoted, _e1, bare, _e2) => {
    const ref = quoted || bare
    if (ref) imageUrls.push(ref)
    return ""
  })

  // Match @"path" or @path (with or without quotes) for local files
  const atPattern = /@"([^"]+\.(png|jpe?g|gif|webp|bmp|svg))"|@(\S+\.(png|jpe?g|gif|webp|bmp|svg))/gi
  cleaned = cleaned.replace(atPattern, (match, quoted, _e1, bare, _e2) => {
    const ref = quoted || bare
    if (ref) imagePaths.push(path.resolve(cwd, ref))
    return ""
  })

  // Bare http(s) URLs ending in image extensions
  const bareUrlPattern = /https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|svg)(?:\?\S*)?/gi
  cleaned = cleaned.replace(bareUrlPattern, (match) => {
    if (!imageUrls.includes(match)) imageUrls.push(match)
    return ""
  })

  // Also detect bare absolute/relative paths ending in image extensions
  const barePattern = /(?:(?:[A-Za-z]:[\\\/]|[.\/\\])[\w\-.\\/: ]*?\.(png|jpe?g|gif|webp|bmp|svg))/gi
  cleaned = cleaned.replace(barePattern, (match) => {
    const trimmed = match.trim()
    if (trimmed && isImagePath(trimmed)) {
      const resolved = path.resolve(cwd, trimmed)
      if (!imagePaths.includes(resolved)) imagePaths.push(resolved)
      return ""
    }
    return match
  })

  return {
    text: cleaned.replace(/\s{2,}/g, " ").trim(),
    imagePaths,
    imageUrls
  }
}

/**
 * Read an image file and return a content block.
 * Returns { type: "image", path, mediaType, data } or null on failure.
 */
export async function readImageAsBlock(filePath) {
  try {
    await access(filePath)
    const buffer = await readFile(filePath)
    if (buffer.length > MAX_IMAGE_SIZE) {
      return { type: "text", text: `[image too large: ${filePath} (${Math.round(buffer.length / 1024 / 1024)}MB, max 20MB)]` }
    }
    const data = buffer.toString("base64")
    const media = mimeType(filePath)
    return {
      type: "image",
      path: filePath,
      mediaType: media,
      data
    }
  } catch (err) {
    return { type: "text", text: `[image not found: ${filePath}]` }
  }
}

/**
 * Build content blocks from user text + image paths.
 * Returns an array of content blocks suitable for message.content.
 * If no images, returns the plain text string (backward compatible).
 */
/**
 * Read an image from the system clipboard.
 * Returns a content block { type: "image", mediaType, data } or null if no image.
 * Supports Windows (PowerShell), macOS (pngpaste/osascript), Linux (xclip).
 */
export async function readClipboardImage() {
  const tempPath = path.join(tmpdir(), `kkcode-clip-${Date.now()}.png`)

  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save('${tempPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); 'saved' } else { 'empty' }`
      ], { timeout: 8000 })
      if (!stdout.includes("saved")) return null
    } else if (process.platform === "darwin") {
      try {
        await execFileAsync("pngpaste", [tempPath], { timeout: 5000 })
      } catch {
        const script = `set theFile to POSIX file "${tempPath}"\ntry\n  set theImage to the clipboard as «class PNGf»\n  set fp to open for access theFile with write permission\n  write theImage to fp\n  close access fp\non error\n  return "empty"\nend try`
        const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 5000 })
        if (stdout.includes("empty")) return null
      }
    } else {
      const result = await execFileAsync("xclip", [
        "-selection", "clipboard", "-t", "image/png", "-o"
      ], { timeout: 5000, maxBuffer: MAX_IMAGE_SIZE, encoding: "buffer" })
      if (!result.stdout || !result.stdout.length) return null
      await fsWriteFile(tempPath, result.stdout)
    }

    const block = await readImageAsBlock(tempPath)
    await unlink(tempPath).catch(() => {})
    return block && block.type === "image" ? block : null
  } catch {
    await unlink(tempPath).catch(() => {})
    return null
  }
}

/**
 * Read text from the system clipboard.
 * Returns string or null if clipboard is empty / not text.
 */
export async function readClipboardText() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"
      ], { timeout: 5000 })
      return stdout || null
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("pbpaste", [], { timeout: 5000 })
      return stdout || null
    } else {
      // Try xclip first, fall back to xsel
      try {
        const { stdout } = await execFileAsync("xclip", [
          "-selection", "clipboard", "-o"
        ], { timeout: 5000 })
        return stdout || null
      } catch {
        const { stdout } = await execFileAsync("xsel", [
          "--clipboard", "--output"
        ], { timeout: 5000 })
        return stdout || null
      }
    }
  } catch {
    return null
  }
}

/**
 * Fetch a remote image URL and return a content block.
 * Returns { type: "image_url", url } for provider-native URL support,
 * or fetches + base64-encodes as fallback.
 */
export async function fetchImageUrlAsBlock(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) return { type: "text", text: `[image fetch failed: ${url} (${response.status})]` }
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.startsWith("image/")) {
      return { type: "text", text: `[not an image: ${url} (${contentType})]` }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_IMAGE_SIZE) {
      return { type: "text", text: `[image too large: ${url} (${Math.round(buffer.length / 1024 / 1024)}MB)]` }
    }
    return { type: "image", path: url, mediaType: contentType.split(";")[0], data: buffer.toString("base64") }
  } catch (err) {
    return { type: "text", text: `[image fetch error: ${url} — ${err.message}]` }
  }
}

export async function buildContentBlocks(text, imagePaths = [], imageUrls = []) {
  if (!imagePaths.length && !imageUrls.length) return text

  const blocks = []
  if (text) blocks.push({ type: "text", text })

  for (const imgPath of imagePaths) {
    const block = await readImageAsBlock(imgPath)
    if (block) blocks.push(block)
  }

  for (const url of imageUrls) {
    const block = await fetchImageUrlAsBlock(url)
    if (block) blocks.push(block)
  }

  return blocks
}
