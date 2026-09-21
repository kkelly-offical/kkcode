import { runtimeCwd } from "../core/runtime-context.mjs"
import { contextualObject } from '../core/runtime-context.mjs'
import path from "node:path"
import { access, readdir, readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { parseYaml } from "../../util/yaml.mjs"
import { defineAgent, getAgent, resetCustomAgents } from "./agent.mjs"
import { userRootDir } from "../../storage/paths.mjs"
import { discoverLocalPluginManifests, pluginComponentDirs } from "../plugin/manifest-loader.mjs"

const state = contextualObject('customAgentState', {
  agents: new Map(),
  loaded: false,
  loadedAt: 0,
  diagnostics: []
})

async function exists(target) {
  try { await access(target); return true } catch { return false }
}

// Agent permission vocabulary: none < readonly < default < full.
// tightenPermissionConfig() (session/loop.mjs) maps these onto approval levels.
const AGENT_PERMISSION_RANK = { none: 0, readonly: 1, default: 2, full: 3 }

function clampAgentPermission(requested, allowed) {
  const allowedList = Array.isArray(allowed) && allowed.length ? allowed : ["default"]
  const ceiling = Math.max(...allowedList.map((p) => AGENT_PERMISSION_RANK[p] ?? AGENT_PERMISSION_RANK.default))
  const requestedRank = AGENT_PERMISSION_RANK[requested] ?? AGENT_PERMISSION_RANK.default
  const clamped = Math.min(requestedRank, ceiling)
  return Object.keys(AGENT_PERMISSION_RANK).find((key) => AGENT_PERMISSION_RANK[key] === clamped) || "default"
}

// Portable ecosystems (Claude Code agents, etc.) write tool lists as a
// comma/space-separated scalar with PascalCase names ("Read, Write, Bash").
// kkcode names are lowercase; known aliases map onto the kkcode vocabulary and
// unknown names stay verbatim (they simply match nothing, which narrows —
// dropping them could collapse the list to empty and widen to full access).
const PORTABLE_TOOL_NAMES = new Map(Object.entries({
  read: "read", write: "write", edit: "edit", multiedit: "multiedit",
  bash: "bash", grep: "grep", glob: "glob", ls: "list", list: "list",
  webfetch: "webfetch", websearch: "websearch", task: "task",
  todowrite: "todowrite", notebookedit: "notebookedit", patch: "patch",
  question: "question", skill: "skill", sysinfo: "sysinfo",
  codesearch: "codesearch", http_request: "http_request"
}))

function normalizeAgentTools(raw, diagnostics, source) {
  if (raw === undefined || raw === null) return null
  const items = (Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/))
    .map((item) => String(item || "").trim())
    .filter(Boolean)
  if (!items.length) return null
  const tools = []
  for (const item of items) {
    const mapped = PORTABLE_TOOL_NAMES.get(item.toLowerCase())
    if (mapped) tools.push(mapped)
    else {
      // Unknown names stay in the list verbatim: they simply never match a
      // registered tool, which narrows. Dropping them would risk widening to
      // full access if the whole list collapsed to empty.
      tools.push(item)
      diagnostics.push({ kind: "agent_tool_unknown", tool: item, source })
    }
  }
  return [...new Set(tools)]
}

async function loadYamlAgent(filePath, scope) {
  const raw = await readFile(filePath, "utf8")
  const spec = parseYaml(raw)
  if (!spec?.name) return null
  return {
    name: spec.name,
    description: spec.description || spec.name,
    mode: spec.mode || "subagent",
    permission: spec.permission || "default",
    tools: normalizeAgentTools(spec.tools, state.diagnostics, filePath),
    model: spec.model || null,
    temperature: spec.temperature ?? null,
    hidden: spec.hidden || false,
    maxTurns: spec.maxTurns || spec.max_turns || null,
    prompt: spec.prompt || "",
    scope,
    source: filePath
  }
}

async function loadMjsAgent(filePath, scope) {
  const mod = await import(pathToFileURL(filePath).href + `?t=${Date.now()}`)
  if (!mod.name) return null
  return {
    name: mod.name,
    description: mod.description || mod.name,
    mode: mod.mode || "subagent",
    permission: mod.permission || "default",
    tools: normalizeAgentTools(mod.tools, state.diagnostics, filePath),
    model: mod.model || null,
    temperature: mod.temperature ?? null,
    hidden: mod.hidden || false,
    maxTurns: mod.maxTurns || mod.max_turns || null,
    prompt: mod.prompt || "",
    scope,
    source: filePath
  }
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw.trim() }
  try { return { meta: parseYaml(match[1]) || {}, body: match[2].trim() } }
  catch { return { meta: {}, body: raw.trim() } }
}

