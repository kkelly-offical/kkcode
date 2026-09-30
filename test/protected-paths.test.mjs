import test from "node:test"
import assert from "node:assert/strict"
import { checkProtectedPath, findProtectedAccess, bashTouchesProtected } from "../src/kernel/permission/protected-paths.mjs"
import { evaluatePermission, toolCapability } from "../src/kernel/permission/rules.mjs"
import { getSensitiveFilePatterns } from "../src/kernel/permission/file-edit-policy.mjs"
import { parseShellCommands } from '../src/kernel/permission/shell-analysis.mjs'

test('protected-write analysis binds redirections and mutation targets to their simple command', () => {
  for (const command of [
    "find . -not -path '*/.git/*' | head; cat web/package.json 2>/dev/null",
    "cat .git/config > report.txt",
    "grep foo .git/config; echo done >/dev/null",
    "cat ~/.bashrc | tee report.txt",
    "cp .git/config report.txt",
    "printf '%s' '.git' > report.txt",
    "bash -c 'cat .git/config; echo done >/dev/null'"
  ]) assert.equal(bashTouchesProtected(command), null, command)
  for (const command of [
    "find . -not -path '*/.git/*'; echo bad > .git/config",
    "cat README.md | tee .git/config",
    "cp source -t.git",
    "cp source --target-directory=.git",
    "install -d .git/hooks normal",
    "CONFIG=.git node -e 'require(\"fs\").writeFileSync(process.env.CONFIG+\"/config\", \"x\")'",
    "CONFIG=.git sh -c 'echo bad > \"$CONFIG/config\"'",
    "dd if=input of=.git/config",
    "git diff --output=.git/config",
    "git log --output .git/config",
    "sed -n 'w .git/config' input",
    "sed 's/a/b/w .git/config' input",
    "perl -e 'open(F, \">.git/config\")'",
    "rm .g\\it/config",
    "find .git -type f -delete",
    "bash -c 'echo bad > .git/config'",
    "echo $(rm -rf .git)",
    'echo `rm -rf .git`',
    'node -e "require(\'fs\').writeFileSync(\'.git/config\', \'bad\')"'
  ]) assert.ok(bashTouchesProtected(command), command)
})

test('shell lexical receipts preserve separators, literal quoting and uncertainty', () => {
  const parsed = parseShellCommands("npm test && npm run lint; cat 'a;b' 2>/dev/null")
  assert.equal(parsed.uncertain, false)
  assert.deepEqual(parsed.commands.map(item => item.separator), ['&&', ';', null])
  assert.deepEqual(parsed.commands[2].words, ['cat', 'a;b'])
  assert.deepEqual(parsed.commands[2].redirects, [{ operator: '>', target: '/dev/null' }])
  assert.equal(parseShellCommands('npm test && && true').uncertain, true)
  assert.equal(parseShellCommands('echo $(pwd)').uncertain, true)
  assert.equal(parseShellCommands("echo '$(pwd)'").uncertain, false)
  assert.equal(parseShellCommands('cat "unterminated').uncertain, true)
})

test("protected paths cover the four classes that git cannot undo", () => {
  for (const p of [".git/config", ".git/hooks/pre-commit", "sub/.git/index"]) {
    assert.equal(checkProtectedPath(p).protected, true, p)
  }
  for (const p of [".bashrc", "home/.zshrc", ".envrc"]) {
    assert.equal(checkProtectedPath(p).protected, true, p)
  }
  for (const p of [".npmrc", ".yarnrc.yml", "bunfig.toml"]) {
    assert.equal(checkProtectedPath(p).protected, true, p)
  }
  for (const p of [".kkcode/config.yaml", ".mcp.json", ".github/workflows/ci.yml"]) {
    assert.equal(checkProtectedPath(p).protected, true, p)
  }
})

test("protected paths do not over-match ordinary files", () => {
  // `.gitignore` 和 `.gitattributes` 常规改动，不该每次都弹窗
  for (const p of [".gitignore", ".gitattributes", "src/index.mjs", "README.md", "package.json", "docs/git/notes.md"]) {
    assert.equal(checkProtectedPath(p).protected, false, p)
  }
  // worktree 是 kkcode 自己造的隔离副本，挡它等于挡掉 worktree 隔离
  assert.equal(checkProtectedPath(".kkcode/worktrees/w1/src/a.mjs").protected, false)
})

test("windows separators are normalized", () => {
  assert.equal(checkProtectedPath(".git\\config").protected, true)
  assert.equal(checkProtectedPath("C:\\repo\\.github\\workflows\\ci.yml").protected, true)
})

test("a checked-in allow rule cannot bypass protection", () => {
  // 这是本文件里最要紧的一条：保护检查排在规则求值之前。
  // 若顺序反了，任何人往仓库里塞一条 allow 规则就能自我提权 ——
  // 而那条规则可能来自你刚 clone 的别人的仓库。
  const config = {
    permission: {
      level: "manual",
      rules: [{ tool: "write", pattern: ".git/**", action: "allow" }]
    }
  }
  const decision = evaluatePermission({ config, tool: "write", pattern: ".git/hooks/pre-commit" })
  assert.equal(decision.action, "ask")
  assert.equal(decision.source, "protected_path")
})

test("yolo does not bypass protection either", () => {
  const config = { permission: { level: "yolo", rules: [] } }
  assert.equal(evaluatePermission({ config, tool: "write", pattern: ".bashrc" }).action, "ask")
  // 而普通文件在 yolo 下照旧放行 —— 保护清单不是把 yolo 变回 manual
  assert.equal(evaluatePermission({ config, tool: "write", pattern: "src/a.mjs" }).action, "allow")
})

