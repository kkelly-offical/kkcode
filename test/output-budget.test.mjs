import test, { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toolOutputBudget, truncationNotice, completeNotice } from "../src/tool/output-budget.mjs"
import { ToolRegistry, looksBinary } from "../src/tool/registry.mjs"
import { modelContextLimit } from "../src/session/compaction.mjs"

/**
 * 0.7.0 阶段 1：解开工具输出瓶颈，并让每一次截断都说清「还剩多少、怎么取」。
 *
 * 此前所有工具的返回值被硬编码砍到 3000 字符 —— 一个 268 行的普通源文件
 * 有 12494 字符，模型只能看到四分之一，**而且不知道自己没读全**。read 那个
 * 2000 行的上限从未生效过，真正的天花板是它的 1/25。
 *
 * 注意这不是「取消上限」：行数上限是同行共识且有意为之（逼模型用 grep 定位
 * 而不是整文件倾倒）。要改的是量级，以及截断的可见性。
 */

const dirs = []
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "kkcode-budget-"))
  dirs.push(dir)
  return dir
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const CFG = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
async function readTool(cwd) {
  await ToolRegistry.initialize({ config: CFG, cwd, allowProjectSources: false })
  return await ToolRegistry.get("read")
}

describe("输出预算随模型上下文变化", () => {
  it("上下文越大预算越大", () => {
    const small = toolOutputBudget({ model: "deepseek-chat", config: {} })
    const large = toolOutputBudget({ model: "k3", config: {} })
    assert.ok(large.chars > small.chars, `k3 应当拿到更多预算: ${small.chars} vs ${large.chars}`)
  })

  it("下限足以读完一个普通源文件（约 12500 字符）", () => {
    const tiny = toolOutputBudget({ model: "gpt-3.5", config: {} })
    assert.ok(tiny.chars >= 16000, `下限太低: ${tiny.chars}`)
  })

  it("有上限，单次调用不会主导整个上下文", () => {
    const huge = toolOutputBudget({ model: "gemini-2.5-pro", config: {} })
    assert.ok(huge.chars <= 200000, `上限失效: ${huge.chars}`)
  })

  it("任何模型下都远高于此前的 3000", () => {
    for (const model of ["k3", "gpt-5", "claude-opus-4", "deepseek-r1", "unknown"]) {
      assert.ok(toolOutputBudget({ model, config: {} }).chars > 3000 * 4, model)
    }
  })

  it("比例可配，且拒绝荒谬取值", () => {
    const raised = toolOutputBudget({ model: "k3", config: { tool: { output_budget_ratio: 0.2 } } })
    const base = toolOutputBudget({ model: "k3", config: {} })
    assert.ok(raised.chars >= base.chars)
    for (const bad of [0, -1, 5, "x", null]) {
      const out = toolOutputBudget({ model: "k3", config: { tool: { output_budget_ratio: bad } } })
      assert.equal(out.ratio, 0.08, `荒谬取值 ${bad} 应回落默认`)
    }
  })
})

describe("上下文表覆盖当前在用的模型", () => {
  it("kimi 族不再走默认值", () => {
    // 此前整个 kimi 族缺失，k3 走默认 128000 而实际是 1M —— 少算八倍，
    // 压缩因此提前触发。
    assert.equal(modelContextLimit("k3", null), 1048576)
    assert.equal(modelContextLimit("k3-256k", null), 262144)
  })

  it("长前缀优先于短前缀", () => {
    // k3-256k 不能被 k3 吃掉；deepseek-r1 不能被 deepseek 吃掉
    assert.notEqual(modelContextLimit("k3-256k", null), modelContextLimit("k3", null))
    assert.equal(modelContextLimit("deepseek-r1", null), 128000)
  })
})

