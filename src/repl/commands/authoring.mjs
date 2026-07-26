/**
 * 帮助、扩展装配、后台任务、剪贴板与档案类命令。
 *
 * 放在一起的理由：它们都不改会话状态，只是查询、生成或装配周边资源。
 * `/create-skill` 与 `/create-agent` 形状完全相同（描述 → 调模型生成 → 落盘 →
 * 重建注册表 → 报告可用），所以共用 `runGenerator`：此前它们是两段各 38 行的
 * 近似复制，改一处漏另一处的典型温床。
 */

import { resolve as resolvePath } from "node:path"
import { buildHelpText, buildShortcutLegend } from "../../ui/repl-help.mjs"
import { renderCapabilityPanel } from "../../ui/repl-capability-panel.mjs"
import { renderInstalledCommandSurface, describeReloadSummary } from "../command-surface.mjs"
import { buildCapabilitySnapshot } from "../capability-facade.mjs"
import { loadCustomCommands } from "../../command/custom-commands.mjs"
import { resolveExtensionPolicy } from "../../context.mjs"
import { SkillRegistry } from "../../skill/registry.mjs"
import { ToolRegistry } from "../../tool/registry.mjs"
import { McpRegistry } from "../../mcp/registry.mjs"
import { generateSkill, saveSkillGlobal } from "../../skill/generator.mjs"
import { readClipboardImage } from "../../tool/image-util.mjs"
import { userRootDir } from "../../storage/paths.mjs"

function displayUserRootPath() {
  const userRoot = userRootDir()
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return userRoot
  const homeNorm = resolvePath(home).replace(/\\/g, "/")
  const rootNorm = resolvePath(userRoot).replace(/\\/g, "/")
  if (rootNorm === homeNorm) return "~"
  if (rootNorm.startsWith(`${homeNorm}/`)) return `~${rootNorm.slice(homeNorm.length)}`
  return userRoot
}

export function helpText(providers = []) {
  return buildHelpText({ providers, userRootPath: displayUserRootPath() })
}

/**
 * `/create-skill` 与 `/create-agent` 的共同形状。
 *
 * 生成物**留在对话记录里**（不走浮层、不走提示）：用户需要看完整内容、
 * 需要能往回滚，而这两者浮层与提示都做不到。
 */
async function runGenerator({
  kind, description, print, state, ctx,
  generate, save, reload, announce
}) {
  print(`generating ${kind}: ${description}`)
  try {
    const artifact = await generate({
      description,
      configState: ctx.configState,
      providerType: state.providerType,
      model: state.model,
      baseUrl: null,
      apiKeyEnv: null
    })
    if (!artifact) {
      print(`${kind} generation failed — no output from model`, { channel: "notice", topic: "command", tone: "error" })
      return { exit: false }
    }
    print(`--- ${artifact.filename} ---`)
    print(artifact.content)
    print("---")
    const savedPath = await save(artifact.filename, artifact.content)
    print(`saved to: ${savedPath}`)
    await reload(ctx)
    print(announce(artifact), { channel: "notice", topic: "command" })
  } catch (error) {
    print(`${kind} generation error: ${error.message}`, { channel: "notice", topic: "command", tone: "error" })
  }
  return { exit: false }
}

