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
        level: "accept-edits",
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


function decide(permission, input, toolConfig = undefined) {
  return evaluatePermission({
    config: { permission, ...(toolConfig ? { tool: toolConfig } : {}) },
    mode: "agent",
    ...input
  })
}

test("manual level allows safe read-only tools without prompting", () => {
  const decision = decide({ level: "manual", rules: [] }, { tool: "read", pattern: "README.md" })
  assert.equal(decision.action, "allow")
  assert.equal(decision.source, "level:manual")
})

test("manual level asks before mutation tools", () => {
  const decision = decide({ level: "manual", rules: [] }, { tool: "patch", pattern: "src/app.mjs" })
  assert.equal(decision.action, "ask")
  assert.equal(decision.source, "level:manual")
})

test("manual level allows trusted read-only shell but asks for anything else", () => {
  assert.equal(decide({ level: "manual", rules: [] }, { tool: "bash", command: "git status --short" }).action, "allow")
  assert.equal(decide({ level: "manual", rules: [] }, { tool: "bash", command: "npm test" }).action, "ask")
})

test("manual level asks before spawning subagents", () => {
  assert.equal(decide({ level: "manual", rules: [] }, { tool: "task" }).action, "ask")
})

test("legacy permission.mode auto maps to manual instead of widening edits", () => {
  // 0.3.x reached an unreachable `auto_review` branch here; the config carried no
  // `level`, which DEFAULT_CONFIG always injects in practice.
  const decision = decide({ mode: "auto", default_policy: "ask", rules: [] }, { tool: "patch", pattern: "a.mjs" })
  assert.equal(decision.action, "ask")
  assert.equal(decision.source, "level:manual")
})

test("readonly level denies edits and every shell command", () => {
  assert.equal(decide({ level: "readonly", rules: [] }, { tool: "edit", pattern: "README.md" }).source, "level:readonly")
  assert.equal(decide({ level: "readonly", rules: [] }, { tool: "edit", pattern: "README.md" }).action, "deny")
  assert.equal(decide({ level: "readonly", rules: [] }, { tool: "bash", command: "git status" }).action, "deny")
  assert.equal(decide({ level: "readonly", rules: [] }, { tool: "read", pattern: "README.md" }).action, "allow")
})

test("legacy review folds into manual, so edits now ask instead of being denied", () => {
  // Behaviour change in 0.4.0: review and auto merged into manual. An edit that
  // review used to reject outright now prompts the user rather than failing.
  const safe = decide({ level: "review", rules: [] }, { tool: "bash", command: "git status --short" })
  const edit = decide({ level: "review", rules: [] }, { tool: "write", pattern: "README.md" })

  assert.equal(safe.action, "allow")
  assert.equal(edit.action, "ask")
  assert.equal(edit.source, "level:manual")
})

test("accept-edits allows normal edits and subagents while sensitive paths still ask", () => {
  const sensitivePatterns = { sensitive_file_patterns: ["AGENTS.md"] }
  const normal = decide({ level: "accept-edits", rules: [] }, { tool: "write", pattern: "README.md" }, sensitivePatterns)
  const sensitive = decide({ level: "accept-edits", rules: [] }, { tool: "write", pattern: "AGENTS.md" }, sensitivePatterns)
  const risky = decide({ level: "accept-edits", rules: [] }, { tool: "bash", command: "rm -rf build" })

  assert.equal(normal.action, "allow")
  assert.equal(sensitive.action, "ask")
  assert.equal(sensitive.source, "sensitive_path")
  assert.equal(decide({ level: "accept-edits", rules: [] }, { tool: "task" }).action, "allow")
  assert.equal(risky.action, "ask")
})

// 0.6.0：旧等级名已移除。schema 会带着迁移写法报错（见 config-legacy-removal
// 的断言）；万一有内部调用绕过校验塞进旧名，运行时必须回落到默认档 ——
// 猜一个更宽松的档位正是这次移除要杜绝的事故。
test("legacy level names no longer resolve to a permissive tier", () => {
  for (const level of ["edit", "full-auto", "review", "auto"]) {
    const decision = decide({ level, rules: [] }, { tool: "write", pattern: "a.mjs" })
    assert.equal(decision.source, "level:manual", `${level} 不该解析成任何具体旧档`)
  }
})

test("yolo allows sensitive edits unless an explicit rule denies them", () => {
  const sensitivePatterns = { sensitive_file_patterns: ["AGENTS.md", ".kkcode/**"] }
  const allowed = decide({ level: "yolo", rules: [] }, { tool: "write", pattern: "AGENTS.md" }, sensitivePatterns)

  assert.equal(allowed.action, "allow")
  assert.equal(allowed.source, "level:yolo")

  const denied = decide(
    { level: "yolo", rules: [{ tool: "write", action: "deny", file_patterns: ["AGENTS.md"] }] },
    { tool: "write", pattern: "AGENTS.md" },
    sensitivePatterns
  )

  assert.equal(denied.action, "deny")
  assert.equal(denied.source, "rule")
})

test("permission.mode no longer grants anything on its own", () => {
  // 旧键被移除后，只写 mode: yolo 不再能放开权限 —— 它在 schema 层就会
  // 被拒；即使绕过，运行时也只看 permission.level。
  const decision = decide({ mode: "yolo", rules: [] }, { tool: "write", pattern: "AGENTS.md" })
  assert.equal(decision.source, "level:manual")
  assert.notEqual(decision.action, "allow")
})

test("legacy file_pattern remains a working alias for file_patterns", () => {
  const allowed = evaluatePermission({
    config: {
      permission: {
        level: "readonly",
        rules: [{ tool: "write", action: "allow", file_pattern: "src/**" }]
      },
      tool: { sensitive_file_patterns: [] }
    },
    tool: "write",
    mode: "agent",
    pattern: "src/app.mjs"
  })
  const denied = evaluatePermission({
    config: {
      permission: {
        level: "readonly",
        rules: [{ tool: "write", action: "allow", file_pattern: "src/**" }]
      },
      tool: { sensitive_file_patterns: [] }
    },
    tool: "write",
    mode: "agent",
    pattern: "docs/readme.md"
  })

  assert.equal(allowed.action, "allow")
  assert.equal(denied.action, "deny")
})
