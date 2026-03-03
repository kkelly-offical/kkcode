import { Command } from "commander"
import { ensureDefaultSkillPack } from "../skill/registry.mjs"

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
    .command("init")
    .description("initialize built-in skill packs")
    .option("--project", "initialize project scope .kkcode/skills")
    .option("--global", "initialize global scope ~/.kkcode/skills")
    .option("--all", "initialize both project and global scope")
    .option("--force", "overwrite existing files")
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

      console.log("skill init summary:")
      for (const line of formatSummary(results)) {
        console.log(`- ${line}`)
      }
      if (!results.length) {
        console.log("- no target directories selected")
      }
      console.log("tip:")
      console.log("  kkcode skill init --project   # initialize .kkcode/skills")
      console.log("  kkcode skill init --global    # initialize ~/.kkcode/skills")
      console.log("  kkcode skill init            # initialize both")
    })

  return cmd
}
