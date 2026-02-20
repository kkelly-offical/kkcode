import path from "node:path"
import { access, readdir, readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { parseYaml } from "../util/yaml.mjs"
import { defineAgent, getAgent } from "./agent.mjs"

const state = {
  agents: new Map(),
  loaded: false,
  loadedAt: 0
}

async function exists(target) {
  try { await access(target); return true } catch { return false }
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
    tools: Array.isArray(spec.tools) ? spec.tools : null,
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
    tools: Array.isArray(mod.tools) ? mod.tools : null,
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
    tools: meta["allowed-tools"] || (Array.isArray(meta.tools) ? meta.tools : null),
    model: meta.model || null,
    temperature: meta.temperature ?? null,
    hidden: meta.hidden || false,
    maxTurns: meta.maxTurns || meta["max-turns"] || null,
    prompt: body || "",
    scope,
    source: filePath
  }
}

async function loadAgentsFromDir(dir, scope) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const agents = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    const full = path.join(dir, entry.name)
    try {
      if (ext === ".yaml" || ext === ".yml") {
        const agent = await loadYamlAgent(full, scope)
        if (agent) agents.push(agent)
      } else if (ext === ".mjs") {
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
  async initialize(cwd = process.cwd()) {
    state.agents.clear()
    const userRoot = process.env.USERPROFILE || process.env.HOME || cwd
    const globalDir = path.join(userRoot, ".kkcode", "agents")
    const projectDir = path.join(cwd, ".kkcode", "agents")

    const [globalAgents, projectAgents] = await Promise.all([
      loadAgentsFromDir(globalDir, "global"),
      loadAgentsFromDir(projectDir, "project")
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

    state.loaded = true
    state.loadedAt = Date.now()
  },

  isReady() { return state.loaded },

  list() { return [...state.agents.values()] },

  get(name) { return state.agents.get(name) || null },

  listForSystemPrompt() {
    return [...state.agents.values()].map((a) => ({
      name: a.name,
      description: a.description,
      permission: a.permission,
      tools: a.tools
    }))
  }
}
