import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const registry = new Map()

function promptPath(name) {
  return path.join(__dirname, "prompt", `${name}.txt`)
}

async function loadPrompt(name) {
  try {
    return (await readFile(promptPath(name), "utf8")).trim()
  } catch {
    return ""
  }
}

export function defineAgent(spec) {
  const agent = {
    name: spec.name,
    description: spec.description || "",
    mode: spec.mode || "primary",
    permission: spec.permission || "default",
    tools: spec.tools || null,
    model: spec.model || null,
    temperature: spec.temperature ?? null,
    hidden: spec.hidden || false,
    promptFile: spec.promptFile || spec.name,
    _promptCache: spec._promptCache ?? null,
    _customAgent: spec._customAgent || false,
    _scope: spec._scope || null,
    _source: spec._source || null
  }
  registry.set(agent.name, agent)
  return agent
}

export async function getAgentPrompt(name) {
  const agent = registry.get(name)
  if (!agent) return ""
  if (agent._promptCache !== null) return agent._promptCache
  agent._promptCache = await loadPrompt(agent.promptFile)
  return agent._promptCache
}

export function getAgent(name) {
  return registry.get(name) || null
}

export function listAgents({ includeHidden = false } = {}) {
  const agents = [...registry.values()]
  return includeHidden ? agents : agents.filter((a) => !a.hidden)
}

export function resolveAgentForMode(mode) {
  if (registry.has(mode)) return registry.get(mode)
  const modeMap = { ask: "build", plan: "plan", agent: "build", longagent: "longagent" }
  const mapped = modeMap[mode]
  return mapped ? registry.get(mapped) || null : null
}

defineAgent({
  name: "build",
  description: "Default agent with full tool access for code development",
  mode: "primary",
  permission: "full",
  tools: null
})

defineAgent({
  name: "plan",
  description: "Read-only analysis agent, no file editing allowed",
  mode: "primary",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "bash"]
})

defineAgent({
  name: "explore",
  description: "Fast file search subagent for codebase exploration",
  mode: "subagent",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "bash"]
})

defineAgent({
  name: "longagent",
  description: "Persistent iterative execution agent for complex multi-step tasks",
  mode: "primary",
  permission: "full",
  tools: null
})

defineAgent({
  name: "reviewer",
  description: "Code review specialist for analyzing code quality, bugs, and security issues",
  mode: "subagent",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "bash"]
})

defineAgent({
  name: "researcher",
  description: "Deep codebase research and web-augmented exploration agent",
  mode: "subagent",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "bash", "websearch", "codesearch", "webfetch"]
})

defineAgent({
  name: "architect",
  description: "Feature architecture designer. Analyzes codebase patterns, designs implementation blueprints with specific files, component designs, data flows.",
  mode: "subagent",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "bash"]
})

defineAgent({
  name: "guide",
  description: "kkcode self-help guide. Answers questions about kkcode features, tools, configuration, modes, skills, hooks, MCP servers, and usage patterns by searching the kkcode source code.",
  mode: "subagent",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "webfetch", "websearch"]
})

defineAgent({
  name: "compaction",
  description: "Conversation summarizer for context compression",
  mode: "subagent",
  permission: "none",
  tools: [],
  hidden: true
})

defineAgent({
  name: "title",
  description: "Session title generator",
  mode: "subagent",
  permission: "none",
  tools: [],
  hidden: true
})
