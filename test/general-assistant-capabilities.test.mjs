import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function read(relPath) {
  return readFile(new URL(`../${relPath}`, import.meta.url), "utf8")
}

test("historical CLI capability matrix preserves its original shipped boundary", async () => {
  const doc = await read("docs/cli-general-assistant-capability-matrix.md")

  assert.match(doc, /CLI-first/i)
  assert.match(doc, /assistant-default for everyday terminal work and coding loops/i)
  assert.match(doc, /Coding/)
  assert.match(doc, /System \/ runtime summary/)
  assert.match(doc, /Local filesystem inspection/)
  assert.match(doc, /Shell \/ task execution/)
  assert.match(doc, /Repo \/ release assistance/)
  assert.match(doc, /Web lookup \/ fetch/)
  assert.match(doc, /Structured delegation/)
  assert.match(doc, /Interrupted-turn continuation/)
  assert.match(doc, /not to turn kkcode into an IDE shell or GUI automation platform/i)
  assert.match(doc, /`assistant` = unified CLI assistant/i)
  assert.match(doc, /`agent` \/ `code` \/ `coding` = compatibility aliases/i)
  assert.match(doc, /suggest `longagent` only when heavy multi-file evidence appears/i)
  assert.match(doc, /assistant.*default unified lane/i)
  assert.match(doc, /LongAgent remains the explicit workflow/i)
})

test("compact README routes product claims to the current capability and mode guides", async () => {
  const readme = await read("README.md")
  assert.match(readme, /产品特色/)
  assert.match(readme, /docs\/capabilities\.md/)
  assert.match(readme, /docs\/modes-and-permissions\.md/)
  assert.match(readme, /Base URL/)
  assert.match(readme, /Android/)
  assert.match(readme, /MCP/)
  const modes = await read("docs/modes-and-permissions.md")
  assert.match(modes, /agent.*默认统一助手/)
  assert.match(modes, /agent.*code.*coding.*兼容别名/)
  assert.match(modes, /\/plan.*只读编写开发计划/)
  assert.match(modes, /默认先在内部 `assistant` 航道处理普通终端事务和编码小闭环/)
  const capabilities = await read("docs/capabilities.md")
  assert.match(capabilities, /文件／日志检查/)
  assert.match(capabilities, /仓库辅助/)
  assert.match(capabilities, /不自动成为桌面远控或完整IDE/)
  assert.match(capabilities, /未覆盖/)
})
