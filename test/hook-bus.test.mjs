import test from "node:test"
import assert from "node:assert/strict"
import { HookBus } from "../src/plugin/hook-bus.mjs"

test("hook bus exposes supported events", () => {
  const events = HookBus.supportedEvents()
  assert.ok(events.includes("chat.params"))
  assert.ok(events.includes("tool.before"))
  assert.ok(events.includes("session.compacting"))
})
