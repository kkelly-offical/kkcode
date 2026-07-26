import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import {
  readClipboardImage,
  readClipboardText
} from "../src/tool/image-util.mjs"

// 剪贴板里拿到的字节必须真的是图片。fixture 也得是真的 —— 用 "mock png" 这种
// 文本当图片，测出来的就只是「代码没看字节」这个 bug 本身。
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const pngBytes = (body) => Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from(body)])

const IMAGE_OPTIONS = {
  timeout: 5000,
  maxBuffer: 20 * 1024 * 1024,
  encoding: "buffer"
}

const TEXT_OPTIONS = {
  timeout: 5000,
  maxBuffer: 1024 * 1024,
  encoding: "utf8"
}

function commandError(message, { code = "ENOENT", stderr = "" } = {}) {
  return Object.assign(new Error(message), { code, stderr })
}

test("Linux clipboard image prefers wl-paste with an explicit image MIME", async () => {
  const calls = []
  const image = pngBytes("mock png")
  const block = await readClipboardImage({
    platform: "linux",
    async executeFile(command, args, options) {
      calls.push({ command, args, options })
      return { stdout: image }
    }
  })

  assert.equal(block?.type, "image")
  assert.equal(block?.mediaType, "image/png")
  assert.equal(block?.data, image.toString("base64"))
  assert.deepEqual(calls, [{
    command: "wl-paste",
    args: ["--type", "image/png"],
    options: IMAGE_OPTIONS
  }])
})

test("Linux clipboard image falls back to xclip when wl-paste is unavailable", async () => {
  const calls = []
  const image = pngBytes("xclip png")
  const block = await readClipboardImage({
    platform: "linux",
    async executeFile(command, args, options) {
      calls.push({ command, args, options })
      if (command === "wl-paste") throw commandError("spawn wl-paste ENOENT")
      return { stdout: image }
    }
  })

  assert.equal(block?.type, "image")
  assert.equal(block?.data, image.toString("base64"))
  assert.deepEqual(calls, [
    {
      command: "wl-paste",
      args: ["--type", "image/png"],
      options: IMAGE_OPTIONS
    },
    {
      command: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
      options: IMAGE_OPTIONS
    }
  ])
})

test("missing Wayland image MIME returns null so Ctrl+V can try text", async () => {
  const calls = []
  const statuses = []
  const block = await readClipboardImage({
    platform: "linux",
    onStatus: (status) => statuses.push(status),
    async executeFile(command, args, options) {
      calls.push({ command, args, options })
      if (command === "wl-paste") {
        throw commandError("localized MIME error", { code: 1 })
      }
      throw commandError("spawn xclip ENOENT")
    }
  })

  assert.equal(block, null)
  assert.deepEqual(calls.map(({ command }) => command), ["wl-paste", "xclip"])
  assert.deepEqual(statuses, ["reading clipboard...", ""])
})

/**
 * 三个平台各自把字节送到哪：linux 从 stdout 拿，win32/darwin 由外部命令直接
 * 写进临时文件。要覆盖「文本被当成图片」这条，三条路都得喂得进去。
 */
function platformStub(platform, bytes) {
  return async (command, args) => {
    if (platform === "win32") {
      const script = args[args.length - 1]
      const outPath = /\$outPath = '([^']+)'/.exec(script)?.[1]
      assert.ok(outPath, "powershell 脚本里必须有 $outPath")
      await writeFile(outPath, bytes)
      return { stdout: "saved" }
    }
    if (platform === "darwin") {
      assert.equal(command, "pngpaste")
      await writeFile(args[0], bytes)
      return { stdout: "" }
    }
    return { stdout: bytes }
  }
}

/** 剪贴板为空时，三个平台各自的「成功但没有图」形态。 */
function emptyStub(platform) {
  return async (command) => {
    if (platform === "win32") return { stdout: "empty" }        // PowerShell 脚本走到最后一行
    if (platform === "darwin") {
      if (command === "pngpaste") throw commandError("spawn pngpaste ENOENT")
      return { stdout: "empty" }                                 // osascript 的 on error 分支
    }
    return { stdout: Buffer.alloc(0) }                           // wl-paste/xclip 给了个空
  }
}

