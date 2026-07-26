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

/**
 * `extractImageRefs` 的契约是「**绝对路径、当前平台形态**」—— 它最后要交给 fs。
 * 在 Windows 上 `path.resolve("/work", "/home/me/a.png")` 得到 `D:\home\me\a.png`
 * （盘符来自进程 cwd），这是对的，不是 bug。
 *
 * 所以期望值写成「规范化之后**应该长什么样**」的字面量 + 同一个 `path.resolve`：
 * 断言的内容是那个字面量（规范化做对了没有），resolve 只负责把它落到当前平台的
 * 形态上。把 POSIX 形态直接写死，测的就成了「CI 跑在哪个平台」—— 0.7.0 的
 * Windows 格就是这么红的，六条全是同一个原因。
 *
 * 与平台真正无关的那一半（引号剥没剥掉、`\ ` 还原没有、`~` 展开没有、收了几个）
 * 归 `normalizeDroppedPath`，它不碰 node:path，下面直接断言精确字符串。
 */
const resolved = (...refs) => refs.map((ref) => path.resolve(CWD, ref))

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
  assert.deepEqual(single.imagePaths, resolved("/home/me/a.png"))
  assert.equal(single.text, "看看 这张")

  const double = extractImageRefs("看看 \"/home/me/my shot.png\" 这张", CWD)
  assert.deepEqual(double.imagePaths, resolved("/home/me/my shot.png"))
  assert.equal(double.text, "看看 这张")
})

test("反斜杠转义的空格还原成真空格", () => {
  // 拖拽不加引号时，终端会把空格转义成 `\ `。此前这串会被原样 resolve，
  // 得到一个带字面反斜杠的路径 —— 必然读不到文件。
  const result = extractImageRefs("/home/me/my\\ shot.png 这张", CWD)
  assert.deepEqual(result.imagePaths, resolved("/home/me/my shot.png"))
  assert.equal(result.text, "这张")
})

test("开头的 ~/ 展开成 home 目录", () => {
  const result = extractImageRefs("~/pics/a.png 看下", CWD)
  assert.deepEqual(result.imagePaths, resolved(`${os.homedir()}/pics/a.png`))
  assert.equal(result.text, "看下")
})

test("引号与 @ 引用里的 ~/ 和转义空格同样被还原", () => {
  // 规范化必须发生在收集路径的那一处，否则引号分支与 @ 分支各走各的。
  const quotedTilde = extractImageRefs("看 '~/pics/a.png' 好", CWD)
  assert.deepEqual(quotedTilde.imagePaths, resolved(`${os.homedir()}/pics/a.png`))

  const quotedEscape = extractImageRefs("看 \"/tmp/my\\ shot.png\" 好", CWD)
  assert.deepEqual(quotedEscape.imagePaths, resolved("/tmp/my shot.png"))

  const atTilde = extractImageRefs("@~/pics/b.png 好", CWD)
  assert.deepEqual(atTilde.imagePaths, resolved(`${os.homedir()}/pics/b.png`))
})

test("normalizeDroppedPath 只展开开头的 ~，路径中间的 ~ 不动", () => {
  // 期望值是精确字面量而不是 path.join(...) —— 用 path.join 写期望等于让期望跟着
  // 平台走，两边永远相等，`~` 展开这件事本身就没被测到。
  assert.equal(normalizeDroppedPath("~", { home: "/H" }), "/H")
  assert.equal(normalizeDroppedPath("~/pics/a.png", { home: "/H" }), "/H/pics/a.png")
  // 中间的 ~ 与 ~foo 形式（另一个用户的 home）都不能动
  assert.equal(normalizeDroppedPath("/var/tmp~1/a.png", { home: "/H" }), "/var/tmp~1/a.png")
  assert.equal(normalizeDroppedPath("~other/a.png", { home: "/H" }), "~other/a.png")
  // home 自带尾分隔符时不能拼出双分隔符
  assert.equal(normalizeDroppedPath("~/a.png", { home: "/" }), "/a.png")
  assert.equal(normalizeDroppedPath("~\\a.png", { home: "C:\\" }), "C:\\a.png")
})

test("normalizeDroppedPath 对 Windows 形态的输入给 Windows 形态的结果（在 Linux 上也会红）", () => {
  // 这一组喂的全是 Windows 拖拽/手打会产生的串。home 可注入、函数不碰 node:path，
  // 所以它们在 Linux 上一样能跑 —— 不必等 Windows 的 CI 告诉我们。
  //
  // Windows 终端含空格的路径**一定**是加引号的，不是反斜杠转义的。
  assert.equal(normalizeDroppedPath("\"C:\\Users\\me\\a b.png\"", { home: "/H" }), "C:\\Users\\me\\a b.png")
  // `\` 后面不是空格时必须原样保留，否则 Windows 路径会被拆坏
  assert.equal(normalizeDroppedPath("C:\\Users\\me\\a.png", { home: "/H" }), "C:\\Users\\me\\a.png")
  assert.equal(normalizeDroppedPath("\"C:\\Users\\me\\my shot.png\"", { home: "/H" }), "C:\\Users\\me\\my shot.png")
  // `~\` 是 Windows 形态的 home 引用；展开后用的还是用户写的那个分隔符
  assert.equal(normalizeDroppedPath("~\\shots\\a.png", { home: "C:\\Users\\me" }), "C:\\Users\\me\\shots\\a.png")
  // POSIX 那一半：单引号、转义空格
  assert.equal(normalizeDroppedPath("'/home/me/a b.png'", { home: "/H" }), "/home/me/a b.png")
  assert.equal(normalizeDroppedPath("/home/me/my\\ shot.png", { home: "/H" }), "/home/me/my shot.png")
})