test('protected paths cannot turn inherited or direct denies into approvable asks', () => {
  for (const permission of [{ level: 'readonly' }, { level: 'yolo', rules: [{ tool: 'write', action: 'deny' }] }]) {
    assert.equal(evaluatePermission({ config: { permission }, tool: 'write', pattern: '.git/config' }).action, 'deny')
    assert.equal(evaluatePermission({ config: { permission: { level: 'yolo' } }, permissionCeilings: [permission], tool: 'write', pattern: '.git/config' }).action, 'deny')
  }
})

test("bash writes to protected paths are caught, reads are not", () => {
  assert.ok(bashTouchesProtected("echo x >> ~/.bashrc"))
  assert.ok(bashTouchesProtected("rm -rf .git"))
  assert.ok(bashTouchesProtected("cp evil .npmrc"))
  assert.ok(bashTouchesProtected("sed -i s/a/b/ .github/workflows/ci.yml"))

  // 纯读不该被拦：这些在排查问题时天天用
  assert.equal(bashTouchesProtected("cat ~/.bashrc"), null)
  assert.equal(bashTouchesProtected("git status"), null)
  assert.equal(bashTouchesProtected("grep foo .git/config"), null)
  // 不含受保护名字的写命令照常
  assert.equal(bashTouchesProtected("rm -rf dist"), null)
  // `.gitignore` 不该被 `.git` 的规则命中
  assert.equal(bashTouchesProtected("echo dist >> .gitignore"), null)
})

test("findProtectedAccess routes by tool kind", () => {
  assert.ok(findProtectedAccess({ tool: "write", pattern: ".npmrc" }))
  assert.ok(findProtectedAccess({ tool: "bash", command: "tee .envrc" }))
  // read 不写文件，不该走这条闸
  assert.equal(findProtectedAccess({ tool: "read", pattern: ".git/config" }), null)
  assert.equal(findProtectedAccess({ tool: "write", pattern: "src/a.mjs" }), null)
})

test("multiedit style multi-path input is checked entirely", () => {
  // 一次调用改多个文件时，只要有一个受保护就要问 —— 不能只看第一个
  assert.ok(findProtectedAccess({ tool: "multiedit", pattern: "src/a.mjs,.bashrc" }))
})

test("sensitive_file_patterns merges instead of replacing", () => {
  // 用户为了保护 secrets/** 加一条模式，不该把 .env 的保护顺带删掉
  const merged = getSensitiveFilePatterns({ tool: { sensitive_file_patterns: ["secrets/**"] } })
  assert.ok(merged.includes(".env"), "内置默认必须保留")
  assert.ok(merged.includes("secrets/**"), "自定义必须生效")

  // 真要去掉内置默认，得显式声明
  const replaced = getSensitiveFilePatterns({
    tool: { sensitive_file_patterns: ["secrets/**"], sensitive_file_patterns_replace: true }
  })
  assert.deepEqual(replaced, ["secrets/**"])

  // 没配就是纯默认
  assert.ok(getSensitiveFilePatterns({}).includes(".env"))
})

test("every registered git tool has an explicit capability", async () => {
  // 4-1 的回归闸：这些工具此前全部落到 "unknown"，于是 readonly 档全拒、
  // accept-edits 档全问 —— 那不是策略决定，是漏登记。
  const gitTools = [
    "git_status", "git_info", "git_list_snapshots", "git_snapshot", "git_restore",
    "git_delete_snapshot", "git_cleanup", "git_apply_patch",
    "git_auto_stage", "git_auto_commit", "git_auto_push", "git_full_auto_status"
  ]
  for (const name of gitTools) {
    assert.notEqual(toolCapability(name), "unknown", `${name} 未登记能力`)
  }
  assert.notEqual(toolCapability("task_group"), "unknown")
  assert.notEqual(toolCapability("task_parallel"), "unknown")
})

test("readonly tier lets read-only git tools through", () => {
  const config = { permission: { level: "readonly", rules: [] } }
  assert.equal(evaluatePermission({ config, tool: "git_status" }).action, "allow")
  assert.equal(evaluatePermission({ config, tool: "git_info" }).action, "allow")
  // 但会改工作区的 git 工具仍然拒
  assert.equal(evaluatePermission({ config, tool: "git_restore" }).action, "deny")
  assert.equal(evaluatePermission({ config, tool: "git_auto_push" }).action, "deny")
})

test("plan mode allows read-only work including git inspection", async () => {
  // plan 闸门此前是手写名单，漏了 sysinfo / question / task_list / git_status ——
  // 全是纯读，却在制定计划时被拦，而制定计划恰恰最需要看仓库现状。
  const { planModeAllows } = await import("../src/kernel/session/loop.mjs")
  assert.equal(typeof planModeAllows, "function", "闸门函数必须可测 —— 不可测就等于没有闸门")

  for (const name of ["read", "grep", "glob", "list", "sysinfo", "question",
                      "task_list", "task_get", "task", "task_group", "git_status", "git_info", "enter_plan", "exit_plan", "todo_read", "todowrite"]) {
    assert.equal(planModeAllows(name), true, `${name} 应在 plan 档放行`)
  }
  for (const name of ["write", "edit", "multiedit", "patch", "agent_send", "git_restore", "git_auto_push"]) {
    assert.equal(planModeAllows(name), false, `${name} 应在 plan 档拦下`)
  }
  // bash 按命令判定，不按工具名
  assert.equal(planModeAllows("bash", { command: "git status" }), true)
  assert.equal(planModeAllows("bash", { command: "rm -rf dist" }), false)
})
