import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { buildReplSmokeChecklist, summarizeVerificationResults } from "../src/repl/verification.mjs"

test("buildReplSmokeChecklist exposes the expected smoke steps", () => {
  const steps = buildReplSmokeChecklist()
  assert.ok(steps.length >= 6)
  assert.ok(steps.includes("verify /help and /status output"))
})

test("summarizeVerificationResults counts pass/fail correctly", () => {
  const summary = summarizeVerificationResults([{ ok: true }, { ok: false }, { ok: true }])
  assert.deepEqual(summary, { total: 3, passed: 2, failed: 1, ok: false })
})

test("roadmap doc records the 0.1.27 to 0.1.36 sequence", async () => {
  const text = await readFile(new URL("../docs/repl-roadmap-0.1.27-0.1.36.md", import.meta.url), "utf8")
  assert.match(text, /0\.1\.27/)
  assert.match(text, /0\.1\.36/)
})