test("反斜杠转义空格只在非 Windows 绝对路径上还原", () => {
  // `\ ` 是 POSIX shell 的转义约定。在一条 Windows 绝对路径里，`\ ` 是「分隔符 +
  // 以空格开头的目录名」的合法写法，还原它就是把合法路径拆坏。判据是**形状**
  // （盘符 / UNC）而不是 process.platform，所以两边在任何平台上都测得到。
  assert.equal(normalizeDroppedPath("/home/me/my\\ shot.png", { home: "/H" }), "/home/me/my shot.png")
  assert.equal(normalizeDroppedPath("./my\\ shot.png", { home: "/H" }), "./my shot.png")
  assert.equal(normalizeDroppedPath("~/my\\ shot.png", { home: "/H" }), "/H/my shot.png")
  // 「含反斜杠」不能当判据 —— 上面这几条里就带着反斜杠。只有盘符与 UNC 无歧义。
  assert.equal(normalizeDroppedPath("C:\\Users\\me\\ shot.png", { home: "/H" }), "C:\\Users\\me\\ shot.png")
  assert.equal(normalizeDroppedPath("C:/Users/me/\\ shot.png", { home: "/H" }), "C:/Users/me/\\ shot.png")
  assert.equal(normalizeDroppedPath("\\\\srv\\share\\ shot.png", { home: "/H" }), "\\\\srv\\share\\ shot.png")
  // 引号先剥，规则再看剥完之后的形状
  assert.equal(normalizeDroppedPath("\"D:\\shots\\ a.png\"", { home: "/H" }), "D:\\shots\\ a.png")
})

test("Windows 形态的拖拽路径被认出来，形态不被改写（在 Linux 上也会红）", () => {
  // 正则认不认得盘符路径、引号剥没剥掉，都与运行平台无关 —— 期望值里的字面量
  // 就是「规范化之后的样子」，resolve 只把它落到当前平台形态。
  const quoted = extractImageRefs("看看 \"C:\\Users\\me\\my shot.png\" 这张", CWD)
  assert.deepEqual(quoted.imagePaths, resolved("C:\\Users\\me\\my shot.png"))
  assert.equal(quoted.text, "看看 这张")

  const bare = extractImageRefs("D:\\shots\\a.png 看", CWD)
  assert.deepEqual(bare.imagePaths, resolved("D:\\shots\\a.png"))
  assert.equal(bare.text, "看")

  const at = extractImageRefs("@C:\\shots\\b.jpeg 看", CWD)
  assert.deepEqual(at.imagePaths, resolved("C:\\shots\\b.jpeg"))
  assert.equal(at.text, "看")
})

test("已有的 @ 引用与裸 URL 行为不变", () => {
  const quoted = extractImageRefs("@\"/tmp/with space.png\" 看", CWD)
  assert.deepEqual(quoted.imagePaths, resolved("/tmp/with space.png"))
  assert.equal(quoted.text, "看")

  const relative = extractImageRefs("@shot.jpeg 看", CWD)
  assert.deepEqual(relative.imagePaths, resolved("shot.jpeg"))

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
  assert.deepEqual(result.imagePaths, resolved("/tmp/a.png"))
})

// --- 缺陷 2 · 扩展名清单只此一份 ---

test("正则的扩展名分支从 IMAGE_EXTENSIONS 派生，不是第三份手写拷贝", () => {
  // 枚举驱动：清单里任何一个扩展名都必须能从裸路径、引号路径、@ 引用里认出来。
  for (const ext of IMAGE_EXTENSIONS) {
    const bare = extractImageRefs(`看 /tmp/a${ext} 好`, CWD)
    assert.deepEqual(bare.imagePaths, resolved(`/tmp/a${ext}`), `裸路径漏了 ${ext}`)
    const quoted = extractImageRefs(`看 '/tmp/a${ext}' 好`, CWD)
    assert.deepEqual(quoted.imagePaths, resolved(`/tmp/a${ext}`), `引号路径漏了 ${ext}`)
    const at = extractImageRefs(`看 @/tmp/a${ext} 好`, CWD)
    assert.deepEqual(at.imagePaths, resolved(`/tmp/a${ext}`), `@ 引用漏了 ${ext}`)
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
