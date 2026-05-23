import test from "node:test"
import assert from "node:assert/strict"
import { evaluatePermission } from "../src/permission/rules.mjs"

test("sensitive edit paths are escalated from allow to ask", () => {
  const decision = evaluatePermission({
    config: {
      permission: {
        default_policy: "deny",
        rules: [
          { tool: "write", action: "allow", file_patterns: ["**"] }
        ]
      },
      tool: {
        sensitive_file_patterns: ["AGENTS.md", ".kkcode/**"]
      }
    },
    tool: "write",
    mode: "agent",
    pattern: "AGENTS.md"
  })

  assert.equal(decision.action, "ask")
  assert.equal(decision.source, "sensitive_path")
})

test("non-sensitive edit paths keep allow decision", () => {
  const decision = evaluatePermission({
    config: {
      permission: {
        default_policy: "deny",
        rules: [
          { tool: "write", action: "allow", file_patterns: ["**"] }
        ]
      },
      tool: {
        sensitive_file_patterns: ["AGENTS.md", ".kkcode/**"]
      }
    },
    tool: "write",
    mode: "agent",
    pattern: "src/app.mjs"
  })

  assert.equal(decision.action, "allow")
  assert.equal(decision.source, "rule")
})

test("sensitive-path escalation applies to multiedit path lists", () => {
  const decision = evaluatePermission({
    config: {
      permission: {
        default_policy: "allow",
        rules: []
      },
      tool: {
        sensitive_file_patterns: ["AGENTS.md", ".kkcode/**"]
      }
    },
    tool: "multiedit",
    mode: "agent",
    pattern: "src/app.mjs,AGENTS.md"
  })

  assert.equal(decision.action, "ask")
  assert.equal(decision.source, "sensitive_path")
})


test("auto mode allows safe read-only tools without prompting", () => {
  const decision = evaluatePermission({
    config: { permission: { mode: "auto", default_policy: "ask", rules: [] } },
    tool: "read",
    mode: "assistant",
    pattern: "README.md"
  })

  assert.equal(decision.action, "allow")
  assert.equal(decision.source, "auto_review")
})

test("auto mode asks before mutation tools", () => {
  const decision = evaluatePermission({
    config: { permission: { mode: "auto", default_policy: "ask", rules: [] } },
    tool: "patch",
    mode: "agent",
    pattern: "src/app.mjs"
  })

  assert.equal(decision.action, "ask")
  assert.equal(decision.source, "auto_review")
})

test("auto mode allows trusted read-only shell commands", () => {
  const decision = evaluatePermission({
    config: { permission: { mode: "auto", default_policy: "ask", rules: [] } },
    tool: "bash",
    mode: "assistant",
    command: "git status --short"
  })

  assert.equal(decision.action, "allow")
  assert.equal(decision.source, "auto_review")
})

test("auto mode asks before untrusted shell commands", () => {
  const decision = evaluatePermission({
    config: { permission: { mode: "auto", default_policy: "ask", rules: [] } },
    tool: "bash",
    mode: "assistant",
    command: "npm test"
  })

  assert.equal(decision.action, "ask")
  assert.equal(decision.source, "auto_review")
})

test("yolo mode allows sensitive edits unless an explicit rule denies them", () => {
  const allowed = evaluatePermission({
    config: {
      permission: { mode: "yolo", default_policy: "ask", rules: [] },
      tool: { sensitive_file_patterns: ["AGENTS.md", ".kkcode/**"] }
    },
    tool: "write",
    mode: "agent",
    pattern: "AGENTS.md"
  })

  assert.equal(allowed.action, "allow")
  assert.equal(allowed.source, "mode:yolo")

  const denied = evaluatePermission({
    config: {
      permission: {
        mode: "yolo",
        default_policy: "ask",
        rules: [{ tool: "write", action: "deny", file_patterns: ["AGENTS.md"] }]
      },
      tool: { sensitive_file_patterns: ["AGENTS.md", ".kkcode/**"] }
    },
    tool: "write",
    mode: "agent",
    pattern: "AGENTS.md"
  })

  assert.equal(denied.action, "deny")
  assert.equal(denied.source, "rule")
})
