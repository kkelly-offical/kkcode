import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function read(relPath) {
  return readFile(new URL(`../${relPath}`, import.meta.url), "utf8")
}

test("README advertises the shipped delegation, routing, and interruption contract", async () => {
  const readme = await read("README.md")

  assert.match(readme, /路由理由可见/)
  assert.match(readme, /background_output/)
  assert.match(readme, /background_cancel/)
  assert.match(readme, /completed` \/ `cancelled` \/ `error` \/ `interrupted`/)
  assert.match(readme, /Esc.*中断当前 turn/)
  assert.match(readme, /\.kkcode\/hooks\//)
  assert.match(readme, /\.kkcode-plugin\/plugin\.json/)
  assert.match(readme, /CLI 通用助手能力边界（0\.1\.13）/)
  assert.match(readme, /plan.*只产出规格.*不执行文件变更/)
  assert.match(readme, /agent.*默认有界本地执行航道/)
  assert.match(readme, /只有出现明确重型证据时.*agent.*longagent/)
  assert.match(readme, /docs\/cli-general-assistant-capability-matrix\.md/)
  assert.match(readme, /docs\/kkcode-0\.1\.13-mode-lane-contract\.md/)
})

test("0.1.13 contract doc keeps the shipped scope and boundaries explicit", async () => {
  const doc = await read("docs/kkcode-0.1.13-mode-lane-contract.md")

  assert.match(doc, /ask \/ plan \/ agent \/ longagent public lane contract/i)
  assert.match(doc, /CLI routing transparency/i)
  assert.match(doc, /default general execution lane/i)
  assert.match(doc, /plan.*does not execute file mutations/i)
  assert.match(doc, /agent -> longagent.*upgrade path/i)
  assert.match(doc, /CLI general assistant/i)
  assert.match(doc, /docs\/cli-general-assistant-capability-matrix\.md/)
  assert.match(doc, /no GUI \/ desktop automation promise/i)
  assert.match(doc, /keep LongAgent/i)
})