async function loadMdAgent(filePath, scope) {
  const raw = await readFile(filePath, "utf8")
  const { meta, body } = parseFrontmatter(raw)
  const name = meta.name || path.basename(filePath, ".md")
  return {
    name,
    description: meta.description || name,
    mode: meta.mode || "subagent",
    permission: meta.permission || "default",
    // Claude-style `tools: Read, Write` scalar used to fall through to null,
    // silently granting the agent full tool access.
    tools: normalizeAgentTools(meta["allowed-tools"] ?? meta.tools, state.diagnostics, filePath),
    model: meta.model || null,
    temperature: meta.temperature ?? null,
    hidden: meta.hidden || false,
    maxTurns: meta.maxTurns || meta["max-turns"] || null,
    prompt: body || "",
    scope,
    source: filePath
  }
}

async function loadAgentsFromDir(dir, scope, { allowExecutable = true } = {}) {
  if (!(await exists(dir))) return []
  const resolvedDir = path.resolve(dir)
  const entries = await readdir(dir, { withFileTypes: true })
  const agents = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    const full = path.resolve(dir, entry.name)
    // Path boundary check: ensure resolved path is within expected directory
    if (!full.startsWith(resolvedDir + path.sep) && full !== resolvedDir) continue
    try {
      if (ext === ".yaml" || ext === ".yml") {
        const agent = await loadYamlAgent(full, scope)
        if (agent) agents.push(agent)
      } else if (ext === ".mjs") {
        // Plugin-shipped agents are inventory-loaded like skills: importing an
        // .mjs agent executes its top-level code, which must not happen at
        // discovery time for third-party packages.
        if (!allowExecutable) {
          state.diagnostics.push({ kind: "agent_executable_skipped", source: full, scope })
          continue
        }
        const agent = await loadMjsAgent(full, scope)
        if (agent) agents.push(agent)
      } else if (ext === ".md") {
        const agent = await loadMdAgent(full, scope)
        if (agent) agents.push(agent)
      }
    } catch { /* skip broken agent files */ }
  }
  return agents
}

export const CustomAgentRegistry = {
  async initialize(cwd = runtimeCwd(), {
    allowProjectSources = true,
    config = {}
  } = {}) {
    state.agents.clear()
    state.diagnostics = []
    resetCustomAgents()
    const globalDir = path.join(userRootDir(), "agents")
    const projectDir = path.join(cwd, ".kkcode", "agents")

    const [globalAgents, projectAgents, pluginManifestState] = await Promise.all([
      loadAgentsFromDir(globalDir, "global"),
      allowProjectSources ? loadAgentsFromDir(projectDir, "project") : [],
      discoverLocalPluginManifests(cwd, config, { allowProjectSources })
    ])

    // Project agents override global agents with same name
    for (const agent of [...globalAgents, ...projectAgents]) {
      state.agents.set(agent.name, agent)
      defineAgent({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        permission: agent.permission,
        tools: agent.tools,
        model: agent.model,
        temperature: agent.temperature,
        hidden: agent.hidden,
        maxTurns: agent.maxTurns || null,
        promptFile: agent.name,
        _promptCache: agent.prompt || "",
        _customAgent: true,
        _scope: agent.scope,
        _source: agent.source
      })
    }

    // Plugin `agents` component dirs (manifest-loader already parsed them, but
    // nothing consumed them — a portable plugin shipping agents shipped nothing).
    // Plugin agents register under the canonical `plugin:name` and, when free,
    // the short name; they never override builtin or user-defined agents.
    for (const { dir, plugin } of pluginComponentDirs(pluginManifestState.plugins, "agents")) {
      const allowed = plugin.capabilities?.allowedAgentPermissions || ["default"]
      const loadedAgents = await loadAgentsFromDir(dir, `plugin:${plugin.scope}:${plugin.name}`, { allowExecutable: false })
      for (const agent of loadedAgents) {
        const permission = clampAgentPermission(agent.permission, allowed)
        if (permission !== agent.permission) {
          state.diagnostics.push({
            kind: "agent_permission_clamped",
            agent: agent.name,
            plugin: plugin.name,
            requested: agent.permission,
            effective: permission
          })
        }
        const canonicalName = `${plugin.name}:${agent.name}`
        const names = [canonicalName]
        if (!state.agents.has(agent.name) && !getAgent(agent.name)) names.push(agent.name)
        else state.diagnostics.push({ kind: "agent_alias_collision", name: agent.name, canonicalName, plugin: plugin.name })
        for (const name of names) {
          const registered = { ...agent, name, permission }
          state.agents.set(name, registered)
          defineAgent({
            name,
            description: agent.description,
            mode: agent.mode,
            permission,
            tools: agent.tools,
            model: agent.model,
            temperature: agent.temperature,
            hidden: agent.hidden,
            maxTurns: agent.maxTurns || null,
            promptFile: agent.name,
            _promptCache: agent.prompt || "",
            _customAgent: true,
            _scope: agent.scope,
            _source: agent.source
          })
        }
      }
    }

    state.loaded = true
    state.loadedAt = Date.now()
  },

  isReady() { return state.loaded },

  list() { return [...state.agents.values()] },

  get(name) { return state.agents.get(name) || null },

  diagnostics() { return [...state.diagnostics] },

  listForSystemPrompt() {
    return [...state.agents.values()].map((a) => ({
      name: a.name,
      description: a.description,
      permission: a.permission,
      tools: a.tools
    }))
  }
}
