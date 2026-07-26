import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { deflateSync } from "node:zlib"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { executeTool } from "../src/tool/executor.mjs"
import { makeToolResult } from "../src/core/types.mjs"

const registryConfig = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }

// 1x1 透明 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
)

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-media-"))
  try {
    await ToolRegistry.initialize({ config: registryConfig, cwd: dir, force: true, allowProjectSources: false })
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 构造一个内容流被 FlateDecode 压缩的 PDF —— 几乎所有现代 PDF 都是这样。 */
function flatePdf(pages) {
  const parts = [Buffer.from("%PDF-1.4\n")]
  pages.forEach((text, index) => {
    const content = Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)
    const z = deflateSync(content)
    parts.push(
      Buffer.from(`${index + 1} 0 obj\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`),
      z,
      Buffer.from("\nendstream\nendobj\n")
    )
  })
  parts.push(Buffer.from("%%EOF\n"))
  return Buffer.concat(parts)
}

test("makeToolResult keeps an image attachment", () => {
  // 此前白名单里没有这个字段，read 返回的 base64 在这里被静默丢弃，
  // 模型只收到一行 `Image file: x.png (12345 bytes)` —— 而工具描述承诺
  // 「可视觉分析」。
  const withImage = makeToolResult({
    name: "read", status: "completed", ok: true,
    image: { data: "AAAA", mediaType: "image/png" }
  })
  assert.deepEqual(withImage.image, { data: "AAAA", mediaType: "image/png" })
  // 没有图片时必须是 null，不能是 undefined 或空对象
  assert.equal(makeToolResult({ name: "read", status: "completed", ok: true }).image, null)
  assert.equal(makeToolResult({ name: "read", status: "completed", ok: true, image: {} }).image, null)
})

test("reading an image reaches the model as an image, not just a byte count", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "dot.png"), TINY_PNG)
    const tool = await ToolRegistry.get("read")
    const result = await executeTool({
      tool, args: { path: "dot.png" }, sessionId: "media", turnId: "t",
      context: { cwd: dir, config: registryConfig }
    })
    assert.ok(result.image, "图片附件必须活着走过 executor")
    assert.equal(result.image.mediaType, "image/png")
    // data URI 前缀要被剥掉 —— provider 层要的是裸 base64
    assert.doesNotMatch(result.image.data, /^data:/)
    assert.equal(Buffer.from(result.image.data, "base64").length, TINY_PNG.length)
    // 文本说明仍然保留，供不支持视觉的模型使用
    assert.match(result.output, /Image file: dot\.png/)
  })
})

test("PDF text is extracted from FlateDecode streams", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "doc.pdf"), flatePdf(["Page one says HELLO", "Page two says WORLD"]))
    const tool = await ToolRegistry.get("read")
    const out = String(await tool.execute({ path: "doc.pdf" }, { cwd: dir, config: registryConfig }))
    // 旧实现按 latin1 解整个文件再抓括号，对压缩流只能抓到乱码
    assert.match(out, /Page one says HELLO/)
    assert.match(out, /Page two says WORLD/)
  })
})

test("the pages parameter actually filters, instead of being declared and ignored", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "doc.pdf"), flatePdf(["FIRST", "SECOND", "THIRD"]))
    const tool = await ToolRegistry.get("read")
    const second = String(await tool.execute({ path: "doc.pdf", pages: "2" }, { cwd: dir, config: registryConfig }))
    assert.match(second, /SECOND/)
    assert.doesNotMatch(second, /FIRST/)
    assert.doesNotMatch(second, /THIRD/)
    // 流与页不是一一对应，报告里必须说清，不能假装 pages 是精确的
    assert.match(second, /do not map 1:1/)

    const range = String(await tool.execute({ path: "doc.pdf", pages: "2-3" }, { cwd: dir, config: registryConfig }))
    assert.match(range, /SECOND/)
    assert.match(range, /THIRD/)
    assert.doesNotMatch(range, /FIRST/)

    const outOfRange = String(await tool.execute({ path: "doc.pdf", pages: "9" }, { cwd: dir, config: registryConfig }))
    assert.match(outOfRange, /no content streams in range 9/)
  })
})

test("a scanned PDF says so instead of returning garbage", async () => {
  await withDir(async (dir) => {
    // DCTDecode = 嵌入 JPEG，没有文本操作符
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 8 /Filter /DCTDecode >>\nstream\n"),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      Buffer.from("\nendstream\nendobj\n%%EOF\n")
    ])
    await writeFile(path.join(dir, "scan.pdf"), pdf)
    const tool = await ToolRegistry.get("read")
    const out = String(await tool.execute({ path: "scan.pdf" }, { cwd: dir, config: registryConfig }))
    assert.match(out, /no extractable text|scanned images/)
    // 关键是不能把 JPEG 字节当正文吐出来
    assert.doesNotMatch(out, /�/)
  })
})
