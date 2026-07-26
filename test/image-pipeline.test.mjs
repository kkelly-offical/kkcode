import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import {
  IMAGE_EXTENSIONS,
  IMAGE_MIME_TYPES,
  MODEL_IMAGE_MEDIA_TYPES,
  extractImageRefs,
  fetchImageUrlAsBlock,
  isImagePath,
  isModelImageMediaType,
  mimeType,
  normalizeDroppedPath,
  readImageAsBlock,
  sniffImageMediaType
} from "../src/tool/image-util.mjs"
import { ToolRegistry } from "../src/tool/registry.mjs"

const CWD = "/work"

// 1x1 透明 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
)

// 只要头几个字节是真的就够 —— 嗅探看的就是这几个字节。
const header = (bytes, body = "body") => Buffer.concat([Buffer.from(bytes), Buffer.from(body)])
const FIXTURES = {
  png: TINY_PNG,
  jpeg: header([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  gif: header([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  webp: Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]), // 长度字段，嗅探必须跳过它
    Buffer.from("WEBPVP8 body")
  ]),
  bmp: header([0x42, 0x4d, 0x36, 0x00]),
  ico: header([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]),
  text: Buffer.from("HELLO_FROM_CLIPBOARD")
}

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-image-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// --- 缺陷 3 · 拖拽进终端的路径形态 ---

test("终端拖拽的引号路径被识别，引号不留在文本里", () => {
  // GNOME Terminal / iTerm2 在路径含空格时必定加引号。此前 barePattern 从引号
  // 内部开始匹配，路径能拿到，但两个引号会留在发给模型的文本里。
  const single = extractImageRefs("看看 '/home/me/a.png' 这张", CWD)
  assert.deepEqual(single.imagePaths, ["/home/me/a.png"])
  assert.equal(single.text, "看看 这张")

  const double = extractImageRefs("看看 \"/home/me/my shot.png\" 这张", CWD)
  assert.deepEqual(double.imagePaths, ["/home/me/my shot.png"])
  assert.equal(double.text, "看看 这张")
})

test("反斜杠转义的空格还原成真空格", () => {
  // 拖拽不加引号时，终端会把空格转义成 `\ `。此前这串会被原样 resolve，
  // 得到一个带字面反斜杠的路径 —— 必然读不到文件。
  const result = extractImageRefs("/home/me/my\\ shot.png 这张", CWD)
  assert.deepEqual(result.imagePaths, ["/home/me/my shot.png"])
  assert.equal(result.text, "这张")
})

test("开头的 ~/ 展开成 home 目录", () => {
  const result = extractImageRefs("~/pics/a.png 看下", CWD)
  assert.deepEqual(result.imagePaths, [path.join(os.homedir(), "pics/a.png")])
  assert.equal(result.text, "看下")
})

test("引号与 @ 引用里的 ~/ 和转义空格同样被还原", () => {
  // 规范化必须发生在收集路径的那一处，否则引号分支与 @ 分支各走各的。
  const quotedTilde = extractImageRefs("看 '~/pics/a.png' 好", CWD)
  assert.deepEqual(quotedTilde.imagePaths, [path.join(os.homedir(), "pics/a.png")])

  const quotedEscape = extractImageRefs("看 \"/tmp/my\\ shot.png\" 好", CWD)
  assert.deepEqual(quotedEscape.imagePaths, ["/tmp/my shot.png"])

  const atTilde = extractImageRefs("@~/pics/b.png 好", CWD)
  assert.deepEqual(atTilde.imagePaths, [path.join(os.homedir(), "pics/b.png")])
})

test("normalizeDroppedPath 只展开开头的 ~，路径中间的 ~ 不动", () => {
  assert.equal(normalizeDroppedPath("~", { home: "/H" }), "/H")
  assert.equal(normalizeDroppedPath("~/pics/a.png", { home: "/H" }), path.join("/H", "pics/a.png"))
  assert.equal(normalizeDroppedPath("~\\pics\\a.png", { home: "/H" }), path.join("/H", "pics\\a.png"))
  // 中间的 ~ 与 ~foo 形式（另一个用户的 home）都不能动
  assert.equal(normalizeDroppedPath("/var/tmp~1/a.png", { home: "/H" }), "/var/tmp~1/a.png")
  assert.equal(normalizeDroppedPath("~other/a.png", { home: "/H" }), "~other/a.png")
})