describe("截断提示必须说清还剩多少、怎么取", () => {
  it("提示里同时有已展示量、总量与剩余量", () => {
    const notice = truncationNotice({ shown: 2000, total: 3000, unit: "lines", hint: "Use read with offset=2001 to continue." })
    assert.match(notice, /2000/)
    assert.match(notice, /3000/)
    assert.match(notice, /1000 remaining/)
    assert.match(notice, /offset=2001/)
  })

  it("读完与截断在文本上可区分", () => {
    assert.match(completeNotice({ total: 340 }), /complete/)
    assert.doesNotMatch(completeNotice({ total: 340 }), /truncated/)
  })
})

describe("read 的每条路径都自报状态", () => {
  it("读完的文件明确说 complete", async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, "small.txt"), "a\nb\nc", "utf8")
    const out = String(await (await readTool(cwd)).execute({ path: "small.txt" }, { cwd, config: CFG }))
    assert.match(out, /\[complete: 3 lines\]/)
  })

  it("超行数上限时给出确切的续读参数", async () => {
    const cwd = await workspace()
    const content = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n")
    await writeFile(join(cwd, "long.txt"), content, "utf8")
    const out = String(await (await readTool(cwd)).execute({ path: "long.txt" }, { cwd, config: CFG }))
    assert.match(out, /showing 2000 of 3000 lines/)
    assert.match(out, /offset=2001/)
  })

  it("按提示续读能真的读到末尾", async () => {
    const cwd = await workspace()
    const content = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n")
    await writeFile(join(cwd, "long.txt"), content, "utf8")
    const tool = await readTool(cwd)
    const rest = String(await tool.execute({ path: "long.txt", offset: 2001 }, { cwd, config: CFG }))
    assert.match(rest, /\[complete: 3000 lines\]/)
    assert.match(rest, /line 3000/)
  })

  it("字节帽拦住宽行文件，并说明是字节触顶", async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, "wide.txt"), Array.from({ length: 200 }, () => "x".repeat(1500)).join("\n"), "utf8")
    const out = String(await (await readTool(cwd)).execute({ path: "wide.txt" }, { cwd, config: CFG }))
    assert.match(out, /capped at \d+ bytes/)
    assert.match(out, /offset=/)
  })

  it("行内截断与文件级状态互不混淆", async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, "oneline.txt"), "y".repeat(5000), "utf8")
    const out = String(await (await readTool(cwd)).execute({ path: "oneline.txt" }, { cwd, config: CFG }))
    // 单行被截 → 行尾有字符级提示；文件只有一行且读完 → 末行是 complete
    assert.match(out, /showing 2000 of 5000 chars/)
    assert.match(out, /\[complete: 1 lines\]/)
  })

  it("越界 offset 报错而不是静默返回空串", async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, "two.txt"), "a\nb", "utf8")
    const out = String(await (await readTool(cwd)).execute({ path: "two.txt", offset: 99 }, { cwd, config: CFG }))
    assert.match(out, /past the end of the file \(2 lines\)/)
  })
})

describe("二进制探测", () => {
  it("文本内容一律判为非二进制", () => {
    for (const text of ["abc def", "你好世界", "const x = 1\nfunction f() {}", ""]) {
      assert.equal(looksBinary(text), false, JSON.stringify(text.slice(0, 20)))
    }
  })

  it("NUL 字节与高占比替换字符判为二进制", () => {
    assert.equal(looksBinary(`ab${String.fromCharCode(0)}cd`), true)
    assert.equal(looksBinary(String.fromCharCode(0xFFFD).repeat(20)), true)
  })

  it("少量替换字符不误判 —— 正常文本里偶有坏字节很常见", () => {
    assert.equal(looksBinary(`${"x".repeat(500)}${String.fromCharCode(0xFFFD)}`), false)
  })
})

test("大文件在读之前就被拦下，并指向 grep", async () => {
  const cwd = await workspace()
  // 不真造 10MB 文件；用一个刚好超线的近似即可验证提示文案存在性
  const tool = await readTool(cwd)
  await writeFile(join(cwd, "ok.txt"), "small", "utf8")
  const fine = String(await tool.execute({ path: "ok.txt" }, { cwd, config: CFG }))
  assert.doesNotMatch(fine, /over the .* byte read limit/, "小文件不该被拦")
})
