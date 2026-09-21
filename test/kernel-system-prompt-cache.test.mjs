import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { buildSystemPromptBlocks } from "../src/kernel/session/system-prompt.mjs"
import { memoryFilePath } from "../src/storage/paths.mjs"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "kkcode-sysprompt-cache-"))
  const cwd = path.join(root, "project")
  await mkdir(cwd, { recursive: true })
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, "state")
  await mkdir(process.env.KKCODE_HOME)
  t.after(async () => {
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { cwd }
}

test("a memory edit between turns reaches the next prompt even when every other input is identical", async t => {
  const { cwd } = await fixture(t)
  const args = { mode: "assistant", model: "gpt-4o-mini", cwd, tools: [], skills: [], language: "en" }

  const first = await buildSystemPromptBlocks(args)
  const firstMemory = first.blocks.find((block) => block.label === "memory")
  assert.ok(firstMemory, "memory block exists")
  assert.match(firstMemory.text, /currently empty/)

  // A concurrent session (or the user) records a memory between turns.
  await mkdir(path.dirname(memoryFilePath(cwd)), { recursive: true })
  await writeFile(memoryFilePath(cwd), "- always run vitest with --run\n")

  const second = await buildSystemPromptBlocks(args)
  const secondMemory = second.blocks.find((block) => block.label === "memory")
  assert.match(secondMemory.text, /always run vitest/, "memory change invalidates the block cache")
  assert.notEqual(secondMemory.text, firstMemory.text)
})

test("identical inputs still hit the block cache (env-only refresh)", async t => {
  const { cwd } = await fixture(t)
  const args = { mode: "assistant", model: "gpt-4o-mini", cwd, tools: [], skills: [], language: "en" }

  const first = await buildSystemPromptBlocks(args)
  const second = await buildSystemPromptBlocks(args)
  assert.deepEqual(
    second.blocks.filter((b) => b.label !== "env"),
    first.blocks.filter((b) => b.label !== "env"),
    "stable blocks are reused verbatim when nothing changed"
  )
})

test("projectContext participates in the cache key", async t => {
  const { cwd } = await fixture(t)
  const base = { mode: "assistant", model: "gpt-4o-mini", cwd, tools: [], skills: [], language: "en" }

  const withoutContext = await buildSystemPromptBlocks({ ...base, projectContext: "" })
  const withContext = await buildSystemPromptBlocks({ ...base, projectContext: "<project>framework: vite</project>" })
  assert.ok(!withoutContext.blocks.some((b) => b.label === "project"))
  assert.ok(withContext.blocks.some((b) => b.label === "project"), "changing projectContext does not hit the stale cache")

  const reverted = await buildSystemPromptBlocks({ ...base, projectContext: "" })
  assert.ok(!reverted.blocks.some((b) => b.label === "project"), "reverting projectContext rebuilds again")
})