export const authoringCommands = [
  {
    names: ["help", "h", "?"],
    desc: "show help",
    argMode: "none",
    run: ({ showInfo, providersConfigured }) => {
      showInfo("help · slash commands and shortcuts", helpText(providersConfigured), { maxRows: 18 })
      return { exit: false }
    }
  },

  {
    names: ["keys", "k"],
    desc: "show key map",
    argMode: "none",
    run: ({ showInfo }) => {
      showInfo("keyboard shortcuts", buildShortcutLegend(), { maxRows: 16 })
      return { exit: false }
    }
  },

  {
    names: ["commands"],
    desc: "list custom slash commands",
    argMode: "none",
    run: async ({ showInfo, state, ctx, customCommands }) => {
      const skills = SkillRegistry.isReady() ? SkillRegistry.list() : []
      const { CustomAgentRegistry } = await import("../../agent/custom-agent-loader.mjs")
      const capabilitySnapshot = await buildCapabilitySnapshot({
        mode: state.mode,
        cwd: process.cwd(),
        configState: ctx.configState,
        customCommands,
        skillRegistry: SkillRegistry,
        toolRegistry: ToolRegistry,
        mcpRegistry: McpRegistry,
        listAgents: () => CustomAgentRegistry.list()
      })
      showInfo("commands & capabilities", [
        ...renderInstalledCommandSurface({ customCommands, skills }),
        "",
        ...renderCapabilityPanel(capabilitySnapshot)
      ].join("\n"), { maxRows: 18 })
      return { exit: false }
    }
  },

  {
    names: ["reload"],
    desc: "reload custom commands",
    argMode: "none",
    run: async ({ print, ctx, setCustomCommands }) => {
      const extensionPolicy = resolveExtensionPolicy(ctx.configState)
      const reloaded = await loadCustomCommands(process.cwd(), {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      setCustomCommands(reloaded)
      await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      const { CustomAgentRegistry } = await import("../../agent/custom-agent-loader.mjs")
      await CustomAgentRegistry.initialize(process.cwd(), {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      const skillCount = SkillRegistry.isReady() ? SkillRegistry.list().length : 0
      const agentCount = CustomAgentRegistry.list().length
      print(describeReloadSummary({ commandCount: reloaded.length, skillCount, agentCount }), { channel: "notice", topic: "command" })
      return { exit: false }
    }
  },

  {
    names: ["agents"],
    desc: "list subagents with their permission tier",
    argMode: "none",
    run: async ({ showInfo, ctx }) => {
      // CLI 侧一直有 `kkcode agent list`，REPL 里却看不到子智能体的存在与权限档。
      const { listAgents } = await import("../../agent/agent.mjs")
      const configured = ctx.configState.config.agent?.subagents || {}
      const rows = listAgents()
        .filter((agent) => agent.mode === "subagent")
        .map((agent) => {
          const override = configured[agent.name]
          const permission = override?.permission || agent.permission || "default"
          const tools = (override?.tools || agent.tools)
          return `  ${agent.name.padEnd(20)} ${String(permission).padEnd(10)} ${tools ? `tools: ${tools.join(", ")}` : "tools: all"}`
        })
      showInfo(`subagents (${rows.length})`, ["subagents (name / permission / tools)", ...rows].join("\n"))
      return { exit: false }
    }
  },

  {
    names: ["tasks"],
    desc: "list background tasks (add stop <id> / retry <id>)",
    argMode: "optional",
    run: async ({ args, print, showInfo, ctx }) => {
      const { BackgroundManager } = await import("../../orchestration/background-manager.mjs")
      const [action, taskId] = args.split(/\s+/).filter(Boolean)
      if (action === "stop" && taskId) {
        await BackgroundManager.cancel(taskId).catch(() => null)
        print(`task ${taskId} cancellation requested`, { channel: "notice", topic: "task" })
        return { exit: false }
      }
      if (action === "retry" && taskId) {
        const retried = await BackgroundManager.retry(taskId, ctx.configState.config).catch(() => null)
        print(retried ? `task ${taskId} retried (attempt ${retried.attempt})` : `task ${taskId} could not be retried`,
          { channel: "notice", topic: "task", tone: retried ? "success" : "warn" })
        return { exit: false }
      }
      const tasks = await BackgroundManager.list().catch(() => [])
      if (!tasks.length) {
        print("no background tasks", { channel: "notice", topic: "task" })
        return { exit: false }
      }
      const rows = tasks.slice(-20).map((task) => {
        const desc = String(task.description || "").slice(0, 48)
        return `  ${String(task.id).padEnd(24)} ${String(task.status).padEnd(12)} ${desc}`
      })
      showInfo(`background tasks (${tasks.length})`,
        ["background tasks (id / status / description)", ...rows, "", "  /tasks stop <id> · /tasks retry <id>"].join("\n"))
      return { exit: false }
    }
  },

  {
    names: ["create-skill"],
    desc: "generate a new skill via AI",
    argMode: "optional",
    run: async (cmd) => {
      const { args, print, state, ctx } = cmd
      if (!args) {
        print("usage: /create-skill <description of what the skill should do>", { channel: "notice", topic: "command", tone: "error" })
        print("example: /create-skill review code for security vulnerabilities")
        return { exit: false }
      }
      return runGenerator({
        kind: "skill",
        description: args,
        print, state, ctx,
        generate: generateSkill,
        save: saveSkillGlobal,
        reload: async (context) => {
          const extensionPolicy = resolveExtensionPolicy(context.configState)
          await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
            allowProjectSources: extensionPolicy.allowProjectSources
          })
        },
        announce: (skill) => `skill /${skill.name} is now available`
      })
    }
  },

  {
    names: ["create-agent"],
    desc: "generate a new sub-agent via AI",
    argMode: "optional",
    run: async (cmd) => {
      const { args, print, state, ctx } = cmd
      if (!args) {
        print("usage: /create-agent <description of what the agent should do>", { channel: "notice", topic: "command", tone: "error" })
        print("example: /create-agent code reviewer that focuses on security vulnerabilities")
        return { exit: false }
      }
      const { generateAgent, saveAgentGlobal } = await import("../../agent/generator.mjs")
      return runGenerator({
        kind: "agent",
        description: args,
        print, state, ctx,
        generate: generateAgent,
        save: saveAgentGlobal,
        reload: async (context) => {
          const { CustomAgentRegistry } = await import("../../agent/custom-agent-loader.mjs")
          const extensionPolicy = resolveExtensionPolicy(context.configState)
          await CustomAgentRegistry.initialize(process.cwd(), {
            allowProjectSources: extensionPolicy.allowProjectSources
          })
        },
        announce: (agent) => `agent "${agent.name}" is now available as a sub-agent`
      })
    }
  },

  {
    names: ["paste"],
    desc: "paste image from clipboard",
    argMode: "optional",
    run: async ({ args, print, pendingImages, clearPendingImages, runPromptTurn }) => {
      print("reading clipboard...")
      const clipBlock = await readClipboardImage({ onStatus: (msg) => { if (msg) print(msg) } })
      if (!clipBlock || clipBlock.type === "error") {
        print(clipBlock?.message ? `paste failed: ${clipBlock.message}` : "no image found in clipboard")
        return { exit: false }
      }
      if (!args) {
        // Just attach — store for next message
        pendingImages.push(clipBlock)
        print(`image pasted from clipboard (${pendingImages.length} image(s) attached, send a message to include)`, { channel: "notice", topic: "command" })
        return { exit: false, pastedImage: true }
      }
      // Has text — send immediately with the image
      const allImages = [...pendingImages, clipBlock]
      if (clearPendingImages) clearPendingImages()
      return runPromptTurn({ prompt: args, images: allImages })
    }
  },

  {
    names: ["profile"],
    desc: "view or edit your user profile",
    argMode: "optional",
    // 只认裸命令与 `edit` —— `/profile 别的什么` 落到 prompt 路径，与拆分前一致
    accepts: (args) => args === "" || args === "edit",
    run: async ({ args, print, suspendTui }) => {
      const { loadProfile, runOnboarding } = await import("../../onboarding.mjs")
      const current = await loadProfile()
      if (!args && current) {
        const lines = ["Current profile:"]
        if (current.beginner) {
          lines.push("  mode: beginner (using defaults)")
        } else {
          if (current.languages?.length) lines.push(`  languages: ${current.languages.join(", ")}`)
          if (current.tech_stack?.length) lines.push(`  tech stack: ${current.tech_stack.join(", ")}`)
          if (current.design_style) lines.push(`  style: ${current.design_style}`)
          if (current.extra_notes) lines.push(`  notes: ${current.extra_notes}`)
        }
        lines.push("")
        lines.push("Run /profile edit to update your profile.")
        print(lines.join("\n"))
        return { exit: false }
      }
      if (suspendTui) await suspendTui(runOnboarding)
      else await runOnboarding()
      return { exit: false }
    }
  },

  {
    names: ["like"],
    desc: "show welcome screen / re-run onboarding",
    argMode: "none",
    run: async ({ suspendTui }) => {
      const { runOnboarding } = await import("../../onboarding.mjs")
      if (suspendTui) await suspendTui(runOnboarding)
      else await runOnboarding()
      return { exit: false }
    }
  }
]
