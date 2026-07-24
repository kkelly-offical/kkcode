import test from "node:test"
import assert from "node:assert/strict"
import {
  buildLearnedRule,
  commandPrefixOf,
  appendLearnedRule,
  findEquivalentRule,
  listLearnedRules,
  removeLearnedRules,
  isLearnedRule,
  describeRule,
  LEARNED_RULE_SOURCE
} from "../src/permission/learned-rules.mjs"
import { matchRule, evaluatePermission } from "../src/permission/rules.mjs"
import { PermissionEngine } from "../src/permission/engine.mjs"
import { setPermissionPromptHandler } from "../src/permission/prompt.mjs"

test("bash grants remember a two-token command prefix", () => {
  assert.equal(commandPrefixOf("git status --short"), "git status")
  assert.equal(commandPrefixOf("  npm   test -- --watch "), "npm test")
  assert.equal(commandPrefixOf("ls"), "ls")
  assert.equal(commandPrefixOf(""), "")

  const rule = buildLearnedRule({ tool: "bash", command: "npm test -- --watch", workspace: "/repo" })
  assert.deepEqual(rule, {
    tool: "bash",
    action: "allow",
    command_prefix: "npm test",
    workspace: "/repo",
    source: LEARNED_RULE_SOURCE
  })
})

test("file tool grants remember the concrete path, and `*` means the whole tool", () => {
  assert.deepEqual(buildLearnedRule({ tool: "write", pattern: "src/app.mjs", workspace: "/repo" }), {
    tool: "write",
    action: "allow",
    file_patterns: ["src/app.mjs"],
    workspace: "/repo",
    source: LEARNED_RULE_SOURCE
  })

  const wide = buildLearnedRule({ tool: "websearch", pattern: "*", workspace: "/repo" })
  assert.equal(wide.file_patterns, undefined)
  assert.equal(wide.tool, "websearch")
})

test("invalid grants are rejected instead of producing a catch-all rule", () => {
  assert.equal(buildLearnedRule({ tool: "" }), null)
  // a bash grant with no command must never fall back to the `*` pattern,
  // which would persist a rule allowing every shell command
  assert.equal(buildLearnedRule({ tool: "bash", command: "" }), null)
  assert.equal(buildLearnedRule({ tool: "bash", command: "", pattern: "*" }), null)
  assert.equal(buildLearnedRule({ tool: "bash", command: "rm -rf *" }), null)
})

test("appending is idempotent and respects the learned-rule limit", () => {
  const rule = buildLearnedRule({ tool: "bash", command: "npm test", workspace: "/repo" })

  const first = appendLearnedRule([], rule)
  assert.equal(first.added, true)
  assert.equal(first.rules.length, 1)

  const second = appendLearnedRule(first.rules, rule)
  assert.equal(second.added, false)
  assert.equal(second.reason, "duplicate")
  assert.equal(second.rules.length, 1)

  const full = Array.from({ length: 3 }, (_, i) =>
    buildLearnedRule({ tool: "bash", command: `cmd${i} run`, workspace: "/repo" }))
  const capped = appendLearnedRule(full, rule, { limit: 3 })
  assert.equal(capped.added, false)
  assert.equal(capped.reason, "limit")
})

test("a hand-written equivalent rule suppresses the learned duplicate", () => {
  const manual = { tool: "bash", action: "allow", command_prefix: "npm test", workspace: "/repo" }
  const learned = buildLearnedRule({ tool: "bash", command: "npm test --silent", workspace: "/repo" })
  assert.ok(findEquivalentRule([manual], learned))
  assert.equal(appendLearnedRule([manual], learned).added, false)
})

test("the same command in another workspace is a separate grant", () => {
  const a = buildLearnedRule({ tool: "bash", command: "npm test", workspace: "/repo-a" })
  const b = buildLearnedRule({ tool: "bash", command: "npm test", workspace: "/repo-b" })
  const out = appendLearnedRule(appendLearnedRule([], a).rules, b)
  assert.equal(out.added, true)
  assert.equal(out.rules.length, 2)
})