const throwingStub = (makeError) => async () => { throw makeError() }

/**
 * execFile 在各种失败下抛出的错误对象形态。这些字段决定了「没有图」与
 * 「我没能判断」的分野，所以按真实形状构造，不能随手 new Error。
 */
const CLIPBOARD_ERRORS = {
  // 命令正常跑完，用非零退出表示「没有你要的这种内容」—— 最常见的情况
  nonZero: () => Object.assign(
    new Error("Command failed: xclip -selection clipboard -t image/png -o"),
    { code: 1 }
  ),
  // 命令没装
  enoent: () => commandError("spawn xclip ENOENT"),
  // execFile 的 timeout 到点后 SIGTERM 杀掉进程：killed=true、code=null
  timeout: () => Object.assign(
    new Error("Command failed: powershell -NoProfile -NonInteractive -Command ..."),
    { killed: true, signal: "SIGTERM", code: null }
  ),
  // stdout 超过 maxBuffer —— 注意它同样带 killed=true，分类时必须排在超时前面
  maxBuffer: () => Object.assign(
    new Error("stdout maxBuffer length exceeded"),
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }
  )
}

const COMMAND_NAMES = /xclip|wl-paste|pngpaste|osascript|powershell|Command failed/i

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "kkcode-cliptest-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 三个平台 × 六种结局。判据是「这次失败说明了什么」，不是「有没有抛错」——
 * 手写三遍的话，某个平台漏掉一种结局是迟早的事。
 */
for (const platform of ["linux", "darwin", "win32"]) {
  const cases = [
    {
      name: "命令非零退出 → null（工具说「没有这个 target」，不是出错）",
      // 本次回归的核心：此前只特判 ENOENT，非零退出被归进错误，于是任何一台
      // 剪贴板里装着文字的 Linux 机器上，Ctrl+V 都弹一行红色的原始 shell 命令，
      // 而 editor-keys.mjs 只在 null 时才回落到 readClipboardText()。
      stub: throwingStub(CLIPBOARD_ERRORS.nonZero),
      expect: (block) => assert.equal(block, null, "非零退出 = 没有图，必须回落到文本粘贴")
    },
    {
      name: "命令不存在（ENOENT）→ null",
      stub: throwingStub(CLIPBOARD_ERRORS.enoent),
      expect: (block) => assert.equal(block, null)
    },
    {
      name: "输出为空 → null",
      stub: emptyStub(platform),
      expect: (block) => assert.equal(block, null)
    },
    {
      name: "非图片字节 → null",
      stub: platformStub(platform, Buffer.from("HELLO_FROM_CLIPBOARD")),
      expect: (block) => assert.equal(block, null, "文本字节不能当成 PNG 挂上去")
    },
    {
      name: "真 PNG 字节 → image block",
      stub: platformStub(platform, pngBytes(`${platform} clipboard`)),
      expect: (block) => {
        assert.equal(block?.type, "image")
        assert.equal(block?.mediaType, "image/png")
        assert.equal(block?.data, pngBytes(`${platform} clipboard`).toString("base64"))
      }
    },
    {
      name: "超时 → error block，且不把命令行泄漏给用户",
      stub: throwingStub(CLIPBOARD_ERRORS.timeout),
      expect: (block) => {
        assert.equal(block?.type, "error", "超时意味着没能替用户判断，配得上一条错误")
        assert.equal(block.message, "clipboard read timed out")
        assert.doesNotMatch(block.message, COMMAND_NAMES, "错误话术里不能出现命令名或原始命令行")
      }
    },
    {
      name: "剪贴板图片超出体积上限 → error block",
      stub: throwingStub(CLIPBOARD_ERRORS.maxBuffer),
      expect: (block) => {
        assert.equal(block?.type, "error", "确实有图但拿不动，静默回落会让人以为没复制上")
        assert.match(block.message, /too large/)
        assert.doesNotMatch(block.message, COMMAND_NAMES)
      }
    }
  ]

  for (const { name, stub, expect } of cases) {
    test(`${platform}: ${name}`, async () => {
      await withTempDir(async (tempDir) => {
        const block = await readClipboardImage({ platform, tempDir, executeFile: stub })
        expect(block)
        // 任何一种结局都不能留下临时文件
        assert.deepEqual(await readdir(tempDir), [], "不能留下 kkcode-clip-*.png 垃圾文件")
      })
    })
  }
}

