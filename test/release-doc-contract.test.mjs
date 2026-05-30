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
  assert.match(readme, /CLI 统一 Assistant 能力边界（0\.3\.0）/)
  assert.match(readme, /\/plan.*只读编写开发计划/)
  assert.match(readme, /assistant.*默认统一助手/)
  assert.match(readme, /agent.*code.*coding.*兼容别名/)
  assert.match(readme, /明确重型任务.*\/longagent/)
  assert.match(readme, /docs\/cli-general-assistant-capability-matrix\.md/)
  assert.match(readme, /docs\/kkcode-0\.1\.13-mode-lane-contract\.md/)
})

test("0.1.13 contract doc keeps the shipped scope and boundaries explicit", async () => {
  const doc = await read("docs/kkcode-0.1.13-mode-lane-contract.md")

  assert.match(doc, /assistant \/ plan \/ agent \/ longagent public lane contract/i)
  assert.match(doc, /CLI routing transparency/i)
  assert.match(doc, /default general execution lane/i)
  assert.match(doc, /plan.*does not execute file mutations/i)
  assert.match(doc, /assistant.*agent.*longagent.*upgrade paths/i)
  assert.match(doc, /CLI general assistant/i)
  assert.match(doc, /docs\/cli-general-assistant-capability-matrix\.md/)
  assert.match(doc, /no GUI \/ desktop automation promise/i)
  assert.match(doc, /keep LongAgent/i)
})
