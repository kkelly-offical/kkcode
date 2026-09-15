import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const registry = new Map()
const baseRegistry = new Map()

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
    maxTurns: spec.maxTurns || null,
    hidden: spec.hidden || false,
    promptFile: spec.promptFile || spec.name,
    _promptCache: spec._promptCache ?? null,
    _customAgent: spec._customAgent || false,
    _scope: spec._scope || null,
    _source: spec._source || null
  }
  registry.set(agent.name, agent)
  if (!agent._customAgent) baseRegistry.set(agent.name, agent)
  return agent
}

export function resetCustomAgents() {
  for (const [name, agent] of registry) {
    if (agent._customAgent) registry.delete(name)
  }
  for (const [name, agent] of baseRegistry) registry.set(name, agent)
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
  const modeMap = { assistant: "assistant", plan: "plan", agent: "build", longagent: "longagent" }
  const mapped = modeMap[mode]
  return mapped ? registry.get(mapped) || null : null
}

defineAgent({
  name: "assistant",
  description: "Default CLI personal assistant for terminal-native personal work, local tasks, research, and lightweight automation",
  mode: "primary",
  permission: "full",
  tools: null
})

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
  tools: ["read", "glob", "grep", "list", "webfetch", "websearch", "question", "enter_plan", "exit_plan"]
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
  name: "security-reviewer",
  description: "Security audit specialist. Performs OWASP Top 10 checks, hardcoded secret scans, dependency audits, and authentication/authorization reviews.",
  mode: "subagent",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "bash"]
})

defineAgent({
  name: "tdd-guide",
  description: "TDD specialist. Guides and executes test-driven development: scaffold interfaces, write failing tests (RED), implement minimum code (GREEN), refactor (IMPROVE). Targets 80%+ coverage.",
  mode: "subagent",
  permission: "full",
  tools: ["read", "write", "edit", "bash", "glob", "grep", "list"]
})

defineAgent({
  name: "build-fixer",
  description: "Build error diagnosis and repair. Analyzes build failures, identifies root causes, applies fixes, and verifies the build succeeds. Supports TypeScript, Python, Go, Rust, Java.",
  mode: "subagent",
  permission: "full",
  tools: ["read", "write", "edit", "bash", "glob", "grep", "list"]
})

defineAgent({
  name: "frontend-designer",
  description: "Frontend design specialist. Creates polished, distinctive UIs with strong aesthetics — typography, color, motion, layout. Avoids generic AI-style designs. Reads project design system (Tailwind, CSS vars, component libraries) and produces production-grade frontend code.",
  mode: "subagent",
  permission: "full",
  tools: ["read", "write", "edit", "bash", "glob", "grep", "list"]
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

// Ultra stage agents.
//
// promptFile must be spelled out: it defaults to the agent name, but these
// prompts live under the longagent- prefix. Without it getAgentPrompt() silently
// returned "" and every stage ran with no role instructions at all.
defineAgent({
  name: "preview-agent",
  promptFile: "longagent-preview-agent",
  description: "Ultra stage 1 - Previewing Agent. Explores codebase, extracts requirements, no editing allowed.",
  mode: "subagent",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "bash", "question", "todowrite"]
})

defineAgent({
  name: "blueprint-agent",
  promptFile: "longagent-blueprint-agent",
  description: "Ultra stage 2 - Blueprint Agent. Creates detailed implementation plan, function designs, architecture.",
  mode: "subagent",
  permission: "readonly",
  tools: ["read", "glob", "grep", "list", "bash", "question", "todowrite"]
})

defineAgent({
  name: "coding-agent",
  promptFile: "longagent-coding-agent",
  description: "Ultra stage 3 - Coding Agent. Implements code strictly according to blueprint.",
  mode: "subagent",
  permission: "full",
  tools: null
})

defineAgent({
  name: "debugging-agent",
  promptFile: "longagent-debugging-agent",
  description: "Ultra stage 4 - Debugging Agent. Verifies implementation, runs tests, finds and fixes bugs.",
  mode: "subagent",
  permission: "full",
  tools: null
})

defineAgent({
  name: "bug-hunter",
  description: "Deep bug detection specialist. Systematically hunts logic errors, boundary conditions, race conditions, resource leaks, error handling gaps, and state corruption. Reports only HIGH/MEDIUM confidence bugs with concrete trigger paths.",
  mode: "subagent",
  permission: "full",
  maxTurns: 30,
  tools: ["read", "glob", "grep", "list", "bash"]
})