test("normalizeDroppedPath 不把 Windows 分隔符当成转义符", () => {
  // `\` 后面不是空格时必须原样保留，否则 Windows 路径会被拆坏。
  assert.equal(normalizeDroppedPath("C:\\Users\\me\\a.png", { home: "/H" }), "C:\\Users\\me\\a.png")
  assert.equal(normalizeDroppedPath("\"C:\\Users\\me\\my shot.png\"", { home: "/H" }), "C:\\Users\\me\\my shot.png")
  assert.equal(normalizeDroppedPath("C:\\Users\\me\\my\\ shot.png", { home: "/H" }), "C:\\Users\\me\\my shot.png")
})

test("已有的 @ 引用与裸 URL 行为不变", () => {
  const quoted = extractImageRefs("@\"/tmp/with space.png\" 看", CWD)
  assert.deepEqual(quoted.imagePaths, ["/tmp/with space.png"])
  assert.equal(quoted.text, "看")

  const relative = extractImageRefs("@shot.jpeg 看", CWD)
  assert.deepEqual(relative.imagePaths, [path.resolve(CWD, "shot.jpeg")])

  const atUrl = extractImageRefs("@https://ex.com/a.png 看", CWD)
  assert.deepEqual(atUrl.imageUrls, ["https://ex.com/a.png"])
  assert.deepEqual(atUrl.imagePaths, [])

  const bareUrl = extractImageRefs("https://ex.com/b.gif 看", CWD)
  assert.deepEqual(bareUrl.imageUrls, ["https://ex.com/b.gif"])

  // 没有图片的文本不能被改动
  assert.deepEqual(extractImageRefs("没有图片 just text", CWD), {
    text: "没有图片 just text",
    imagePaths: [],
    imageUrls: []
  })
})

test("同一路径出现多次只收一份", () => {
  const result = extractImageRefs("/tmp/a.png 和 '/tmp/a.png'", CWD)
  assert.deepEqual(result.imagePaths, ["/tmp/a.png"])
})

// --- 缺陷 2 · 扩展名清单只此一份 ---

test("正则的扩展名分支从 IMAGE_EXTENSIONS 派生，不是第三份手写拷贝", () => {
  // 枚举驱动：清单里任何一个扩展名都必须能从裸路径、引号路径、@ 引用里认出来。
  for (const ext of IMAGE_EXTENSIONS) {
    const bare = extractImageRefs(`看 /tmp/a${ext} 好`, CWD)
    assert.deepEqual(bare.imagePaths, [`/tmp/a${ext}`], `裸路径漏了 ${ext}`)
    const quoted = extractImageRefs(`看 '/tmp/a${ext}' 好`, CWD)
    assert.deepEqual(quoted.imagePaths, [`/tmp/a${ext}`], `引号路径漏了 ${ext}`)
    const at = extractImageRefs(`看 @/tmp/a${ext} 好`, CWD)
    assert.deepEqual(at.imagePaths, [`/tmp/a${ext}`], `@ 引用漏了 ${ext}`)
    assert.equal(isImagePath(`/tmp/a${ext}`), true, `isImagePath 漏了 ${ext}`)
  }
})

test("每个可识别扩展名都有 MIME，模型白名单是其中的真子集", () => {
  for (const ext of IMAGE_EXTENSIONS) {
    const media = IMAGE_MIME_TYPES[ext]
    assert.ok(media, `${ext} 缺 MIME 映射`)
    assert.equal(mimeType(`/tmp/x${ext}`), media)
  }
  const known = new Set(Object.values(IMAGE_MIME_TYPES))
  for (const media of MODEL_IMAGE_MEDIA_TYPES) {
    assert.ok(known.has(media), `${media} 不在扩展名 MIME 表里`)
  }
  // 识别集必须严格大于模型白名单 —— 两个集合服务两个用途，不能合并
  assert.ok(MODEL_IMAGE_MEDIA_TYPES.size < known.size)
  assert.equal(MODEL_IMAGE_MEDIA_TYPES.has("image/svg+xml"), false)
  assert.equal(isModelImageMediaType("image/PNG"), true)
  assert.equal(isModelImageMediaType("image/jpeg; charset=binary"), true)
  assert.equal(isModelImageMediaType("image/x-icon"), false)
  assert.equal(isModelImageMediaType(""), false)
})

