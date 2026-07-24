import test from "node:test"
import assert from "node:assert/strict"
import {
  readClipboardImage,
  readClipboardText
} from "../src/tool/image-util.mjs"

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
  const image = Buffer.from("mock png")
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
  const image = Buffer.from("xclip png")
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
