import path from "node:path"
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { pathToFileURL, fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parse as parseYaml } from "yaml"
import { McpRegistry } from "../mcp/registry.mjs"
import { loadCustomCommands, applyCommandTemplate } from "../command/custom-commands.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { userRootDir } from "../storage/paths.mjs"

const execFileAsync = promisify(execFile)

const DEFAULT_SKILL_DIR_README = `# kkcode Skills\n\nThis directory stores reusable skills for kkcode.\n\nWhen kkcode starts, skills in this directory are loaded automatically and can be invoked as slash commands (for example: \/code-review).\n\nDefault skill packs include:\n- code-review: structured review checklist for changed files\n- test-plan: lightweight test planning support\n\nAdd your own skills as:\n- .md files (simple templates)\n- .mjs files (programmable)\n- directories with SKILL.md (metadata + templates)`

const DEFAULT_SKILL_PACKS = [
  {
    dir: "code-review",
    content: `---\nname: code-review\ndescription: Review code changes and provide risk-oriented recommendations.\nuser-invocable: true\ncontext-fork: false\n---\n请基于以下内容做结构化代码评审：\n- 先给出风险分级（高/中/低）与范围\n- 列出 3 条以内关键问题\n- 给出最小可执行修复建议\n\n输入：\n$ARGUMENTS\n\n如果是目录或文件路径，请先说明覆盖范围后再给建议。`
  },
  {
    dir: "test-plan",
    content: `---\nname: test-plan\ndescription: Generate a compact test plan for task execution.\nuser-invocable: true\ncontext-fork: false\n---\n请为下列任务生成测试计划：\n$ARGUMENTS\n\n请输出：\n1) 关键测试场景（按优先级）\n2) 可执行命令顺序\n3) 关键验证标准\n4) 回归风险与缓解建议`
  }
]

function toText(v) {
  if (v === undefined || v === null) return ""
  return String(v)
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function writeIfMissing(filePath, content, force = false) {
  if (!force && await exists(filePath)) return false
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, toText(content), "utf8")
  return true
}

export async function ensureDefaultSkillPack({
  cwd = process.cwd(),
  force = false,
  includeProject = true,
  includeGlobal = true
} = {}) {
  const targets = []
  if (includeGlobal) {
    targets.push({ scope: "global", dir: path.join(userRootDir(), "skills") })
  }
  if (includeProject) {
    targets.push({ scope: "project", dir: path.join(cwd, ".kkcode", "skills") })
  }

  const created = []
  for (const target of targets) {
    const createdFiles = []
    const skippedFiles = []

    if (await writeIfMissing(path.join(target.dir, "README.md"), DEFAULT_SKILL_DIR_README, force)) {
      createdFiles.push("README.md")
    } else {
      skippedFiles.push("README.md")
    }

    for (const pack of DEFAULT_SKILL_PACKS) {
      const filePath = path.join(target.dir, pack.dir, "SKILL.md")
      if (await writeIfMissing(filePath, pack.content, force)) {
        createdFiles.push(`${pack.dir}/SKILL.md`)
      } else {
        skippedFiles.push(`${pack.dir}/SKILL.md`)
      }
    }

    created.push({
      scope: target.scope,
      dir: target.dir,
      created: createdFiles,
      skipped: skippedFiles
    })
  }

  return created
}

const DEFAULT_ALLOWED_COMMANDS = ["git", "node", "npm", "ls", "cat", "date", "pwd", "echo", "which"]
let _allowedCommands = null
let _allowedCommandsSig = null

function getAllowedCommands(config) {
  const extra = config?.skills?.allowed_commands || []
  const sig = extra.join(",")
  if (_allowedCommands && _allowedCommandsSig === sig) return _allowedCommands
  _allowedCommands = new Set([...DEFAULT_ALLOWED_COMMANDS, ...extra])
  _allowedCommandsSig = sig
  return _allowedCommands
}

