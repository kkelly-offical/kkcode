import { readFile, unlink, writeFile as fsWriteFile } from "node:fs/promises"
import { access } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { buildRequestHeaders } from "../http/identity.mjs"

const execFileAsync = promisify(execFile)

/**
 * 「这是个图片文件吗」—— 本地文件类型识别用的全集。
 * read 工具据此决定走图片分支，输入框据此从文本里认出图片路径。
 * 这里曾经有两份手写拷贝（registry.mjs 一份、本文件一份），内容还不一样：
 * registry 有 .ico、这边没有。现在只此一份，registry.mjs 从这里 import。
 */
export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"
])

export const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
}

/**
 * 「模型收得下吗」—— 与上面那份是两个用途，不能合并。
 * Anthropic 与 OpenAI 都只接受这四种 media type；把 svg/bmp/ico 当 image block
 * 发出去的结果是 API 报错或静默丢弃，前端不会有任何提示。
 */
export const MODEL_IMAGE_MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp"
])

const MODEL_IMAGE_FORMAT_LIST = [...MODEL_IMAGE_MEDIA_TYPES]
  .map((type) => type.split("/")[1])
  .join("/")

export function isModelImageMediaType(mediaType) {
  const normalized = String(mediaType || "").split(";")[0].trim().toLowerCase()
  return MODEL_IMAGE_MEDIA_TYPES.has(normalized)
}

function unsupportedImageBlock(source, mediaType) {
  return {
    type: "text",
    text: `[unsupported image format: ${source} (${mediaType}) — model input accepts ${MODEL_IMAGE_FORMAT_LIST}]`
  }
}

function unrecognizedImageBlock(source) {
  return {
    type: "text",
    text: `[not image data: ${source} — model input accepts ${MODEL_IMAGE_FORMAT_LIST}]`
  }
}

/**
 * 真实格式只能从字节里看，不能信扩展名、content-type 或命令的退出码。
 *
 * 实测过的坑：剪贴板里只有 text/plain 时，`xclip -t image/png -o` **退出码 0**
 * 并把文本原样吐回来。只看退出码的话，`HELLO_FROM_CLIPBOARD` 会被当成 PNG
 * 挂成附件 —— Ctrl+V 的文本回落分支永远走不到，这堆字节还会以 image/png
 * 的身份发给模型。
 *
 * 只认模型收得下的四种；认不出就是认不出，由调用方决定降级还是回落。
 */
const IMAGE_SIGNATURES = [
  { media: "image/png", parts: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]] },
  { media: "image/jpeg", parts: [[0, [0xff, 0xd8, 0xff]]] },
  { media: "image/gif", parts: [[0, [0x47, 0x49, 0x46, 0x38]]] },
  // RIFF....WEBP —— 中间四字节是文件长度，跳过
  { media: "image/webp", parts: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]] }
]

export function sniffImageMediaType(input) {
  let bytes
  try {
    bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  } catch {
    return null
  }
  for (const { media, parts } of IMAGE_SIGNATURES) {
    // 截断输入（不足以放下签名）直接落选，不越界读
    const matched = parts.every(([offset, signature]) =>
      bytes.length >= offset + signature.length &&
      signature.every((byte, index) => bytes[offset + index] === byte))
    if (matched) return media
  }
  return null
}

const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB
const MAX_CLIPBOARD_TEXT_SIZE = 1024 * 1024 // Match execFile's historical 1MB default
const CLIPBOARD_READ_TIMEOUT_MS = 5000

function clipboardReadOptions({ binary = false } = {}) {
  return {
    timeout: CLIPBOARD_READ_TIMEOUT_MS,
    maxBuffer: binary ? MAX_IMAGE_SIZE : MAX_CLIPBOARD_TEXT_SIZE,
    encoding: binary ? "buffer" : "utf8"
  }
}

