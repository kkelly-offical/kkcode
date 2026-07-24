import { Command } from "commander"
import { ensureDefaultSkillPack, SkillRegistry } from "../skill/registry.mjs"
import { buildContext, resolveExtensionPolicy } from "../context.mjs"
import { userRootDir } from "../storage/paths.mjs"

function formatSummary(scopeResults) {
  const lines = []
  for (const item of scopeResults) {
    const created = item.created.join(", ")
    const skipped = item.skipped.join(", ")
    if (created.length) {
      lines.push(`[${item.scope}] created: ${created}`)
    }
    if (skipped.length) {
      lines.push(`[${item.scope}] already exists: ${skipped}`)
    }
  }
  return lines
}

export function createSkillCommand() {
  const cmd = new Command("skill").description("manage kkcode skills")

  cmd
    .command("list")
    .description("list loaded skills")
    .option("--json", "print structured output", false)
    .action(async (options) => {
      const ctx = await buildContext()
      const extensionPolicy = resolveExtensionPolicy(ctx.configState)
      const extensionConfig = {
        ...extensionPolicy.config,
        skills: { ...(extensionPolicy.config.skills || {}), auto_seed: false }
      }
      await SkillRegistry.initialize(extensionConfig, process.cwd(), {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      const skills = SkillRegistry.list()
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          total: skills.length,
          skills: skills.map((skill) => ({
            name: skill.name,
            canonicalName: skill.canonicalName || skill.name,
            aliases: skill.aliases || [],
            description: skill.description,
            type: skill.type,
            scope: skill.scope,
            source: skill.source || null,
            sourceEcosystem: skill.sourceEcosystem || "kkcode",
            pluginName: skill.plugin?.name || null,
            skillRoot: skill.skillRoot || skill.skillDir || null
          })),
          diagnostics: SkillRegistry.compatDiagnostics()
        }, null, 2))
        return
      }
      for (const skill of skills) {
        const label = skill.canonicalName || skill.name
        const ecosystem = skill.sourceEcosystem || "kkcode"
        console.log(`- $${label} [${ecosystem}] ${skill.description || ""}`.trim())
      }
      const diagnostics = SkillRegistry.compatDiagnostics()
      if (diagnostics.length) {
        console.log("diagnostics:")
        for (const item of diagnostics) console.log(`- ${item}`)
      }
    })

  cmd
    .command("init")
    .description("initialize built-in skill packs")
    .option("--project", "initialize project scope .kkcode/skills")
    .option("--global", "initialize global scope (KKCODE_HOME)/skills")
    .option("--all", "initialize both project and global scope")
    .option("--force", "overwrite existing files")
    .option("--json", "print structured output", false)
    .action(async (options) => {
      const cwd = process.cwd()
      const includeProject = options.all || options.project || (!options.global && !options.project)
      const includeGlobal = options.all || options.global || (!options.global && !options.project)

      const results = await ensureDefaultSkillPack({
        cwd,
        force: options.force || false,
        includeProject,
        includeGlobal
      })

      if (options.json) {
        console.log(JSON.stringify({ ok: true, cwd, includeProject, includeGlobal, results }, null, 2))
        return
      }

      console.log("skill init summary:")
      for (const line of formatSummary(results)) {
        console.log(`- ${line}`)
      }
      if (!results.length) {
        console.log("- no target directories selected")
      }
      console.log("tip:")
      const globalHint = userRootDir()
      console.log("  kkcode skill init --project   # initialize .kkcode/skills")
      console.log(`  kkcode skill init --global    # initialize ${globalHint}/skills`)
      console.log("  kkcode skill init            # initialize both")
    })

  return cmd
}