test("registry 的 read 与 image-util 用同一份扩展名清单", async () => {
  // 这里曾经是两份手写拷贝：registry 有 .ico、image-util 没有，
  // image-util 把 .svg 映射成 image/svg+xml —— 靠记忆同步，实际已经漂移。
  await withDir(async (dir) => {
    await ToolRegistry.initialize({
      config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } },
      cwd: dir,
      force: true,
      allowProjectSources: false
    })
    const tool = await ToolRegistry.get("read")
    for (const ext of IMAGE_EXTENSIONS) {
      const name = `probe${ext}`
      await writeFile(path.join(dir, name), TINY_PNG)
      const result = await tool.execute({ path: name }, { cwd: dir, config: {} })
      assert.equal(result?.type, "image", `read 不认 ${ext}`)
      assert.equal(
        result.data.startsWith(`data:${IMAGE_MIME_TYPES[ext]};base64,`),
        true,
        `read 给 ${ext} 的 MIME 与 image-util 不一致: ${result.data.slice(0, 40)}`
      )
    }
  })
})

// --- 缺陷 2 · 模型收不下的格式在送进模型前降级 ---

test("readImageAsBlock: png/jpeg/gif/webp 照常返回 image block", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "dot.png")
    await writeFile(file, TINY_PNG)
    const block = await readImageAsBlock(file)
    assert.equal(block.type, "image")
    assert.equal(block.mediaType, "image/png")
    assert.equal(block.path, file)
    assert.equal(Buffer.from(block.data, "base64").length, TINY_PNG.length)
  })
})

test("readImageAsBlock: svg/bmp/ico 降级成说人话的文本，不是必然失败的 image block", async () => {
  await withDir(async (dir) => {
    const svg = path.join(dir, "logo.svg")
    await writeFile(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
    const block = await readImageAsBlock(svg)
    assert.equal(block.type, "text", "svg 不该以 image block 身份进入请求")
    assert.equal(
      block.text,
      `[unsupported image format: ${svg} (image/svg+xml) — model input accepts png/jpeg/gif/webp]`
    )

    for (const [name, media, bytes] of [
      ["icon.ico", "image/x-icon", FIXTURES.ico],
      ["old.bmp", "image/bmp", FIXTURES.bmp]
    ]) {
      const file = path.join(dir, name)
      await writeFile(file, bytes)
      const other = await readImageAsBlock(file)
      assert.equal(other.type, "text", `${name} 不该以 image block 身份进入请求`)
      assert.equal(other.text.includes(`(${media})`), true, other.text)
      assert.equal(other.text.includes("png/jpeg/gif/webp"), true, other.text)
    }
  })
})

// --- 缺陷 4 · 字节说了算 ---

test("sniffImageMediaType: 四种真实魔数各自认得出来", () => {
  assert.equal(sniffImageMediaType(FIXTURES.png), "image/png")
  assert.equal(sniffImageMediaType(FIXTURES.jpeg), "image/jpeg")
  assert.equal(sniffImageMediaType(FIXTURES.gif), "image/gif")
  assert.equal(sniffImageMediaType(FIXTURES.webp), "image/webp")
  // 嗅探只认模型收得下的四种，认出来的一定在白名单里
  for (const media of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    assert.equal(MODEL_IMAGE_MEDIA_TYPES.has(media), true)
  }
})

test("sniffImageMediaType: 纯文本、非图片格式、截断输入都返回 null 且不崩", () => {
  // 这就是实测复现的最小化：xclip 在剪贴板只有 text/plain 时退出码 0 却吐回文本。
  assert.equal(sniffImageMediaType(FIXTURES.text), null)
  assert.equal(sniffImageMediaType(FIXTURES.bmp), null)
  assert.equal(sniffImageMediaType(FIXTURES.ico), null)
  assert.equal(sniffImageMediaType(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")), null)
  // 截断：少于 8 字节，甚至空、null
  assert.equal(sniffImageMediaType(FIXTURES.png.subarray(0, 7)), null, "截断的 PNG 头不算 PNG")
  assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8])), null, "截断的 JPEG 头不算 JPEG")
  assert.equal(sniffImageMediaType(Buffer.from("RIFF1234")), null, "只有 RIFF 没有 WEBP 不算 webp")
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), null)
  assert.equal(sniffImageMediaType(null), null)
  assert.equal(sniffImageMediaType(undefined), null)
})

