import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function read(relPath) {
  return readFile(new URL(`../${relPath}`, import.meta.url), "utf8")
}

test("README advertises the shipped delegation and interruption contract", async () => {
  const readme = await read("README.md")

  assert.match(readme, /路由理由可见/)
  assert.match(readme, /background_output/)
  assert.match(readme, /background_cancel/)
  assert.match(readme, /completed` \/ `cancelled` \/ `error` \/ `interrupted`/)
  assert.match(readme, /Esc.*中断当前 turn/)
  assert.match(readme, /\.kkcode\/hooks\//)
  assert.match(readme, /\.kkcode-plugin\/plugin\.json/)
})

test("0.1.11 contract doc keeps the shipped scope and boundaries explicit", async () => {
  const doc = await read("docs/kkcode-0.1.11-agent-general-assistant-contract.md")

  assert.match(doc, /Routing \+ agent-mode tolerance foundation/)
  assert.match(doc, /Interruption compliance core/)
  assert.match(doc, /fresh_agent/)
  assert.match(doc, /fork_context/)
  assert.match(doc, /background_output/)
  assert.match(doc, /completed/)
  assert.match(doc, /interrupted/)
  assert.match(doc, /\.kkcode\/hooks\//)
  assert.match(doc, /\.kkcode-plugin\/plugin\.json/)
  assert.match(doc, /no GUI\/desktop automation promise/i)
  assert.match(doc, /keep LongAgent/i)
})