test("forgetting removes learned rules only and never touches hand-written ones", () => {
  const manual = { tool: "read", action: "allow" }
  const learnedA = buildLearnedRule({ tool: "bash", command: "npm test", workspace: "/repo" })
  const learnedB = buildLearnedRule({ tool: "bash", command: "git push", workspace: "/repo" })
  const rules = [manual, learnedA, learnedB]

  assert.equal(listLearnedRules(rules).length, 2)
  assert.equal(isLearnedRule(manual), false)

  const one = removeLearnedRules(rules, { index: 0 })
  assert.deepEqual(one.removed, [learnedA])
  assert.deepEqual(one.rules, [manual, learnedB])

  const all = removeLearnedRules(rules, { all: true })
  assert.equal(all.removed.length, 2)
  assert.deepEqual(all.rules, [manual])

  assert.deepEqual(removeLearnedRules(rules, { index: 99 }).removed, [])
})

test("workspace scoping keeps a grant from leaking into another repo", () => {
  const rule = buildLearnedRule({ tool: "bash", command: "npm test", workspace: "/repo-a" })
  assert.equal(matchRule(rule, { tool: "bash", command: "npm test", workspace: "/repo-a" }), true)
  assert.equal(matchRule(rule, { tool: "bash", command: "npm test", workspace: "/repo-b" }), false)

  // rules without a workspace stay global, preserving 0.3.x semantics
  const global = { tool: "bash", action: "allow", command_prefix: "npm test" }
  assert.equal(matchRule(global, { tool: "bash", command: "npm test", workspace: "/anywhere" }), true)
})

test("a persisted grant short-circuits evaluation on the next run", () => {
  const config = {
    permission: {
      level: "manual",
      rules: [buildLearnedRule({ tool: "bash", command: "npm test", workspace: "/repo" })]
    }
  }
  const granted = evaluatePermission({ config, tool: "bash", command: "npm test -- --watch", workspace: "/repo" })
  assert.equal(granted.action, "allow")
  assert.equal(granted.source, "rule")

  const elsewhere = evaluatePermission({ config, tool: "bash", command: "npm test", workspace: "/other" })
  assert.equal(elsewhere.action, "ask")
})

test("always-allow invokes the persist handler and still grants when saving fails", async (t) => {
  t.after(() => {
    setPermissionPromptHandler(null)
    PermissionEngine.setPersistGrantHandler(null)
    PermissionEngine.setTrusted(false)
    PermissionEngine.clearSession("sid-persist")
    PermissionEngine.clearSession("sid-persist-fail")
  })

  PermissionEngine.setTrusted(true)
  setPermissionPromptHandler(() => "allow_always")

  const calls = []
  PermissionEngine.setPersistGrantHandler(async (grant) => {
    calls.push(grant)
    return true
  })

  const result = await PermissionEngine.check({
    config: { permission: { level: "manual", rules: [] } },
    sessionId: "sid-persist",
    tool: "bash",
    mode: "agent",
    command: "npm test",
    workspace: "/repo"
  })

  assert.equal(result.decision, "allow_always")
  assert.equal(result.granted, true)
  assert.equal(result.persisted, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, "bash")
  assert.equal(calls[0].workspace, "/repo")

  // a failing persist must not break the in-flight tool call
  PermissionEngine.setPersistGrantHandler(async () => { throw new Error("disk full") })
  const degraded = await PermissionEngine.check({
    config: { permission: { level: "manual", rules: [] } },
    sessionId: "sid-persist-fail",
    tool: "bash",
    mode: "agent",
    command: "npm run build",
    workspace: "/repo"
  })
  assert.equal(degraded.granted, true)
  assert.equal(degraded.persisted, false)
})

test("describeRule renders a scannable single line", () => {
  assert.equal(
    describeRule(buildLearnedRule({ tool: "bash", command: "npm test", workspace: "/repo" })),
    "allow bash `npm test` @/repo"
  )
  assert.equal(
    describeRule(buildLearnedRule({ tool: "write", pattern: "src/a.mjs", workspace: "/repo" })),
    "allow write src/a.mjs @/repo"
  )
  assert.equal(describeRule({ tool: "read", action: "allow" }), "allow read *")
})
