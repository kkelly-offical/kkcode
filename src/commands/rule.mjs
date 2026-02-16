import { Command } from "commander"
import { loadRuleBlocks, renderRulesPrompt } from "../rules/load-rules.mjs"

export function createRuleCommand() {
  const cmd = new Command("rule").description("inspect global/project rule prompts")

  cmd
    .command("list")
    .description("list loaded rule files")
    .action(async () => {
      const blocks = await loadRuleBlocks(process.cwd())
      if (!blocks.length) {
        console.log("no rules found")
        return
      }
      for (const block of blocks) {
        console.log(`- [${block.scope}] ${block.file}`)
      }
    })

  cmd
    .command("show")
    .description("show merged rules prompt")
    .action(async () => {
      const text = await renderRulesPrompt(process.cwd())
      if (!text) {
        console.log("no rules found")
        return
      }
      console.log(text)
    })

  return cmd
}
