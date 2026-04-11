import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function read(relPath) {
  return readFile(new URL(`../${relPath}`, import.meta.url), "utf8")
}

test("CLI general assistant capability doc keeps the shipped boundary explicit", async () => {
  const doc = await read("docs/cli-general-assistant-capability-matrix.md")

  assert.match(doc, /CLI-first/i)
  assert.match(doc, /Coding/)
  assert.match(doc, /Local filesystem inspection/)
  assert.match(doc, /Shell \/ task execution/)
  assert.match(doc, /Repo \/ release assistance/)
  assert.match(doc, /Web lookup \/ fetch/)
  assert.match(doc, /Structured delegation/)
  assert.match(doc, /not to turn kkcode into an IDE shell or GUI automation platform/i)
  assert.match(doc, /LongAgent remains the preferred lane/i)
})

test("README advertises kkcode as a CLI general assistant without making GUI promises", async () => {
  const readme = await read("README.md")

  assert.match(readme, /CLI 通用助手能力边界（0\.1\.11）/)
  assert.match(readme, /本地目录 \/ 文件 \/ 日志检查/)
  assert.match(readme, /仓库 \/ 发布辅助/)
  assert.match(readme, /不代表.*GUI \/ 桌面自动化/)
  assert.match(readme, /docs\/cli-general-assistant-capability-matrix\.md/)
})
