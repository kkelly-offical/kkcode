import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function read(relPath) {
  return readFile(new URL(`../${relPath}`, import.meta.url), "utf8")
}

test("extension guide keeps hooks, plugin packages, and support levels explicit", async () => {
  const doc = await read("docs/agent-longagent-compat-extension-guide.md")

  assert.match(doc, /\.kkcode\/hooks\//)
  assert.match(doc, /\.kkcode-plugin\/plugin\.json/)
  assert.match(doc, /Enforced/)
  assert.match(doc, /Accepted but ignored/)
  assert.match(doc, /Rejected/)
  assert.match(doc, /local package support/i)
  assert.match(doc, /LongAgent.*preferred lane/i)
})
