import test from "node:test"
import assert from "node:assert/strict"
import { resolveHybridCompletionStatus } from "../src/session/longagent-hybrid.mjs"

test("hybrid completion cannot pass when usability gates failed", () => {
  assert.equal(resolveHybridCompletionStatus({
    completionMarkerSeen: true,
    usabilityGatesPassed: false
  }), "failed")
  assert.equal(resolveHybridCompletionStatus({
    completionMarkerSeen: true,
    usabilityGatesPassed: true
  }), "completed")
  assert.equal(resolveHybridCompletionStatus({
    completionMarkerSeen: false,
    usabilityGatesPassed: true
  }), "done")
})
