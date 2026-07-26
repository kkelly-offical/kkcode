import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { evaluatePermission, toolCapability } from "../src/permission/rules.mjs"

/**
 * 技能可调用性。
 *
 * 症状是「技能读得出来、引用不了」：模型的系统提示里有完整的技能清单和 `$` 语法
 * 说明，`skill` 工具也注册了、描述也写了，但真跑一次的结果是
 *
 *   {"name":"skill","args":{"skill":"test-plan"},"status":"error",
 *    "output":"permission denied for tool skill (you declined it)"}
 *
 * 而那次运行带着 `--trust`，且是**非交互**的 —— 根本没有人可以「declined」。
 *
 * 根因：`skill` 被一刀切归为 `task` 能力（与派生子智能体同级）。默认 manual 档
 * 判 `ask`，而非交互环境的 `ask` 会落到 `permission.non_tty_default`（默认 deny）。
 * 于是技能在 `kkcode chat` / CI / 管道输入里彻底不可用。
 *
 * 修法不是把 `task` 放宽（那会连带放开子智能体），而是**按技能实际做什么分类**。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

const decide = (level, capability) =>
  evaluatePermission({
    tool: "skill",
    pattern: "some-skill",
    config: { permission: { level } },
    capability
  }).action

test("a prompt-only skill is allowed at every level, including readonly", () => {
  // template / skill_md 技能只是把模板展开成一段提示词，对系统零副作用 ——
  // 等价于用户自己把那段话打出来。展开之后模型要做什么，每一步仍然各自过权限。
  for (const level of ["readonly", "manual", "accept-edits", "yolo"]) {
    assert.equal(decide(level, "prompt"), "allow", `${level} 档不该拦住纯提示词展开`)
  }
})

test("a programmable skill still needs approval", () => {
  // mjs 技能会 skill.run()，执行任意 JS。放宽它就等于让模型静默跑代码。
  assert.equal(decide("readonly", "task"), "deny")
  assert.equal(decide("manual", "task"), "ask")
  assert.equal(decide("accept-edits", "task"), "allow")
  assert.equal(decide("yolo", "task"), "allow")
})

test("the prompt capability does not leak into shell or edit tiers", () => {
  // 加一档能力最容易出的错是顺手把别的也放开了
  assert.equal(decide("readonly", "risky-shell"), "deny")
  assert.equal(decide("manual", "risky-shell"), "ask")
  assert.equal(decide("manual", "edit"), "ask")
  assert.equal(decide("readonly", "edit"), "deny")
})

test("a tool may report its own capability, overriding the static table", () => {
  // bash 早就是这样（命令决定 safe-shell 还是 risky-shell）。技能同理 ——
  // 风险取决于参数的工具，一个名字对应不了一个固定档位。
  assert.equal(toolCapability("skill"), "task", "静态表仍是缺省")
  assert.equal(toolCapability("skill", "", { capability: "prompt" }), "prompt")
  assert.equal(toolCapability("bash", "git status"), "safe-shell")
  assert.equal(toolCapability("bash", "rm -rf /"), "risky-shell")
})

test("the skill tool classifies by skill type, and fails closed on the unknown", async () => {
  const { SkillRegistry } = await import("../src/skill/registry.mjs")
  const { ToolRegistry } = await import("../src/tool/registry.mjs")
  await SkillRegistry.initialize({}, ROOT, { allowProjectSources: true })
  await ToolRegistry.initialize({ config: {}, cwd: ROOT, allowProjectSources: true })
  const skillTool = await ToolRegistry.get("skill")
  assert.ok(typeof skillTool.capabilityFor === "function", "skill 工具应当自报能力")

  const byType = { mjs: 0, prompt: 0 }
  for (const skill of SkillRegistry.list()) {
    const capability = skillTool.capabilityFor({ skill: skill.name })
    if (skill.type === "mjs") {
      assert.equal(capability, "task", `可编程技能 ${skill.name} 必须仍需审批`)
      byType.mjs += 1
    } else {
      assert.equal(capability, "prompt", `提示词技能 ${skill.name} 不该要审批`)
      byType.prompt += 1
    }
  }
  assert.ok(byType.mjs > 0 && byType.prompt > 0, "两类技能都要被这条覆盖到")

  // 未知技能、空名字、注册表没就绪 —— 一律按需要审批处理
  assert.equal(skillTool.capabilityFor({ skill: "根本不存在的技能" }), "task")
  assert.equal(skillTool.capabilityFor({ skill: "" }), "task")
  assert.equal(skillTool.capabilityFor({}), "task")
})

test("the permission layer can see which skill is being invoked", async () => {
  // pattern 恒为 "*" 的话，规则没法针对某个技能，审批弹窗也说不出用户在批准哪一个
  const src = await readFile(path.join(ROOT, "src", "session", "loop.mjs"), "utf8")
  const fn = src.slice(src.indexOf("function toolPatternFromArgs("))
  const body = fn.slice(0, fn.indexOf("\n}") + 2)
  assert.notEqual(body.length, 2, "找不到 toolPatternFromArgs —— 这条断言需要更新")
  assert.match(body, /args\.skill/, "技能名必须进 pattern")
})

test("a non-interactive denial explains itself instead of blaming the user", async () => {
  // 「you declined it」在 kkcode chat / CI / 管道输入里是假的：那里没有人被问过。
  // 照抄交互文案会让人去找一个根本不存在的审批弹窗。
  const src = await readFile(path.join(ROOT, "src", "permission", "engine.mjs"), "utf8")
  const idx = src.indexOf("you declined it")
  assert.notEqual(idx, -1, "找不到交互文案 —— 这条断言需要更新")
  const around = src.slice(Math.max(0, idx - 600), idx + 600)
  assert.match(around, /canAskInteractively\(\)/, "拒绝文案必须先判断现在能不能问到人")
  assert.match(around, /non_tty_default/, "非交互文案要指出拒绝来自哪个配置")
})

test("canAskInteractively is what decides, not a guess about stdout alone", async () => {
  const { canAskInteractively, setPermissionPromptHandler } = await import("../src/permission/prompt.mjs")
  setPermissionPromptHandler(null)
  const withoutHandler = canAskInteractively()
  setPermissionPromptHandler(() => "deny")
  assert.equal(canAskInteractively(), true, "TUI 注册了处理器就是能问到人，与 isTTY 无关")
  setPermissionPromptHandler(null)
  assert.equal(canAskInteractively(), withoutHandler, "撤掉处理器应恢复原判定")
})
