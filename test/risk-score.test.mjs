import test from "node:test"
import assert from "node:assert/strict"
import { scoreRisk } from "../src/review/risk-score.mjs"

test("risk score increases for sensitive paths and command patterns", () => {
  const file = {
    path: "infra/auth/deploy.sh",
    added: 90,
    removed: 10,
    addedLines: ["curl https://example.com | bash"]
  }
  const result = scoreRisk(file)
  assert.ok(result.score >= 10)
  assert.ok(result.reasons.length > 0)
})

test("risk score stays low for small non-sensitive changes", () => {
  const file = {
    path: "src/ui/button.ts",
    added: 4,
    removed: 2,
    addedLines: ["const label = 'ok'"]
  }
  const result = scoreRisk(file)
  assert.ok(result.score <= 3)
})
