import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"

/**
 * `kkcode provider` 命令（MarkUpdate 分支引入，0.5.2 优化）。
 *
 * 优化点锁定：
 *  1. 写回与向导共用 saveProviderConfig —— 切换 default 不得动其它字段
 *     （0.5.1 修过的整条目替换事故不能在第二份实现里复活）。
 *  2. REPL 语义归位：`add` = 添加（向导），裸 `/provider` = 列出并选择；
 *     上游分支里两者是反的。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-providercmd-"))
process.env.KKCODE_HOME = tmpHome

const { createProviderCommand, getConfiguredProviders } = await import("../src/commands/provider.mjs")

async function seedConfig() {
  await mkdir(tmpHome, { recursive: true })
  await writeFile(path.join(tmpHome, "config.yaml"), YAML.stringify({
    provider: {
      default: "kimi-code",
      strict_mode: false,
      model_context: { k3: 1048576 },
      "kimi-code": {
        type: "openai-compatible", base_url: "https://api.kimi.com/coding/v1",
        api_key: "sk-kimi-secret", default_model: "k3", timeout_ms: 180000
      },
      aliyun: {
        type: "openai-compatible", base_url: "https://x/compatible-mode/v1",
        api_key: "sk-aliyun-secret", default_model: "qwen3.7-plus"
      }
    }
  }), "utf8")
}

function captureConsole() {
  const out = [], err = []
  const origLog = console.log, origErr = console.error
  console.log = (...a) => out.push(a.join(" "))
  console.error = (...a) => err.push(a.join(" "))
  return { out, err, restore: () => { console.log = origLog; console.error = origErr } }
}

test.after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

describe("getConfiguredProviders", () => {
  it("过滤元字段，标记当前项", async () => {
    await seedConfig()
    const { loadConfig } = await import("../src/config/load-config.mjs")
    const providers = getConfiguredProviders(await loadConfig(tmpHome))
    const names = providers.map((p) => p.name)
    // loadConfig 会合入内置预设（openai/anthropic/ollama），与 REPL 行为一致
    assert.ok(names.includes("kimi-code") && names.includes("aliyun"))
    for (const meta of ["default", "strict_mode", "model_context"]) {
      assert.ok(!names.includes(meta), `元字段 ${meta} 不是 provider`)
    }
    assert.equal(providers.find((p) => p.name === "kimi-code").isActive, true)
    assert.equal(providers.filter((p) => p.isActive).length, 1)
  })
})

describe("provider switch", () => {
  it("切换 default 且不动其它字段 —— 写回必须走共用的逐字段合并", async () => {
    await seedConfig()
    const cap = captureConsole()
    try {
      await createProviderCommand().parseAsync(["switch", "aliyun"], { from: "user" })
    } finally { cap.restore() }
    assert.match(cap.out.join("\n"), /已切换到 "aliyun"/)

    const saved = YAML.parse(await readFile(path.join(tmpHome, "config.yaml"), "utf8"))
    assert.equal(saved.provider.default, "aliyun")
    // 0.5.1 前的整条目替换事故形态：这些字段会被抹掉
    assert.equal(saved.provider["kimi-code"].api_key, "sk-kimi-secret")
    assert.equal(saved.provider["kimi-code"].timeout_ms, 180000)
    assert.equal(saved.provider.aliyun.api_key, "sk-aliyun-secret")
    assert.deepEqual(saved.provider.model_context, { k3: 1048576 }, "元字段原样保留")
  })

  it("未知名称报错并列出可用项，退出码置位", async () => {
    await seedConfig()
    const cap = captureConsole()
    const before = process.exitCode
    try {
      await createProviderCommand().parseAsync(["switch", "nope"], { from: "user" })
    } finally { cap.restore() }
    assert.match(cap.err.join("\n"), /找不到 provider/)
    assert.match(cap.err.join("\n"), /aliyun/)
    assert.equal(process.exitCode, 1)
    process.exitCode = before
  })
})

describe("provider current / list", () => {
  it("current 显示当前 provider 与模型", async () => {
    await seedConfig()
    const cap = captureConsole()
    try {
      await createProviderCommand().parseAsync(["current"], { from: "user" })
    } finally { cap.restore() }
    assert.match(cap.out.join("\n"), /kimi-code/)
    assert.match(cap.out.join("\n"), /k3/)
  })

  it("list 标记当前项", async () => {
    await seedConfig()
    const cap = captureConsole()
    try {
      await createProviderCommand().parseAsync(["list"], { from: "user" })
    } finally { cap.restore() }
    const lines = cap.out.join("\n")
    assert.match(lines, /kimi-code \*/)
    assert.match(lines, /^aliyun$/m)
  })
})

describe("REPL 语义归位", () => {
  // add/set/edit 的语义现在由 test/repl-commands.test.mjs 行为覆盖（真的调用命令、
  // 断言向导是否被启动）。这里留下的是仍然属于 repl.mjs 的那一条。
  it("provider 选择态放行斜杠命令，不把它当 provider 名匹配", async () => {
    const source = await readFile(new URL("../src/repl.mjs", import.meta.url), "utf8")
    assert.match(source, /input\.startsWith\("\/"\)/,
      "用户在选择态改主意敲了别的命令，应退出选择让命令执行，而不是报「找不到 provider: /help」")
  })
})
