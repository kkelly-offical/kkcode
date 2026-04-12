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
      lines.push(`  /${skill.name} (${skill.type}${skill.scope ? ", " + skill.scope : ""})`)
    )
  }

  return lines
}

export function describeReloadSummary({ commandCount, skillCount, agentCount }) {
  return `reloaded commands: ${commandCount}, skills: ${skillCount}, agents: ${agentCount}`
}
