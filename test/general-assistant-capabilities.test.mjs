import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function read(relPath) {
  return readFile(new URL(`../${relPath}`, import.meta.url), "utf8")
}

test("CLI general assistant capability doc keeps the shipped boundary explicit", async () => {
  const doc = await read("docs/cli-general-assistant-capability-matrix.md")

  assert.match(doc, /CLI-first/i)
  assert.match(doc, /agent-default for bounded terminal work/i)
  assert.match(doc, /Coding/)
  assert.match(doc, /System \/ runtime summary/)
  assert.match(doc, /Local filesystem inspection/)
  assert.match(doc, /Shell \/ task execution/)
  assert.match(doc, /Repo \/ release assistance/)
  assert.match(doc, /Web lookup \/ fetch/)
  assert.match(doc, /Structured delegation/)
  assert.match(doc, /Interrupted-turn continuation/)
  assert.match(doc, /not to turn kkcode into an IDE shell or GUI automation platform/i)
  assert.match(doc, /`plan` = produce a spec \/ plan only/i)
  assert.match(doc, /upgrade from `agent` to `longagent` only when heavy multi-file evidence appears/i)
  assert.match(doc, /agent.*default general execution lane/i)
  assert.match(doc, /LongAgent remains the preferred lane/i)
})

test("README advertises kkcode as a CLI general assistant without making GUI promises", async () => {
  const readme = await read("README.md")

  assert.match(readme, /CLI 通用助手能力边界（0\.1\.13）/)
  assert.match(readme, /公共模式契约/)
  assert.match(readme, /plan.*只产出规格.*不执行文件变更/)
  assert.match(readme, /系统 \/ 运行时信息/)
  assert.match(readme, /本地目录 \/ 文件 \/ 日志检查/)
  assert.match(readme, /仓库 \/ 发布辅助/)
  assert.match(readme, /不代表.*GUI \/ 桌面自动化/)
  assert.match(readme, /默认先在 `agent` 内把局部 inspect \/ patch \/ verify 做完/)
  assert.match(readme, /docs\/cli-general-assistant-capability-matrix\.md/)
})
