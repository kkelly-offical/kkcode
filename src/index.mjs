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
import { createPreflightCommand } from "./commands/preflight.mjs"
import { createConfigCommand } from "./commands/config.mjs"
import { createPromptCommand } from "./commands/prompt.mjs"
import { createLongagentCommand } from "./commands/longagent.mjs"
import { createHookCommand } from "./commands/hook.mjs"
import { createCommandCommand } from "./commands/command.mjs"
import { createRuleCommand } from "./commands/rule.mjs"
import { createBackgroundCommand } from "./commands/background.mjs"
import { createInitCommand } from "./commands/init.mjs"
import { createAuditCommand } from "./commands/audit.mjs"
import { createSkillCommand } from "./commands/skill.mjs"
import { createPluginCommand } from "./commands/plugin.mjs"
import { startRepl } from "./repl.mjs"
import { PACKAGE_VERSION } from "./version.mjs"
import { createUpdateCommand } from "./commands/update.mjs"
import { createModelCommand } from "./commands/model.mjs"
import { createProviderCommand } from "./commands/provider.mjs"
import { createRemoteCommand } from './commands/remote.mjs'
import { createBrowserCommand } from './commands/browser.mjs'
import { createAcpCommand } from './commands/acp.mjs'
import { createRunsCommand } from './commands/runs.mjs'
import { createArtifactsCommand } from './commands/artifacts.mjs'
import { createMemoryCommand } from './commands/memory.mjs'
import { createLspCommand } from './commands/lsp.mjs'
import { createOfficeCommand } from './commands/office.mjs'
import { createServicesCommand } from './commands/services.mjs'
import { createEnvironmentsCommand } from './commands/environments.mjs'

async function main() {
  if (process.argv[2] === 'ssh-host') {
    const { runSshHost } = await import('./remote/ssh-host.mjs')
    return runSshHost(process.argv.slice(3))
  }
  if (['-web', '--web'].includes(process.argv[2])) {
    const { runWeb } = await import('./commands/web.mjs')
    return runWeb(process.argv.slice(2))
  }
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
  program.name("kkcode").description("kkcode CLI").version(PACKAGE_VERSION)
  program.addCommand(createChatCommand())
  program.addCommand(createAcpCommand())
  program.addCommand(createThemeCommand())
  program.addCommand(createUsageCommand())
  program.addCommand(createReviewCommand())
  program.addCommand(createAgentCommand())
  program.addCommand(createMcpCommand())
  program.addCommand(createPermissionCommand())
  program.addCommand(createDoctorCommand())
  program.addCommand(createPreflightCommand())
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
  program.addCommand(createSkillCommand())
  program.addCommand(createPluginCommand())
  program.addCommand(createUpdateCommand())
  program.addCommand(createModelCommand())
  program.addCommand(createProviderCommand())
  program.addCommand(createRemoteCommand())
  program.addCommand(createBrowserCommand())
  program.addCommand(createRunsCommand())
  program.addCommand(createArtifactsCommand())
  program.addCommand(createMemoryCommand())
  program.addCommand(createLspCommand())
  program.addCommand(createOfficeCommand())
  program.addCommand(createServicesCommand())
  program.addCommand(createEnvironmentsCommand())
  await program.parseAsync(process.argv)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
