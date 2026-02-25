#!/usr/bin/env node
import { Command } from "commander"
import { createThemeCommand } from "./commands/theme.mjs"
import { createUsageCommand } from "./commands/usage.mjs"
import { createReviewCommand } from "./commands/review.mjs"
import { createSessionCommand } from "./commands/session.mjs"
import { createChatCommand } from "./commands/chat.mjs"
import { createAgentCommand } from "./commands/agent.mjs"
import { createMcpCommand } from "./commands/mcp.mjs"
import { createPermissionCommand } from "./commands/permission.mjs"
import { createDoctorCommand } from "./commands/doctor.mjs"
import { createConfigCommand } from "./commands/config.mjs"
import { createPromptCommand } from "./commands/prompt.mjs"
import { createLongagentCommand } from "./commands/longagent.mjs"
import { createHookCommand } from "./commands/hook.mjs"
import { createCommandCommand } from "./commands/command.mjs"
import { createRuleCommand } from "./commands/rule.mjs"
import { createBackgroundCommand } from "./commands/background.mjs"
import { createInitCommand } from "./commands/init.mjs"
import { createAuditCommand } from "./commands/audit.mjs"
import { startRepl } from "./repl.mjs"

async function main() {
  const hasTrust = process.argv.includes("--trust")
  const hasGithub = process.argv.includes("--github")

  if (hasGithub) {
    const githubArgIndex = process.argv.indexOf("--github")
    const nextArg = process.argv[githubArgIndex + 1]
    
    if (nextArg === "logout") {
      const { logout } = await import("./github/auth.mjs")
      const success = await logout()
      if (success) {
        console.log("✓ 已登出 GitHub 账户")
      } else {
        console.log("⚠ 没有已登录的 GitHub 账户")
      }
      return
    }
    
    const { runGitHubFlow, promptPushChanges } = await import("./github/flow.mjs")
    const result = await runGitHubFlow()
    process.chdir(result.cwd)
    await startRepl({ trust: hasTrust })
    // After REPL exits, ask user if they want to push changes
    await promptPushChanges(result)
    return
  }

  if (process.argv.length <= 2 || (process.argv.length === 3 && hasTrust)) {
    await startRepl({ trust: hasTrust })
    return
  }

  const program = new Command()
  program.name("kkcode").description("kkcode CLI").version("0.1.6")
  program.addCommand(createChatCommand())
  program.addCommand(createThemeCommand())
  program.addCommand(createUsageCommand())
  program.addCommand(createReviewCommand())
  program.addCommand(createAgentCommand())
  program.addCommand(createMcpCommand())
  program.addCommand(createPermissionCommand())
  program.addCommand(createDoctorCommand())
  program.addCommand(createConfigCommand())
  program.addCommand(createSessionCommand())
  program.addCommand(createPromptCommand())
  program.addCommand(createLongagentCommand())
  program.addCommand(createHookCommand())
  program.addCommand(createCommandCommand())
  program.addCommand(createRuleCommand())
  program.addCommand(createBackgroundCommand())
  program.addCommand(createAuditCommand())
  program.addCommand(createInitCommand())
  await program.parseAsync(process.argv)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
