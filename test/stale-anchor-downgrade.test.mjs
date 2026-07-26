import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { ToolRegistry } from "../src/tool/registry.mjs"

const registryConfig = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }

async function withWorkspace(initial, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-stale-"))
  try {
    for (const [rel, content] of Object.entries(initial)) {
      await writeFile(path.join(dir, rel), content)
    }
    await ToolRegistry.initialize({ config: registryConfig, cwd: dir, force: true, allowProjectSources: false })
    return await fn(dir, { cwd: dir, config: registryConfig })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 外部改动必须让 mtime 变化，否则 guard 根本不认为文件动过 */
async function externalEdit(file, content) {
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(file, content)
}

const ORIGINAL = "export const alpha = 1\nexport const beta = 2\nexport const gamma = 3\n"

test("an external change elsewhere in the file does not kill an unambiguous edit", async () => {
  // kkcode 本身就是多 agent 的：另一个 agent 或用户的编辑器碰一下文件另一头，
  // 硬失败会让当前这次编辑整个被拒，模型只能重读全文再来一遍。
  // Claude Code 在 v2.1.208 专门做了这个降级，正是因为误杀率太高。
  await withWorkspace({ "a.mjs": ORIGINAL }, async (dir, ctx) => {
    const read = await ToolRegistry.get("read")
    const edit = await ToolRegistry.get("edit")
    await read.execute({ path: "a.mjs" }, ctx)

    await externalEdit(path.join(dir, "a.mjs"), `${ORIGINAL}export const delta = 4\n`)

    const result = await edit.execute(
      { path: "a.mjs", before: "export const beta = 2", after: "export const beta = 99" },
      ctx
    )
    const output = String(result.output || result)
    assert.match(output, /changed since it was last read/, "必须告诉模型文件变过")
    assert.match(output, /matches exactly once/)
    assert.doesNotMatch(output, /^error:/m, "不该被拒")

    // 而且改动要真的落盘，并且外部的那行不能丢
    const onDisk = await readFile(path.join(dir, "a.mjs"), "utf8")
    assert.match(onDisk, /export const beta = 99/)
    assert.match(onDisk, /export const delta = 4/, "外部改动不该被覆盖回去")
  })
})

test("a vanished anchor still fails hard", async () => {
  // 降级的条件很窄才安全：锚点找不到，就是真的「你手里的内容过期了」
  await withWorkspace({ "a.mjs": ORIGINAL }, async (dir, ctx) => {
    const read = await ToolRegistry.get("read")
    const edit = await ToolRegistry.get("edit")
    await read.execute({ path: "a.mjs" }, ctx)

    await externalEdit(path.join(dir, "a.mjs"), "totally different content\n")

    const result = await edit.execute(
      { path: "a.mjs", before: "export const gamma = 3", after: "x" },
      ctx
    )
    const output = String(result.output || result)
    assert.match(output, /^error:/, "锚点消失必须硬失败")
    assert.equal(await readFile(path.join(dir, "a.mjs"), "utf8"), "totally different content\n")
  })
})

test("an anchor that became ambiguous fails hard", async () => {
  // 匹配到多处意味着落点有歧义 —— 猜错一处就是静默改错地方，
  // 那正是宽松匹配最危险的失败模式
  await withWorkspace({ "a.mjs": ORIGINAL }, async (dir, ctx) => {
    const read = await ToolRegistry.get("read")
    const edit = await ToolRegistry.get("edit")
    await read.execute({ path: "a.mjs" }, ctx)

    // 外部改动把 beta 那行复制了一份
    await externalEdit(path.join(dir, "a.mjs"), `${ORIGINAL}export const beta = 2\n`)

    const result = await edit.execute(
      { path: "a.mjs", before: "export const beta = 2", after: "export const beta = 99" },
      ctx
    )
    assert.match(String(result.output || result), /^error:/, "歧义锚点必须硬失败")
  })
})

test("replace_all keeps the hard failure, since its anchor matches many times by design", async () => {
  await withWorkspace({ "a.mjs": "let x = 1\nlet x = 1\n" }, async (dir, ctx) => {
    const read = await ToolRegistry.get("read")
    const edit = await ToolRegistry.get("edit")
    await read.execute({ path: "a.mjs" }, ctx)

    await externalEdit(path.join(dir, "a.mjs"), "let x = 1\nlet x = 1\nlet y = 2\n")

    const result = await edit.execute(
      { path: "a.mjs", before: "let x = 1", after: "let x = 9", replace_all: true },
      ctx
    )
    assert.match(String(result.output || result), /^error:/, "replace_all 不该走降级")
  })
})

test("write still fails hard, because a whole-file replacement has no anchor", async () => {
  await withWorkspace({ "a.mjs": ORIGINAL }, async (dir, ctx) => {
    const read = await ToolRegistry.get("read")
    const write = await ToolRegistry.get("write")
    await read.execute({ path: "a.mjs" }, ctx)

    await externalEdit(path.join(dir, "a.mjs"), `${ORIGINAL}export const delta = 4\n`)

    const result = await write.execute({ path: "a.mjs", content: "replaced\n" }, ctx)
    const output = String(result.output || result)
    assert.match(output, /^error:/, "整文件替换会吞掉外部改动，必须硬失败")
    assert.match(await readFile(path.join(dir, "a.mjs"), "utf8"), /export const delta = 4/)
  })
})

test("patch still fails hard, because line numbers no longer mean what they meant", async () => {
  await withWorkspace({ "a.mjs": ORIGINAL }, async (dir, ctx) => {
    const read = await ToolRegistry.get("read")
    const patch = await ToolRegistry.get("patch")
    await read.execute({ path: "a.mjs" }, ctx)

    // 在前面插入一行，之后所有行号都错位了
    await externalEdit(path.join(dir, "a.mjs"), `// header\n${ORIGINAL}`)

    const result = await patch.execute(
      { path: "a.mjs", start_line: 2, end_line: 2, content: "export const beta = 99" },
      ctx
    )
    assert.match(String(result.output || result), /^error:/, "行号区间没有锚点可言")
  })
})

test("an anchor that is a substring of the changed line fails hard", async () => {
  // 这是最危险的一种：`const a = 1` 在被改成 `const a = 10` 的文件里**确实**
  // 只匹配一次，但它命中的已经不是同一个 token 了。只判「唯一匹配」的降级
  // 会静默产出 `const a = 20`，而模型完全不知道自己改错了东西。
  // 所以放行还要求锚点所跨的整行逐字节相同。
  await withWorkspace({ "a.js": "const a = 1\n" }, async (dir, ctx) => {
    const read = await ToolRegistry.get("read")
    const edit = await ToolRegistry.get("edit")
    await read.execute({ path: "a.js" }, ctx)

    await externalEdit(path.join(dir, "a.js"), "const a = 10\n")

    const result = await edit.execute({ path: "a.js", before: "const a = 1", after: "const a = 2" }, ctx)
    assert.match(String(result.output || result), /^error:/, "锚点所在行变了就不能放行")
    // 关键是绝不能写成 const a = 20
    assert.equal(await readFile(path.join(dir, "a.js"), "utf8"), "const a = 10\n")
  })
})

test("an unrelated change on the same line still fails hard", async () => {
  // 同一行上任何变化都可能改变锚点的语义 —— 加个注释也算
  await withWorkspace({ "a.mjs": ORIGINAL }, async (dir, ctx) => {
    const read = await ToolRegistry.get("read")
    const edit = await ToolRegistry.get("edit")
    await read.execute({ path: "a.mjs" }, ctx)

    await externalEdit(path.join(dir, "a.mjs"),
      "export const alpha = 1\nexport const beta = 2 // touched\nexport const gamma = 3\n")

    const result = await edit.execute(
      { path: "a.mjs", before: "export const beta = 2", after: "export const beta = 99" },
      ctx
    )
    assert.match(String(result.output || result), /^error:/)
  })
})
