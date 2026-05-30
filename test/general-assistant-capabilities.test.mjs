import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function read(relPath) {
  return readFile(new URL(`../${relPath}`, import.meta.url), "utf8")
}

test("CLI general assistant capability doc keeps the shipped boundary explicit", async () => {
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

test("README advertises kkcode as a CLI general assistant without making GUI promises", async () => {
  const readme = await read("README.md")

  assert.match(readme, /CLI 统一 Assistant 能力边界（0\.3\.0）/)
  assert.match(readme, /公共模式契约/)
  assert.match(readme, /assistant.*默认统一助手/)
  assert.match(readme, /agent.*code.*coding.*兼容别名/)
  assert.match(readme, /\/plan.*只读编写开发计划/)
  assert.match(readme, /系统 \/ 运行时信息/)
  assert.match(readme, /本地目录 \/ 文件 \/ 日志检查/)
  assert.match(readme, /仓库 \/ 发布辅助/)
  assert.match(readme, /不代表.*GUI \/ 桌面自动化/)
  assert.match(readme, /默认先在 `assistant` 内处理普通终端事务和编码小闭环/)
  assert.match(readme, /docs\/cli-general-assistant-capability-matrix\.md/)
})
