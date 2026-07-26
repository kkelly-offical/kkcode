import test, { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolRegistry } from "../src/tool/registry.mjs"

/**
 * 0.7.0 阶段 2：multiedit 同一文件多次编辑不能丢改动。
 *
 * 此前每个 change 都从 `snap.original`（批次前的原始内容）算起，于是同一文件
 * 出现两次时，第二个 change 基于旧内容计算并覆盖写入 —— **第一个 change 被
 * 静默丢弃，没有任何报错**。这是不可逆的数据损失里最难发现的一种：工具报告
 * 成功，改动却只落了一半。
 */

const dirs = []
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "kkcode-multiedit-"))
  dirs.push(dir)
  return dir
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const CFG = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }

async function setup(cwd, name, content) {
  await writeFile(join(cwd, name), content, "utf8")
  await ToolRegistry.initialize({ config: CFG, cwd, allowProjectSources: false })
  const read = await ToolRegistry.get("read")
  // multiedit 走 mutation-guard，必须先读
  await read.execute({ path: name }, { cwd, config: CFG })
  return await ToolRegistry.get("multiedit")
}

describe("同一文件的多个改动逐个叠加", () => {
  it("两个改动都落盘，第一个不被第二个覆盖", async () => {
    const cwd = await workspace()
    const tool = await setup(cwd, "a.mjs", "const one = 1\nconst two = 2\n")

    const out = await tool.execute({
      changes: [
        { path: "a.mjs", before: "const one = 1", after: "const one = 100" },
        { path: "a.mjs", before: "const two = 2", after: "const two = 200" }
      ]
    }, { cwd, config: CFG })

    const final = await readFile(join(cwd, "a.mjs"), "utf8")
    assert.match(final, /const one = 100/, `第一个改动丢了: ${JSON.stringify(final)} (${JSON.stringify(out)})`)
    assert.match(final, /const two = 200/, "第二个改动丢了")
  })

  it("三个改动依次叠加", async () => {
    const cwd = await workspace()
    const tool = await setup(cwd, "b.txt", "a\nb\nc\n")
    await tool.execute({
      changes: [
        { path: "b.txt", before: "a", after: "A" },
        { path: "b.txt", before: "b", after: "B" },
        { path: "b.txt", before: "c", after: "C" }
      ]
    }, { cwd, config: CFG })
    assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "A\nB\nC\n")
  })
})

describe("批次内相互作用宁可整批失败，不产出错误结果", () => {
  it("后一个改动被前一个改掉时报错并回滚", async () => {
    const cwd = await workspace()
    const tool = await setup(cwd, "c.txt", "target line\n")

    const out = await tool.execute({
      changes: [
        { path: "c.txt", before: "target line", after: "replaced" },
        // 这一条依赖的文本已被上一条改掉 —— Phase 1 的预检基于原始内容看不到
        { path: "c.txt", before: "target line", after: "second attempt" }
      ]
    }, { cwd, config: CFG })

    const text = typeof out === "string" ? out : JSON.stringify(out)
    assert.match(text, /no longer matches after an earlier change/, `应当明确报告批次内冲突: ${text}`)
    // 整批回滚：文件回到原样
    assert.equal(await readFile(join(cwd, "c.txt"), "utf8"), "target line\n")
  })
})

test("跨文件的批量编辑照常工作", async () => {
  const cwd = await workspace()
  await writeFile(join(cwd, "x.txt"), "xxx\n", "utf8")
  await writeFile(join(cwd, "y.txt"), "yyy\n", "utf8")
  await ToolRegistry.initialize({ config: CFG, cwd, allowProjectSources: false })
  const read = await ToolRegistry.get("read")
  await read.execute({ path: "x.txt" }, { cwd, config: CFG })
  await read.execute({ path: "y.txt" }, { cwd, config: CFG })
  const tool = await ToolRegistry.get("multiedit")

  await tool.execute({
    changes: [
      { path: "x.txt", before: "xxx", after: "XXX" },
      { path: "y.txt", before: "yyy", after: "YYY" }
    ]
  }, { cwd, config: CFG })

  assert.equal(await readFile(join(cwd, "x.txt"), "utf8"), "XXX\n")
  assert.equal(await readFile(join(cwd, "y.txt"), "utf8"), "YYY\n")
})
