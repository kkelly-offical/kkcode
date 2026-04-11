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
  assert.match(readme, /CLI 通用助手能力边界（0\.1\.12）/)
  assert.match(readme, /docs\/cli-general-assistant-capability-matrix\.md/)
  assert.match(readme, /docs\/kkcode-0\.1\.12-agent-mode-tolerance-contract\.md/)
})

test("0.1.12 contract doc keeps the shipped scope and boundaries explicit", async () => {
  const doc = await read("docs/kkcode-0.1.12-agent-mode-tolerance-contract.md")

  assert.match(doc, /Transaction-aware routing 2\.0/)
  assert.match(doc, /Agent continuation after interrupt/)
  assert.match(doc, /default general execution lane/i)
  assert.match(doc, /over-escalation/)
  assert.match(doc, /CLI general assistant/i)
  assert.match(doc, /docs\/cli-general-assistant-capability-matrix\.md/)
  assert.match(doc, /no GUI \/ desktop automation promise/i)
  assert.match(doc, /keep LongAgent/i)
  assert.match(doc, /docs\/cli-general-assistant-capability-matrix\.md/)
})
