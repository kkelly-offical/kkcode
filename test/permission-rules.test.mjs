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