test("超大的剪贴板图片报体积，而不是静默回落成粘文本", async () => {
  // 走的是另一条路：字节确实拿到了、也确实是 PNG，只是文件超过 20MB —— 这时
  // readImageAsBlock 返回的是 too-large 文本块，此前它和「不是图片」一样被
  // 映射成 null，用户会以为图根本没复制上。
  await withTempDir(async (tempDir) => {
    const huge = Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.alloc(21 * 1024 * 1024)])
    const block = await readClipboardImage({
      platform: "linux",
      tempDir,
      executeFile: async () => ({ stdout: huge })
    })
    assert.equal(block?.type, "error")
    assert.match(block.message, /too large \(21MB, max 20MB\)/)
    assert.deepEqual(await readdir(tempDir), [])
  })
})

for (const platform of ["linux", "darwin", "win32"]) {
  test(`${platform}: readClipboardText 在没有文本时返回空，而不是冒出命令行错误`, async () => {
    for (const [label, executeFile] of [
      ["非零退出", throwingStub(CLIPBOARD_ERRORS.nonZero)],
      ["命令不存在", throwingStub(CLIPBOARD_ERRORS.enoent)],
      ["超时", throwingStub(CLIPBOARD_ERRORS.timeout)],
      ["空输出", async () => ({ stdout: "" })]
    ]) {
      const text = await readClipboardText({ platform, executeFile })
      assert.equal(text, null, `${label}时上层要说「Clipboard is empty」，不是弹错误`)
    }
  })
}

test("Linux clipboard text prefers wl-paste text MIME without adding a newline", async () => {
  const calls = []
  const text = await readClipboardText({
    platform: "linux",
    async executeFile(command, args, options) {
      calls.push({ command, args, options })
      return { stdout: "Wayland text" }
    }
  })

  assert.equal(text, "Wayland text")
  assert.deepEqual(calls, [{
    command: "wl-paste",
    args: ["--no-newline", "--type", "text"],
    options: TEXT_OPTIONS
  }])
})

test("Linux clipboard text retains xclip and xsel fallbacks", async () => {
  const calls = []
  const text = await readClipboardText({
    platform: "linux",
    async executeFile(command, args, options) {
      calls.push({ command, args, options })
      if (command !== "xsel") throw commandError(`spawn ${command} ENOENT`)
      return { stdout: "X11 text" }
    }
  })

  assert.equal(text, "X11 text")
  assert.deepEqual(calls, [
    {
      command: "wl-paste",
      args: ["--no-newline", "--type", "text"],
      options: TEXT_OPTIONS
    },
    {
      command: "xclip",
      args: ["-selection", "clipboard", "-o"],
      options: TEXT_OPTIONS
    },
    {
      command: "xsel",
      args: ["--clipboard", "--output"],
      options: TEXT_OPTIONS
    }
  ])
})

for (const [platform, command, args, output] of [
  [
    "win32",
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"],
    "Windows text"
  ],
  ["darwin", "pbpaste", [], "macOS text"]
]) {
  test(`${platform} clipboard text keeps its native reader`, async () => {
    const calls = []
    const text = await readClipboardText({
      platform,
      async executeFile(actualCommand, actualArgs, options) {
        calls.push({ command: actualCommand, args: actualArgs, options })
        return { stdout: output }
      }
    })

    assert.equal(text, output)
    assert.deepEqual(calls, [{ command, args, options: TEXT_OPTIONS }])
  })
}