test("readImageAsBlock: 扩展名撒谎时以字节为准", async () => {
  await withDir(async (dir) => {
    // 一个叫 .png 的 JPEG：此前会带着 media_type: image/png 发出去
    const liar = path.join(dir, "shot.png")
    await writeFile(liar, FIXTURES.jpeg)
    const block = await readImageAsBlock(liar)
    assert.equal(block.type, "image")
    assert.equal(block.mediaType, "image/jpeg", "media type 必须来自字节，不是扩展名")

    // 一个叫 .ico 的真 PNG：字节是模型收得下的，就该发出去
    const misnamed = path.join(dir, "icon.ico")
    await writeFile(misnamed, FIXTURES.png)
    const ok = await readImageAsBlock(misnamed)
    assert.equal(ok.type, "image")
    assert.equal(ok.mediaType, "image/png")
  })
})

test("readImageAsBlock: 顶着图片扩展名的非图片字节不会伪装成 image block", async () => {
  await withDir(async (dir) => {
    const fake = path.join(dir, "notes.png")
    await writeFile(fake, FIXTURES.text)
    const block = await readImageAsBlock(fake)
    assert.equal(block.type, "text", "文本字节不能以 image/png 的身份发给模型")
    assert.equal(block.text, `[not image data: ${fake} — model input accepts png/jpeg/gif/webp]`)
  })
})

test("readImageAsBlock: 文件不存在仍然是原来的提示", async () => {
  const block = await readImageAsBlock(path.join(os.tmpdir(), "kkcode-nope-9182.png"))
  assert.equal(block.type, "text")
  assert.equal(block.text.startsWith("[image not found:"), true, block.text)
})

function stubImageResponse(contentType, bytes) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
  })
}

test("fetchImageUrlAsBlock: 白名单内的远程图片照常返回 image block", async () => {
  const original = globalThis.fetch
  globalThis.fetch = stubImageResponse("image/jpeg", FIXTURES.jpeg)
  try {
    const block = await fetchImageUrlAsBlock("https://ex.com/a.jpg")
    assert.equal(block.type, "image")
    assert.equal(block.mediaType, "image/jpeg")
    assert.equal(Buffer.from(block.data, "base64").length, FIXTURES.jpeg.length)
  } finally {
    globalThis.fetch = original
  }
})

test("fetchImageUrlAsBlock: content-type 与字节不符时以字节为准", async () => {
  const original = globalThis.fetch
  globalThis.fetch = stubImageResponse("image/png", FIXTURES.gif)
  try {
    const block = await fetchImageUrlAsBlock("https://ex.com/a.png")
    assert.equal(block.type, "image")
    assert.equal(block.mediaType, "image/gif", "content-type 只是服务器的一面之词")
  } finally {
    globalThis.fetch = original
  }
})

test("fetchImageUrlAsBlock: 声明是图片但正文不是图片 → 不伪装成 image block", async () => {
  const original = globalThis.fetch
  globalThis.fetch = stubImageResponse("image/png", FIXTURES.text)
  try {
    const block = await fetchImageUrlAsBlock("https://ex.com/a.png")
    assert.equal(block.type, "text")
    assert.equal(block.text, "[not image data: https://ex.com/a.png — model input accepts png/jpeg/gif/webp]")
  } finally {
    globalThis.fetch = original
  }
})

test("fetchImageUrlAsBlock: image/svg+xml 在下载正文之前就被拦下", async () => {
  const original = globalThis.fetch
  let bodyRead = false
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/svg+xml; charset=utf-8" },
    arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(8) }
  })
  try {
    const block = await fetchImageUrlAsBlock("https://ex.com/logo.svg")
    assert.equal(block.type, "text")
    assert.equal(
      block.text,
      "[unsupported image format: https://ex.com/logo.svg (image/svg+xml) — model input accepts png/jpeg/gif/webp]"
    )
    assert.equal(bodyRead, false, "拦下的格式不该再下载正文")
  } finally {
    globalThis.fetch = original
  }
})

test("fetchImageUrlAsBlock: 非图片响应仍然是原来的提示", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
    arrayBuffer: async () => new ArrayBuffer(0)
  })
  try {
    const block = await fetchImageUrlAsBlock("https://ex.com/page.png")
    assert.equal(block.type, "text")
    assert.equal(block.text.startsWith("[not an image:"), true, block.text)
  } finally {
    globalThis.fetch = original
  }
})