/**
 * 一次失败到底说明了什么：「剪贴板里没有图」还是「我没能替你判断」。
 *
 * 这个区分决定 Ctrl+V 能不能粘上文字：`editor-keys.mjs` 只在 block 为 null 时
 * 才回落到 `readClipboardText()`，返回 error block 就等于把文本粘贴堵死。
 *
 * 而「没有图」的最常见形态恰恰是**非零退出** —— xclip / wl-paste / pngpaste /
 * osascript / PowerShell 都用它表示「没有你要的这种内容」。此前只特判了
 * ENOENT（命令没装），于是任何一台剪贴板里装着文字的 Linux 机器上，Ctrl+V
 * 都会弹一行红色的 `Command failed: xclip -selection clipboard -t image/png -o`
 * 然后停下。
 *
 * 只有超时与超限配得上 error block：它们意味着我没能判断，而不是没有图。
 */
function classifyClipboardFailure(err) {
  // maxBuffer 超限也会带 killed:true，必须排在超时判定前面
  if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(err?.message || "")) return "too-large"
  if (err?.killed || err?.signal || err?.code === "ETIMEDOUT") return "timeout"
  // 其余一切都是「没有图」：ENOENT（命令没装）、非零退出（命令说没有这个
  // target）、以及任何认不出的形状。
  //
  // 这里刻意**不**为 ENOENT 和非零退出各留一个分支：它们与默认分支的结果
  // 完全一样，写出来也没有任何测试能把它们钉住 —— 那种分支删掉不会红，
  // 属于装点门面的死代码。判据落在结果上：不是超时、不是超限，就回落。
  return "no-image"
}

const MAX_IMAGE_SIZE_MB = MAX_IMAGE_SIZE / 1024 / 1024

/**
 * 给用户看的错误话术。不放命令行 —— `Command failed: xclip -selection clipboard
 * -t image/png -o` 对用户没有任何可操作性，只会吓人。
 */
function clipboardErrorBlock(kind, { bytes } = {}) {
  if (kind === "timeout") return { type: "error", message: "clipboard read timed out" }
  // too-large：拿得到字节数就报出来（超限的本地文件），拿不到就只说上限
  // （stdout 撞上 maxBuffer 时根本没读完）。
  const actual = Number.isFinite(bytes) ? `${Math.round(bytes / 1024 / 1024)}MB, ` : ""
  return { type: "error", message: `clipboard image is too large (${actual}max ${MAX_IMAGE_SIZE_MB}MB)` }
}

export function isImagePath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

export function mimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase()
  return IMAGE_MIME_TYPES[ext] || "application/octet-stream"
}

// 扩展名清单只此一份，正则里的 (png|jpe?g|...) 也从它派生 —— 手写的第三份
// 拷贝迟早会和前两份漂移。长的排前面，免得 jpg 抢在 jpeg 前面截断。
const EXTENSION_ALTERNATION = [...IMAGE_EXTENSIONS]
  .map((ext) => ext.slice(1))
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .join("|")

