import test from "node:test"
import assert from "node:assert/strict"
import {
  renderInstalledCommandSurface,
  describeReloadSummary,
  renderSkillDirectory,
  describeNoSkills
} from "../src/repl/command-surface.mjs"
import { buildSkillCatalog, slashSuggestions } from "../src/repl/slash-router.mjs"

test("renderInstalledCommandSurface renders empty state", () => {
  assert.deepEqual(renderInstalledCommandSurface(), ["no custom commands or skills found"])
})

test("renderInstalledCommandSurface renders commands and non-template skills", () => {
  const lines = renderInstalledCommandSurface({
    customCommands: [{ name: "ship", scope: "project", source: ".kkcode/commands/ship.md" }],
    skills: [
      { name: "review", type: "skill_md", scope: "project" },
      { name: "init", type: "template", scope: "project" }
    ]
  })
  assert.deepEqual(lines, [
    "custom commands:",
    "  /ship (project) -> .kkcode/commands/ship.md",
    "skills:",
    "  $review (skill_md, project)"
  ])
})

/**
 * `/skills` 的目录视图。
 *
 * 它要回答三件事：有哪些技能、来自哪里、怎么调用。下面的用例把「怎么调用」
 * 与 `$` 补全钉在一起 —— 两边如果各扫各的注册表，分叉时不会有任何东西红，
 * 用户只会发现「补全里有的技能 /skills 里没有」。
 */

const SKILLS = [
  { name: "code-review", description: "Review code changes and flag risk.", type: "skill_md", scope: "global" },
  { name: "deploy-check", description: "Pre-deploy checklist for this repo.", type: "skill_md", scope: "project" },
  { name: "commit", description: "commit", type: "mjs", scope: "builtin" },
  { name: "brainstorm", description: "Claude 生态里带过来的技能", type: "skill_md", scope: "global", sourceEcosystem: "claude" }
]

const render = (patch = {}) => renderSkillDirectory({
  catalog: buildSkillCatalog({ skills: SKILLS }),
  skills: SKILLS,
  userSkillDir: "~/.kkcode/skills",
  projectSkillDir: ".kkcode/skills",
  ...patch
})

test("renderSkillDirectory 给出名字、描述、来源与调用方式", () => {
  const text = render().join("\n")
  assert.match(text, /\$code-review\s+Review code changes and flag risk\./)
  assert.match(text, /\$deploy-check\s+Pre-deploy checklist for this repo\./)
  // 来源按用户级 / 项目级分组 —— 用户要知道这个技能改起来该动哪个目录
  assert.match(text, /\n {2}user \(2\)\n/)
  assert.match(text, /\n {2}project \(1\)\n/)
  assert.match(text, /\n {2}built-in \(1\)\n/)
  // 怎么调用：`$名字`，并给一个真实存在的例子
  assert.match(text, /\$名字/)
  assert.match(text, /例：\$(code-review|deploy-check|commit|brainstorm)/)
  // 下一步：新建与两个目录
  assert.match(text, /\/create-skill <描述>/)
  assert.match(text, /~\/\.kkcode\/skills\//)
  assert.match(text, /\.kkcode\/skills\//)
})

test("列出的技能就是 `$` 补全会给的那一份，不是第二份枚举", () => {
  // 自定义命令同名时会遮蔽技能（buildSkillCatalog 的既有规则）。`/skills` 复用
  // 同一个函数，所以被遮蔽的那个在两边同时消失 —— 这条用例把这件事钉死。
  const customCommands = [{ name: "deploy-check", scope: "project", source: ".kkcode/commands/deploy-check.md" }]
  const options = { customCommands, skills: SKILLS }
  const text = renderSkillDirectory({ catalog: buildSkillCatalog(options), skills: SKILLS }).join("\n")

  const completionNames = slashSuggestions("$", options).map((item) => item.name)
  assert.ok(!completionNames.includes("deploy-check"), "前提：被自定义命令遮蔽的技能不进 `$` 补全")
  assert.ok(!text.includes("$deploy-check"), "补全里没有的技能不该出现在 /skills 里")
  for (const name of completionNames) {
    assert.ok(text.includes(`$${name}`), `补全里有 $${name}，/skills 却没列出来`)
  }
})

test("没写描述的技能不打印一遍自己的名字", () => {
  // 注册表在缺 description 时把描述回落成技能名。照抄出来就是 "$commit commit"。
  const text = render().join("\n")
  assert.doesNotMatch(text, /\$commit\s+commit\s*$/m)
  assert.match(text, /\$commit\s+skill \(mjs\)/)
})

test("非 kkcode 生态的技能带出处标记", () => {
  assert.match(render().join("\n"), /\$brainstorm\s+\[claude\]/)
})

test("窄终端下描述被截断，行不会挤成一团", () => {
  const lines = render({ width: 60 })
  for (const line of lines) {
    assert.ok(line.length <= 60, `行超宽: ${line.length} 列 —— ${line}`)
  }
  assert.ok(lines.join("\n").includes("$code-review"), "截断不该把名字也吃掉")
})

test("一个技能都没有时给出下一步，而不是一个空列表", () => {
  const lines = renderSkillDirectory({ catalog: [], skills: [] })
  assert.equal(lines.length, 1)
  assert.equal(lines[0], describeNoSkills())
  assert.match(lines[0], /\/create-skill/)
  assert.match(lines[0], /~\/\.kkcode\/skills\//)
  assert.match(lines[0], /\.kkcode\/skills\//)
})

test("describeReloadSummary formats counts", () => {
  assert.equal(
    describeReloadSummary({ commandCount: 2, skillCount: 5, agentCount: 1 }),
    "reloaded commands: 2, skills: 5, agents: 1"
  )
})
