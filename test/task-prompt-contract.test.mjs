import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

test("task prompt documents shared execution and scoped delegation contracts", async () => {
  const prompt = await readFile(new URL("../src/kernel/tool/prompt/task.txt", import.meta.url), "utf8")

  assert.match(prompt, /Stay local when:/)
  assert.match(prompt, /Delegate when:/)
  assert.match(prompt, /fresh_agent/i)
  assert.match(prompt, /fork_context/)
  assert.match(prompt, /reserved for \*\*read-only sidecar work\*\*/i)
  assert.match(prompt, /background_output/)
  assert.match(prompt, /Never delegate understanding/i)
  assert.match(prompt, /Do not delegate to compensate for routing uncertainty/i)
  assert.match(prompt, /Agent\/Auto\/Yolo already support full implementation and delegation/i)
  assert.match(prompt, /Ultra is an optional durable orchestration overlay/i)
  assert.match(prompt, /host-enforced read-only ceiling/i)
  assert.match(prompt, /These controls do not authorize writes or bypass strict host task graphs/i)
  assert.match(prompt, /Background delegates cannot ask interactive questions/i)
  assert.match(prompt, /Do NOT fabricate completion/i)
  assert.match(prompt, /Do NOT "peek" at unfinished delegated work/i)
})