// Shell metacharacters and control chars that enable command chaining / injection
const SHELL_INJECTION_RE = /[;|&`$(){}]|>\s*>|<\s*<|[\n\r]/

function isCommandAllowed(cmdString, config) {
  const allowed = getAllowedCommands(config)
  const trimmed = cmdString.trim()
  if (!trimmed) return false
  // Reject any shell control characters — prevents chaining like `git status; rm -rf /`
  if (SHELL_INJECTION_RE.test(trimmed)) return false
  // Extract the base command (first token, strip path)
  const firstToken = trimmed.split(/\s+/)[0] || ""
  const baseName = path.basename(firstToken)
  return allowed.has(baseName)
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Returns { meta: {}, body: string }
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw.trim() }
  try {
    return { meta: parseYaml(match[1]) || {}, body: match[2].trim() }
  } catch {
    return { meta: {}, body: raw.trim() }
  }
}

/**
 * Load plain .md skills from skill directories.
 * Supports optional YAML frontmatter.
 */
async function loadMarkdownSkills(dir, scope) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const mdFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort()

  const skills = []
  for (const name of mdFiles) {
    const lowerName = name.toLowerCase()
    if (lowerName === "skill.md" || lowerName === "readme.md") continue
    const filePath = path.join(dir, name)
    try {
      const raw = await readFile(filePath, "utf8")
      const trimmed = raw.trim()
      if (!trimmed) continue
      const { meta, body } = parseFrontmatter(trimmed)
      skills.push({
        name: meta.name || path.basename(name, ".md"),
        description: meta.description || path.basename(name, ".md"),
        type: "skill_md",
        scope,
        source: filePath,
        skillDir: path.dirname(filePath),
        template: body,
        auxFiles: {},
        disableModelInvocation: !!meta["disable-model-invocation"],
        userInvocable: meta["user-invocable"] !== false,
        allowedTools: meta["allowed-tools"] || null,
        model: meta.model || null,
        contextFork: !!meta["context-fork"]
      })
    } catch {
      // skip invalid markdown skill files
    }
  }
  return skills
}

/**
 * Load .mjs programmable skills from a directory.
 * Each .mjs file should export: { name, description, run(ctx) }
 * run() returns a string prompt to send to the model.
 */
async function loadMjsSkills(dir, scope) {
  if (!(await exists(dir))) return []
  const resolvedDir = path.resolve(dir)
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
    .map((e) => e.name)
    .sort()

  const skills = []
  for (const file of files) {
    const full = path.resolve(dir, file)
    // Path boundary check: ensure resolved path is within expected directory
    if (!full.startsWith(resolvedDir + path.sep) && full !== resolvedDir) continue
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

function shellTokenize(input) {
  const tokens = []
  let current = ""
  let inQuote = null
  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue }
      current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = "" }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

/**
 * Replace !`command` patterns with command stdout.
 * Commands are checked against a whitelist before execution.
 */
async function injectDynamicContext(template, cwd, config) {
  const pattern = /!\`([^`]+)\`/g
  const matches = [...template.matchAll(pattern)]
  if (!matches.length) return template
  let result = template
  for (const m of matches) {
    if (!isCommandAllowed(m[1], config)) {
      result = result.replace(m[0], `[blocked: ${m[1]}]`)
      EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_ALERT,
        payload: { kind: "skill_command_blocked", command: m[1] }
      }).catch(() => {})
      continue
    }
    try {
      const tokens = shellTokenize(m[1].trim())
      const cmd = tokens[0]
      const cmdArgs = tokens.slice(1)
      const { stdout } = await execFileAsync(cmd, cmdArgs, { cwd, timeout: 10000 })
      result = result.replace(m[0], stdout.trim())
    } catch {
      result = result.replace(m[0], `[command failed: ${m[1]}]`)
    }
  }
  return result
}

/**
 * Load SKILL.md directory-format skills from a directory.
 * Scans for <dir>/<name>/SKILL.md
 */
async function loadAuxFiles(skillDir) {
  const aux = {}
  const resolvedSkillDir = path.resolve(skillDir)
  try {
    const entries = await readdir(skillDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile() || e.name === "SKILL.md") continue
      const filePath = path.resolve(skillDir, e.name)
      // Path traversal protection: ensure file is within skillDir
      if (!filePath.startsWith(resolvedSkillDir + path.sep) && filePath !== resolvedSkillDir) {
        EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_ALERT,
          payload: { kind: "skill_path_traversal", file: e.name, skillDir }
        }).catch(() => {})
        continue
      }
      aux[e.name] = filePath
    }
  } catch { /* ignore */ }
  return aux
}

async function loadSkillDirs(dir, scope) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  const skills = []
  for (const name of dirs) {
    const skillDir = path.join(dir, name)
    const mdPath = path.join(skillDir, "SKILL.md")
    if (!(await exists(mdPath))) continue
    try {
      const raw = await readFile(mdPath, "utf8")
      const { meta, body } = parseFrontmatter(raw)
      const auxFiles = await loadAuxFiles(skillDir)
      skills.push({
        name: meta.name || name,
        description: meta.description || name,
        type: "skill_md",
        scope,
        source: mdPath,
        skillDir,
        template: body,
        auxFiles,
        disableModelInvocation: !!meta["disable-model-invocation"],
        userInvocable: meta["user-invocable"] !== false,
        allowedTools: meta["allowed-tools"] || null,
        model: meta.model || null,
        contextFork: !!meta["context-fork"]
      })
    } catch { /* skip broken */ }
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
    const autoSeed = config?.skills?.auto_seed !== false
    if (autoSeed) {
      try {
        await ensureDefaultSkillPack({ cwd, force: false, includeProject: true, includeGlobal: true })
      } catch {
        // Ignore seed failures (e.g., read-only mode)
      }
    }

    // Respect skills.enabled config — if explicitly false, skip all loading
    if (config?.skills?.enabled === false) {
      state.loaded = true
      return
    }

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

    // Source 2: Programmable skills (.mjs) + SKILL.md directories
    const userRoot = userRootDir()
    const customDirs = config?.skills?.dirs || []
    // Default directories: global (~/.kkcode/skills) + project (.kkcode/skills)
    const defaultDirs = [
      { dir: path.join(userRoot, "skills"), scope: "global" },
      { dir: path.join(cwd, ".kkcode", "skills"), scope: "project" }
    ]
    // Custom dirs from config (resolve relative to cwd)
    const extraDirs = customDirs.map(d => ({
      dir: path.isAbsolute(d) ? d : path.resolve(cwd, d),
      scope: "custom"
    }))
    const seenDirSet = new Set()
    const allSkillDirs = [...defaultDirs, ...extraDirs].filter((entry) => {
      const resolved = path.resolve(entry.dir)
      if (seenDirSet.has(resolved)) return false
      seenDirSet.add(resolved)
      return true
    })

    const loadPromises = allSkillDirs.flatMap(({ dir, scope }) => [
      loadMarkdownSkills(dir, scope),
      loadMjsSkills(dir, scope),
      loadSkillDirs(dir, scope)
    ])
    const results = await Promise.all(loadPromises)
    for (const skills of results) {
      for (const skill of skills) {
        state.skills.set(skill.name, skill)
      }
    }

    // Source 3: MCP prompts (if MCP is initialized)
    if (McpRegistry.isReady()) {
      const prompts = McpRegistry.listPrompts()
      for (const skill of mcpPromptsToSkills(prompts)) {
        // Include server name to avoid cross-server name collisions
        const key = `mcp:${skill.server}:${skill.name}`
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
          provider: context.provider || "",
          config: context.config || null
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

    if (skill.type === "skill_md" && skill.template) {
      const cwd = context.cwd || process.cwd()
      let prompt = applyCommandTemplate(skill.template, args, {
        path: cwd, mode: context.mode || "agent",
        provider: context.provider || "", cwd, project: path.basename(cwd)
      })
      // Resolve $FILE{name} references to auxiliary file contents
      if (skill.auxFiles) {
        const resolvedSkillDir = path.resolve(skill.skillDir)
        const filePattern = /\$FILE\{([^}]+)\}/g
        const fileMatches = [...prompt.matchAll(filePattern)]
        for (const m of fileMatches) {
          const filePath = skill.auxFiles[m[1]]
          if (filePath) {
            // Path traversal protection for $FILE{} references
            const resolvedFile = path.resolve(filePath)
            if (!resolvedFile.startsWith(resolvedSkillDir + path.sep)) {
              prompt = prompt.replace(m[0], `[blocked: path traversal: ${m[1]}]`)
              EventBus.emit({
                type: EVENT_TYPES.LONGAGENT_ALERT,
                payload: { kind: "skill_path_traversal", file: m[1], skillDir: skill.skillDir }
              }).catch(() => {})
              continue
            }
            try {
              const content = await readFile(filePath, "utf8")
              prompt = prompt.replace(m[0], content.trim())
            } catch {
              prompt = prompt.replace(m[0], `[file not found: ${m[1]}]`)
            }
          }
        }
      }
      prompt = await injectDynamicContext(prompt, cwd, context.config)
      if (skill.contextFork) {
        return { prompt, contextFork: true, model: skill.model }
      }
      return prompt
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
    return [...state.skills.entries()]
      .filter(([key, s]) => !s.disableModelInvocation && !key.startsWith("mcp:"))
      .map(([, s]) => ({ name: s.name, description: s.description }))
  }
}
