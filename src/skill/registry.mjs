import path from "node:path"
import { access, readdir, readFile } from "node:fs/promises"
import { pathToFileURL, fileURLToPath } from "node:url"
import { McpRegistry } from "../mcp/registry.mjs"
import { loadCustomCommands, applyCommandTemplate } from "../command/custom-commands.mjs"

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Load .mjs programmable skills from a directory.
 * Each .mjs file should export: { name, description, run(ctx) }
 * run() returns a string prompt to send to the model.
 */
async function loadMjsSkills(dir, scope) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
    .map((e) => e.name)
    .sort()

  const skills = []
  for (const file of files) {
    const full = path.join(dir, file)
    try {
      const mod = await import(pathToFileURL(full).href)
      const name = mod.name || path.basename(file, ".mjs")
      skills.push({
        name,
        description: mod.description || name,
        type: "mjs",
        scope,
        source: full,
        run: typeof mod.run === "function" ? mod.run : null
      })
    } catch {
      // Skip broken skill files silently
    }
  }
  return skills
}

/**
 * Convert custom commands (.md templates) to skill format.
 */
function customCommandsToSkills(commands) {
  return commands.map((cmd) => ({
    name: cmd.name,
    description: `custom command (${cmd.scope})`,
    type: "template",
    scope: cmd.scope,
    source: cmd.source,
    template: cmd.template
  }))
}

/**
 * Convert MCP prompts to skill format.
 */
function mcpPromptsToSkills(prompts) {
  return prompts.map((p) => ({
    name: p.name,
    description: p.description || `${p.server}:${p.name}`,
    type: "mcp_prompt",
    scope: "mcp",
    server: p.server,
    promptId: p.id,
    arguments: p.arguments || []
  }))
}

const state = {
  skills: new Map(),
  loaded: false
}

export const SkillRegistry = {
  /**
   * Load all skills from all sources.
   */
  async initialize(config, cwd = process.cwd()) {
    state.skills.clear()

    // Source 0: Built-in skills (shipped with kkcode)
    const builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin")
    const builtinSkills = await loadMjsSkills(builtinDir, "builtin")
    for (const skill of builtinSkills) {
      state.skills.set(skill.name, skill)
    }

    // Source 1: Custom commands (.md templates)
    const customCommands = await loadCustomCommands(cwd)
    for (const skill of customCommandsToSkills(customCommands)) {
      state.skills.set(skill.name, skill)
    }

    // Source 2: Programmable skills (.mjs)
    const userRoot = process.env.USERPROFILE || process.env.HOME || cwd
    const globalSkillDir = path.join(userRoot, ".kkcode", "skills")
    const projectSkillDir = path.join(cwd, ".kkcode", "skills")
    const [globalSkills, projectSkills] = await Promise.all([
      loadMjsSkills(globalSkillDir, "global"),
      loadMjsSkills(projectSkillDir, "project")
    ])
    // Project skills override global skills with same name
    for (const skill of [...globalSkills, ...projectSkills]) {
      state.skills.set(skill.name, skill)
    }

    // Source 3: MCP prompts (if MCP is initialized)
    if (McpRegistry.isReady()) {
      const prompts = McpRegistry.listPrompts()
      for (const skill of mcpPromptsToSkills(prompts)) {
        // Prefix MCP skills to avoid name collisions
        const key = `mcp:${skill.name}`
        state.skills.set(key, { ...skill, name: key })
      }
    }

    state.loaded = true
  },

  isReady() {
    return state.loaded
  },

  list() {
    return [...state.skills.values()]
  },

  get(name) {
    return state.skills.get(name) || null
  },

  /**
   * Execute a skill and return the expanded prompt string.
   */
  async execute(name, args = "", context = {}) {
    const skill = state.skills.get(name)
    if (!skill) return null

    if (skill.type === "mjs" && skill.run) {
      // Programmable skill — call run() to get prompt
      try {
        const result = await skill.run({
          args,
          cwd: context.cwd || process.cwd(),
          mode: context.mode || "agent",
          model: context.model || "",
          provider: context.provider || ""
        })
        return result == null ? "" : typeof result === "string" ? result : JSON.stringify(result)
      } catch (error) {
        return `skill execution error (${name}): ${error?.message || String(error)}`
      }
    }

    if (skill.type === "template" && skill.template) {
      // Template skill — expand $ARGUMENTS, $1, $2, etc.
      return applyCommandTemplate(skill.template, args, {
        path: context.cwd || process.cwd(),
        mode: context.mode || "agent",
        provider: context.provider || "",
        cwd: context.cwd || process.cwd(),
        project: path.basename(context.cwd || process.cwd())
      })
    }

    if (skill.type === "mcp_prompt" && skill.promptId) {
      // MCP prompt — fetch from server
      const promptArgs = {}
      if (args) {
        // Simple: pass entire args string as first argument
        const argDefs = skill.arguments || []
        if (argDefs.length === 1) {
          promptArgs[argDefs[0].name] = args
        } else if (argDefs.length > 1) {
          // Split args by spaces for multiple arguments
          const tokens = args.split(/\s+/)
          for (let i = 0; i < argDefs.length && i < tokens.length; i++) {
            promptArgs[argDefs[i].name] = tokens[i]
          }
        }
      }
      const result = await McpRegistry.getPrompt(skill.promptId, promptArgs)
      // MCP prompt result: { messages: [{ role, content: { type, text } }] }
      if (result?.messages) {
        return result.messages
          .map((m) => {
            if (typeof m.content === "string") return m.content
            if (m.content?.text) return m.content.text
            return ""
          })
          .filter(Boolean)
          .join("\n\n")
      }
      return JSON.stringify(result)
    }

    return null
  },

  /**
   * Return skill metadata for system prompt inclusion.
   */
  listForSystemPrompt() {
    return [...state.skills.values()].map((s) => ({
      name: s.name,
      description: s.description
    }))
  }
}
