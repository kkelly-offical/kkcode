import { padRight, displayWidth, clipPlainByWidth } from "./frame-primitives.mjs"

export function renderInstalledCommandSurface({ customCommands = [], skills = [] } = {}) {
  const lines = []
  if (!customCommands.length && !skills.length) return ["no custom commands or skills found"]

  if (customCommands.length) {
    lines.push("custom commands:")
    customCommands.forEach((cmd) => lines.push(`  /${cmd.name} (${cmd.scope}) -> ${cmd.source}`))
  }

  const nonTemplateSkills = skills.filter((skill) => skill.type !== "template")
  if (nonTemplateSkills.length) {
    lines.push("skills:")
    nonTemplateSkills.forEach((skill) =>
      lines.push(`  $${skill.name} (${skill.type}${skill.scope ? ", " + skill.scope : ""})`)
    )
  }

  return lines
}

export function describeReloadSummary({ commandCount, skillCount, agentCount }) {
  return `reloaded commands: ${commandCount}, skills: ${skillCount}, agents: ${agentCount}`
}

/**
 * 技能来源 → 给人看的分组名。
 *
 * 注册表的 scope 是**装载来源**，不是目录：`global` 同时覆盖 `~/.kkcode/skills`
 * 与兼容生态的 `~/.claude/skills`、`~/.agents/skills`。所以分组名只说「用户级 /
 * 项目级」，具体是哪个生态由行尾的 `[claude]` 标记补，不在组名里写死某个路径。
 */
const SCOPE_LABELS = new Map([
  ["global", "user"],
  ["project", "project"],
  ["custom", "custom dirs"],
  ["builtin", "built-in"],
  ["mcp", "mcp prompts"]
])

const SCOPE_ORDER = [...SCOPE_LABELS.keys()]

function scopeRank(scope) {
  const index = SCOPE_ORDER.indexOf(scope)
  return index < 0 ? SCOPE_ORDER.length : index
}

/**
 * 按**显示宽度**截断，不是按字符数：描述里混着 CJK（每个占两列），按 length
 * 算的话中文描述会正好在窄终端里撑破一行，而那种终端恰恰最需要这次截断。
 */
function clip(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim()
  if (max < 2 || displayWidth(value) <= max) return value
  return `${clipPlainByWidth(value, max - 1)}…`
}

/**
 * `/skills` 的目录视图。
 *
 * `catalog` 必须是 `buildSkillCatalog()` 的输出 —— `$` 补全读的就是它。这里不
 * 自己扫一遍注册表，是因为那会立刻变成第二份枚举：技能来源还在增加（插件、
 * MCP 提示、兼容生态目录），两份清单分叉时不会有任何东西红，用户只会发现
 * 「补全里有的技能 /skills 里没有」。注册表只用来补描述与来源。
 *
 * @param {object} p
 * @param {{name: string, desc: string}[]} p.catalog buildSkillCatalog 的结果
 * @param {object[]} p.skills SkillRegistry.list() 的结果，按 name 关联
 * @param {string} p.userSkillDir 用户级技能目录（展示用，已按 ~ 缩写）
 * @param {string} p.projectSkillDir 项目级技能目录
 * @param {number} [p.width] 可用宽度，描述超出时截断
 */
export function renderSkillDirectory({
  catalog = [],
  skills = [],
  userSkillDir = "~/.kkcode/skills",
  projectSkillDir = ".kkcode/skills",
  width = 100
} = {}) {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const rows = catalog.map((item) => {
    const skill = byName.get(item.name) || {}
    // 没写 description 的技能，注册表把描述回落成技能名本身 —— 那等于没有描述，
    // 此时用目录里的类型标注（`skill (skill_md)`）比重复一遍名字有用。
    const described = skill.description && skill.description !== item.name ? skill.description : ""
    return {
      name: item.name,
      scope: skill.scope || "unknown",
      ecosystem: skill.sourceEcosystem && skill.sourceEcosystem !== "kkcode" ? skill.sourceEcosystem : "",
      desc: described || item.desc || ""
    }
  })

  if (!rows.length) return [describeNoSkills({ userSkillDir, projectSkillDir })]

  const groups = new Map()
  for (const row of rows) {
    if (!groups.has(row.scope)) groups.set(row.scope, [])
    groups.get(row.scope).push(row)
  }
  const scopes = [...groups.keys()].sort((a, b) => (scopeRank(a) - scopeRank(b)) || a.localeCompare(b))

  const nameWidth = Math.min(30, Math.max(...rows.map((row) => row.name.length + 1)) + 2)
  const descWidth = Math.max(24, width - nameWidth - 6)

  const lines = [`${rows.length} skills · 调用方式 $名字（例：$${rows[0].name}），Tab 可补全`]
  for (const scope of scopes) {
    const group = groups.get(scope).sort((a, b) => a.name.localeCompare(b.name))
    lines.push("")
    lines.push(`  ${SCOPE_LABELS.get(scope) || scope} (${group.length})`)
    for (const row of group) {
      const tag = row.ecosystem ? `[${row.ecosystem}] ` : ""
      lines.push(`    ${padRight(`$${row.name}`, nameWidth)} ${clip(`${tag}${row.desc}`, descWidth)}`.trimEnd())
    }
  }
  lines.push("")
  // 页脚在窄终端里放不下就拆成三行，而不是让浮层把它折在任意一个字上
  const footer = `  新建 /create-skill <描述>  ·  用户级 ${userSkillDir}/  ·  项目级 ${projectSkillDir}/`
  if (displayWidth(footer) <= width) lines.push(footer)
  else lines.push("  新建 /create-skill <描述>", `  用户级 ${userSkillDir}/`, `  项目级 ${projectSkillDir}/`)
  return lines
}

/** 一条也没有时说清楚下一步 —— 打一个空列表等于让用户自己去猜。 */
export function describeNoSkills({
  userSkillDir = "~/.kkcode/skills",
  projectSkillDir = ".kkcode/skills"
} = {}) {
  return `还没有可用技能 —— /create-skill <描述> 生成一个，` +
    `或把 SKILL.md 放进 ${userSkillDir}/（用户级）或 ${projectSkillDir}/（项目级）后 /reload`
}