// 路径起手式：C:\ 、~/ 、./ 、/ 、\ 。~ 只认开头，路径中间的 ~ 不算。
const PATH_START = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|[.\\/])`
// 惰性字符类，后面紧跟一个字面量扩展名 —— 没有嵌套量词，不会灾难性回溯。
const PATH_BODY = String.raw`[\w\-.\\/: ]*?`

/**
 * 还原终端拖拽落下来的路径。
 * GNOME Terminal / iTerm2 在路径含空格时必定加引号或用反斜杠转义空格，
 * 而 `~/` 是用户手打时最自然的写法 —— 三种形态此前一种都进不了图片管线。
 */
export function normalizeDroppedPath(raw, { home = homedir() } = {}) {
  let value = String(raw || "").trim()
  if (!value) return ""
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1)
  }
  // 反斜杠转义的空格还原成真空格；`\` 后面不是空格时（Windows 分隔符）原样保留。
  value = value.replace(/\\ /g, " ")
  if (value === "~") return home
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2))
  return value
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

  const addPath = (ref) => {
    const normalized = normalizeDroppedPath(ref)
    if (!normalized) return
    const resolved = path.resolve(cwd, normalized)
    if (!imagePaths.includes(resolved)) imagePaths.push(resolved)
  }

  // Match @"url" or @url for http(s) URLs with image extensions
  const atUrlPattern = new RegExp(
    String.raw`@"(https?://[^"]+\.(?:${EXTENSION_ALTERNATION})(?:\?[^"]*)?)"|@(https?://\S+\.(?:${EXTENSION_ALTERNATION})(?:\?\S*)?)`,
    "gi"
  )
  let cleaned = raw.replace(atUrlPattern, (match, quoted, bare) => {
    const ref = quoted || bare
    if (ref) imageUrls.push(ref)
    return ""
  })

  // Match @"path" or @path (with or without quotes) for local files
  const atPattern = new RegExp(
    String.raw`@"([^"]+\.(?:${EXTENSION_ALTERNATION}))"|@(\S+\.(?:${EXTENSION_ALTERNATION}))`,
    "gi"
  )
  cleaned = cleaned.replace(atPattern, (match, quoted, bare) => {
    const ref = quoted || bare
    if (ref) addPath(ref)
    return ""
  })

  // Bare http(s) URLs ending in image extensions
  const bareUrlPattern = new RegExp(
    String.raw`https?://\S+\.(?:${EXTENSION_ALTERNATION})(?:\?\S*)?`,
    "gi"
  )
  cleaned = cleaned.replace(bareUrlPattern, (match) => {
    if (!imageUrls.includes(match)) imageUrls.push(match)
    return ""
  })

  // 引号包裹的路径：终端拖拽含空格的文件时，GNOME Terminal / iTerm2 一定这么给。
  // 必须排在 barePattern 前面 —— 否则裸路径规则会从引号内部开始匹配，
  // 把两个引号留在文本里。
  const quotedPathPattern = new RegExp(
    String.raw`"(${PATH_START}[^"\n]*?\.(?:${EXTENSION_ALTERNATION}))"|'(${PATH_START}[^'\n]*?\.(?:${EXTENSION_ALTERNATION}))'`,
    "gi"
  )
  cleaned = cleaned.replace(quotedPathPattern, (match, doubleQuoted, singleQuoted) => {
    const ref = doubleQuoted || singleQuoted
    if (ref) {
      addPath(ref)
      return ""
    }
    return match
  })

  // Also detect bare absolute/relative paths ending in image extensions
  const barePattern = new RegExp(String.raw`${PATH_START}${PATH_BODY}\.(?:${EXTENSION_ALTERNATION})`, "gi")
  cleaned = cleaned.replace(barePattern, (match) => {
    // 规范化只在 addPath 里做一次 —— 在这里再做一遍，addPath 的那份就成了
    // 谁都测不到的死代码，回退验证会对着空气通过。
    const trimmed = match.trim()
    if (trimmed && isImagePath(trimmed)) {
      addPath(trimmed)
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
      // reason/bytes 让调用方不用去解析这句人话 —— 剪贴板那条路要据此判断
      // 「用户确实复制了图，只是太大」，那值得报错，而不是静悄悄当没有图。
      return {
        type: "text",
        reason: "too-large",
        bytes: buffer.length,
        text: `[image too large: ${filePath} (${Math.round(buffer.length / 1024 / 1024)}MB, max ${MAX_IMAGE_SIZE_MB}MB)]`
      }
    }
    // 字节说了算：一个叫 .png 的 JPEG 必须以 image/jpeg 的身份发出去，
    // 按扩展名猜出来的 media type 只是个待核对的声明。
    const sniffed = sniffImageMediaType(buffer)
    if (!sniffed) {
      const declared = mimeType(filePath)
      // svg / bmp / ico 认得出「是图片」，但送进模型只会换来 API 报错或静默丢弃。
      // 在这里降级成说人话的文本，而不是让请求带着一个必然失败的 image block 出门。
      if (isImagePath(filePath) && !isModelImageMediaType(declared)) {
        return unsupportedImageBlock(filePath, declared)
      }
      return unrecognizedImageBlock(filePath)
    }
    return {
      type: "image",
      path: filePath,
      mediaType: sniffed,
      data: buffer.toString("base64")
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
 * Supports Windows (PowerShell), macOS (pngpaste/osascript), Linux
 * (wl-paste with xclip fallback).
 */
export async function readClipboardImage({
  onStatus,
  platform = process.platform,
  executeFile = execFileAsync,
  // 临时目录可注入：测试要能断言「失败时不留垃圾文件」，而扫全局 /tmp
  // 会被并行跑的其它进程干扰。
  tempDir = tmpdir()
} = {}) {
  const tempPath = path.join(tempDir, `kkcode-clip-${Date.now()}.png`)
  const status = typeof onStatus === "function" ? onStatus : () => {}

  try {
    if (platform === "win32") {
      status("reading clipboard...")
      // Use escaped path for PowerShell; try multiple clipboard formats
      const psPath = tempPath.replace(/\\/g, "\\\\").replace(/'/g, "''")
      const psScript = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        `$outPath = '${psPath}'`,
        "$img = [System.Windows.Forms.Clipboard]::GetImage()",
        "if ($img) {",
        "  $img.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)",
        "  Write-Output 'saved'",
        "  exit",
        "}",
        // Fallback: try reading raw clipboard data stream (handles CF_DIB from some screenshot tools)
        "$data = [System.Windows.Forms.Clipboard]::GetDataObject()",
        "if ($data -and $data.GetDataPresent('PNG')) {",
        "  $stream = $data.GetData('PNG')",
        "  $fs = [System.IO.File]::Create($outPath)",
        "  $stream.CopyTo($fs)",
        "  $fs.Close()",
        "  $stream.Close()",
        "  Write-Output 'saved'",
        "  exit",
        "}",
        "if ($data -and $data.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)) {",
        "  $bmp = $data.GetData([System.Windows.Forms.DataFormats]::Bitmap)",
        "  if ($bmp) {",
        "    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)",
        "    Write-Output 'saved'",
        "    exit",
        "  }",
        "}",
        "Write-Output 'empty'"
      ].join("\n")
      const { stdout } = await executeFile("powershell", [
        "-NoProfile", "-NonInteractive", "-Command", psScript
      ], { timeout: 10000 })
      if (!stdout.includes("saved")) {
        status("")
        return null
      }
    } else if (platform === "darwin") {
      status("reading clipboard...")
      try {
        await executeFile("pngpaste", [tempPath], { timeout: 5000 })
      } catch {
        const script = `set theFile to POSIX file "${tempPath}"\ntry\n  set theImage to the clipboard as «class PNGf»\n  set fp to open for access theFile with write permission\n  write theImage to fp\n  close access fp\non error\n  return "empty"\nend try`
        const { stdout } = await executeFile("osascript", ["-e", script], { timeout: 5000 })
        if (stdout.includes("empty")) { status(""); return null }
      }
    } else {
      status("reading clipboard...")
      let result
      try {
        result = await executeFile("wl-paste", [
          "--type", "image/png"
        ], clipboardReadOptions({ binary: true }))
      } catch {
        // 两条命令都失败时不在这里分类 —— 统一由外层 catch 判定，见那里的注释。
        result = await executeFile("xclip", [
          "-selection", "clipboard", "-t", "image/png", "-o"
        ], clipboardReadOptions({ binary: true }))
      }
      if (!result.stdout || !result.stdout.length) { status(""); return null }
      await fsWriteFile(tempPath, result.stdout)
    }

    status("processing image...")
    const block = await readImageAsBlock(tempPath)
    // 落盘的临时文件无论走哪条分支都要清掉，嗅探失败时尤其不能留下垃圾。
    await unlink(tempPath).catch(() => {})
    status("")
    // 字节不是图片就返回 null（不是 error block）—— 三个平台都走这一关。
    // 实测：剪贴板只有 text/plain 时，xclip 退出码 0 却把文本吐回来，
    // 此前它会被原样当成 PNG 附件挂上，Ctrl+V 的文本回落分支永远走不到。
    // 返回 error block 也不行：那会弹一条红字然后停下，同样粘不到文本。
    if (block?.type === "image") return block
    // 唯一的例外：用户**确实**复制了一张图，只是太大。静默回落成粘文本会让人
    // 以为图没复制上，这里必须说出来。
    if (block?.reason === "too-large") return clipboardErrorBlock("too-large", { bytes: block.bytes })
    return null
  } catch (err) {
    await unlink(tempPath).catch(() => {})
    status("")
    // 读剪贴板**失败**几乎总是意味着「剪贴板里没有图片」，而不是出了错：
    //   - ENOENT：这个工具没装
    //   - 非零退出：工具正常跑完，告诉你没有 image/png 这个 target
    //   - 平台脚本走空（osascript 的 on error、PowerShell 的 GetImage 返回 null）
    // 三者都必须回落到文本粘贴 —— `editor-keys.mjs` 的 Ctrl+V **只在返回 null 时**
    // 才去试 readClipboardText()。返回 error block 等于把文本粘贴那条路堵死，
    // 而「剪贴板里装着文字」恰恰是最常见的情况。
    //
    // 只有超时与超限配得上 error block：它们意味着我们没能替用户判断，
    // 或者确实有图但拿不动 —— 不告诉用户就成了「粘了个寂寞」。
    //
    // 认不出形状的失败也按「没有图」处理。代价是真正的内部故障会被静默回落，
    // 但用户看到的最坏结果是「粘了文本」或「剪贴板是空的」，好过一行
    // `Command failed: xclip -selection clipboard -t image/png -o` —— 后者既没有
    // 可操作性，又让粘贴看起来整个是坏的。
    const kind = classifyClipboardFailure(err)
    if (kind === "no-image") return null
    return clipboardErrorBlock(kind)
  }
}

/**
 * Read text from the system clipboard.
 * Returns string or null if clipboard is empty / not text.
 */
export async function readClipboardText({
  platform = process.platform,
  executeFile = execFileAsync
} = {}) {
  try {
    if (platform === "win32") {
      const { stdout } = await executeFile("powershell", [
        "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"
      ], clipboardReadOptions())
      return stdout || null
    } else if (platform === "darwin") {
      const { stdout } = await executeFile("pbpaste", [], clipboardReadOptions())
      return stdout || null
    } else {
      // Generic "text" lets wl-paste select the offered text/plain charset.
      try {
        const { stdout } = await executeFile("wl-paste", [
          "--no-newline", "--type", "text"
        ], clipboardReadOptions())
        return stdout || null
      } catch {
        // Keep the existing X11 fallback chain for mixed/X11 sessions.
        try {
          const { stdout } = await executeFile("xclip", [
            "-selection", "clipboard", "-o"
          ], clipboardReadOptions())
          return stdout || null
        } catch {
          const { stdout } = await executeFile("xsel", [
            "--clipboard", "--output"
          ], clipboardReadOptions())
          return stdout || null
        }
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
    const response = await fetch(url, {
      headers: buildRequestHeaders({ target: "image-fetch", accept: "image/*" }),
      signal: AbortSignal.timeout(15000)
    })
    if (!response.ok) return { type: "text", text: `[image fetch failed: ${url} (${response.status})]` }
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.startsWith("image/")) {
      return { type: "text", text: `[not an image: ${url} (${contentType})]` }
    }
    const declared = contentType.split(";")[0].trim()
    // 声明就收不下的格式，在下载正文之前就拦掉。
    if (!isModelImageMediaType(declared)) return unsupportedImageBlock(url, declared)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_IMAGE_SIZE) {
      return { type: "text", text: `[image too large: ${url} (${Math.round(buffer.length / 1024 / 1024)}MB)]` }
    }
    // content-type 只是服务器的一面之词，最终以字节为准。
    const sniffed = sniffImageMediaType(buffer)
    if (!sniffed) return unrecognizedImageBlock(url)
    return { type: "image", path: url, mediaType: sniffed, data: buffer.toString("base64") }
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
