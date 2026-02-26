import { readFile, access } from "node:fs/promises"
import { execSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { loadSessionPrompt } from "./prompt-loader.mjs"
import { getAgentPrompt, listAgents } from "../agent/agent.mjs"
import { loadAutoMemory } from "./memory-loader.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOL_PROMPT_DIR = path.join(__dirname, "..", "tool", "prompt")

const toolPromptCache = new Map()

// Session-level block cache: avoids rebuilding identical blocks across turns
// Key = hash of inputs, Value = { blocks, text, timestamp }
let blockCache = { key: null, result: null }

function hashInputs(obj) {
  return createHash("md5").update(JSON.stringify(obj)).digest("hex")
}

async function loadToolPrompt(name) {
  if (!toolPromptCache.has(name)) {
    try {
      const file = path.join(TOOL_PROMPT_DIR, `${name}.txt`)
      const text = (await readFile(file, "utf8")).trim()
      toolPromptCache.set(name, text)
    } catch {
      toolPromptCache.set(name, "")
    }
  }
  return toolPromptCache.get(name)
}

// Detect if cwd is a git repo
function detectGitRepo(cwd) {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe", timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// Detect the user's default shell
function detectShell() {
  if (process.platform === "win32") {
    // On Windows, kkcode uses bash (git bash / WSL) internally
    return "bash (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)"
  }
  const shell = process.env.SHELL || "/bin/bash"
  return path.basename(shell)
}

// Layer 1: Environment information (dynamic per turn — changes with cwd/date)
export function environmentPrompt({ model, cwd }) {
  const isGit = detectGitRepo(cwd)
  const shell = detectShell()
  const today = new Date().toISOString().slice(0, 10)
  const lines = [
    `<env>`,
    `  model: ${model}`,
    `  cwd: ${cwd}`,
    `  platform: ${process.platform}`,
    `  shell: ${shell}`,
    `  node: ${process.version}`,
    `  date: ${today}`,
    `  git_repo: ${isGit}`,
    `</env>`,
    ``,
    `Knowledge cutoff: early 2025. Current date: ${today}.`,
    `When searching for recent information, use the current year (${today.slice(0, 4)}) in queries.`
  ]
  return lines.join("\n")
}

// Layer 2: System prompt (model-specific — stable across session)
export async function providerPromptByModel(model) {
  const m = String(model).toLowerCase()
  if (m.includes("claude")) return loadSessionPrompt("anthropic.txt")
  if (m.includes("gpt-5") || m.includes("codex")) return loadSessionPrompt("beast.txt")
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3")) return loadSessionPrompt("beast.txt")
  if (m.includes("gemini")) return loadSessionPrompt("qwen.txt")
  if (m.includes("deepseek")) return loadSessionPrompt("qwen.txt")
  if (m.includes("qwen")) return loadSessionPrompt("qwen.txt")
  return loadSessionPrompt("qwen.txt")
}

// Layer 3: Agent-specific prompt (stable across session)
export async function agentPrompt(agent) {
  if (!agent) return ""
  return getAgentPrompt(agent.name)
}

// Layer 4: Mode reminder (stable within mode)
export async function modeReminder(mode) {
  if (mode === "plan") return loadSessionPrompt("plan.txt")
  if (mode === "agent") return loadSessionPrompt("agent.txt")
  if (mode === "ask") return "You are in ASK mode (read-only). Answer questions, explain code, and provide analysis. Do NOT modify any files — you only have read access to the codebase."
  return ""
}

// Layer 5: Tool descriptions (stable across session — ideal cache target)
export async function toolDescriptions(tools) {
  if (!tools || !tools.length) return ""
  const descriptions = []
  for (const tool of tools) {
    const prompt = await loadToolPrompt(tool.name)
    if (prompt) {
      descriptions.push(`## ${tool.name}\n${prompt}`)
    }
  }
  if (!descriptions.length) return ""
  return `# Available Tools\n\n${descriptions.join("\n\n")}`
}

// Layer 6: User custom instructions (loaded externally via instruction-loader.mjs and rules)
// Assembled in loop.mjs from loadInstructions() and renderRulesPrompt()

/**
 * Build system prompt as structured blocks for provider-level cache optimization.
 *
 * Returns { text, blocks } where:
 * - text: single concatenated string (for providers that don't support block-level caching)
 * - blocks: array of { label, text, cacheable } objects
 *
 * Cache strategy:
 * - Blocks marked cacheable=true are stable across turns (provider/agent/tools/skills)
 * - Blocks marked cacheable=false are dynamic per turn (env/user instructions)
 * - Providers use this to place cache_control breakpoints optimally
 *
 * Anthropic: up to 4 cache breakpoints — place on stable blocks
 * OpenAI: automatic prefix caching — stable blocks should come first
 */
export async function buildSystemPromptBlocks({ mode, model, cwd, agent = null, tools = [], skills = [], userInstructions = "", projectContext = "", language = "en" }) {
  // Cache key: hash of all inputs that affect block content
  const cacheKey = hashInputs({
    mode, model, cwd, language,
    agent: agent?.name || null,
    tools: tools.map(t => t.name).sort(),
    skills: skills.map(s => s.name).sort(),
    userInstructions: hashInputs({ ui: userInstructions }) // hash full string to avoid collisions
  })

  if (blockCache.key === cacheKey && blockCache.result) {
    // Only env block changes per turn — rebuild just that
    const cached = blockCache.result
    const envIdx = cached.blocks.findIndex(b => b.label === "env")
    if (envIdx >= 0) {
      const freshEnv = environmentPrompt({ model, cwd })
      if (cached.blocks[envIdx].text === freshEnv) {
        return cached // fully identical
      }
      // Clone and update only the env block
      const updatedBlocks = cached.blocks.map((b, i) =>
        i === envIdx ? { ...b, text: freshEnv } : b
      )
      const text = updatedBlocks.map(b => b.text).join("\n\n")
      const result = { text, blocks: updatedBlocks }
      blockCache = { key: cacheKey, result }
      return result
    }
  }

  const blocks = []

  // Block 0: Provider prompt (stable — loaded once per model)
  const providerText = await providerPromptByModel(model)
  if (providerText) {
    blocks.push({ label: "provider", text: providerText, cacheable: true })
  }

  // Block 1: Agent prompt (stable — loaded once per agent)
  const agentText = agent ? await getAgentPrompt(agent.name) : ""
  if (agentText) {
    blocks.push({ label: "agent", text: agentText, cacheable: true })
  }

  // Block 2: Mode reminder (stable within mode)
  const modeText = await modeReminder(mode)
  if (modeText) {
    blocks.push({ label: "mode", text: modeText, cacheable: true })
  }

  // Block 3: Tool descriptions (stable — changes only when tools change)
  const toolText = await toolDescriptions(tools)
  if (toolText) {
    blocks.push({ label: "tools", text: toolText, cacheable: true })
  }

  // Block 3.5: Large output strategy (stable — always included)
  const outputStrategyLines = [
    "# Large Output Strategy",
    "",
    "When generating large amounts of content:",
    "- For large file creation, write no more than 200 lines per tool call; use append mode for subsequent chunks",
    "- For partial file edits, use patch with line ranges instead of rewriting the whole file",
    "- If a task requires more than 300 lines of code, proactively split into multiple sequential tool calls",
    "- Never attempt to write an entire large file in a single tool call"
  ]
  blocks.push({ label: "output_strategy", text: outputStrategyLines.join("\n"), cacheable: true })

  // Block 4: Skills descriptions (stable — changes only when skills change)
  if (skills.length) {
    const skillLines = skills.map((s) => `- /${s.name}: ${s.description || s.name}`).join("\n")
    const skillText = `# Available Skills\n\nInvoke with /<skill-name> [arguments].\n\n${skillLines}`
    blocks.push({ label: "skills", text: skillText, cacheable: true })
  }

  // Block 4.5: Available sub-agents (stable — changes only when custom agents change)
  const allAgents = listAgents({ includeHidden: false })
  const customSubagents = allAgents.filter((a) => a.mode === "subagent" && a._customAgent)
  if (customSubagents.length) {
    const agentLines = customSubagents.map((a) => {
      const perms = a.permission === "readonly" ? " (read-only)" : a.permission === "full" ? " (full access)" : ""
      return `- ${a.name}: ${a.description}${perms}`
    })
    const subagentText = [
      "# Available Sub-agents",
      "",
      "Delegate specialized work to these sub-agents using the `task` tool with `subagent_type` parameter.",
      "Use sub-agents when a task is self-contained and would benefit from a specialist, or to save context window space.",
      "",
      ...agentLines
    ].join("\n")
    blocks.push({ label: "subagents", text: subagentText, cacheable: true })
  }

  // Block 4.7: Project context (semi-stable — changes when cwd changes)
  if (projectContext) {
    blocks.push({ label: "project", text: projectContext, cacheable: false })
  }

  // Block 4.9: Language constraint (stable — changes only when config changes)
  if (language && language !== "en") {
    const langMap = {
      zh: "Always respond in Chinese (中文). Use Chinese for all explanations, comments, and communications. Technical terms, code identifiers, and code content should remain in their original form (typically English)."
    }
    const langText = langMap[language]
    if (langText) {
      blocks.push({ label: "language", text: `# Language\n\n${langText}`, cacheable: true })
    }
  }

  // Block 4.95: Auto Memory (semi-stable — changes when user updates memory files)
  const memoryText = await loadAutoMemory(cwd)
  if (memoryText) {
    blocks.push({ label: "memory", text: memoryText, cacheable: false })
  }

  // Block 5: Environment (dynamic per turn)
  const envText = environmentPrompt({ model, cwd })
  blocks.push({ label: "env", text: envText, cacheable: false })

  // Block 6: User instructions + rules (semi-stable — cacheable if unchanged between turns)
  if (userInstructions) {
    blocks.push({ label: "user", text: userInstructions, cacheable: false })
  }

  const text = blocks.map((b) => b.text).join("\n\n")
  const result = { text, blocks }
  blockCache = { key: cacheKey, result }
  return result
}

// Legacy flat assembly (kept for backward compatibility)
export async function buildSystemPromptLayers({ mode, model, cwd, agent = null }) {
  const layer1 = environmentPrompt({ model, cwd })
  const layer2 = await providerPromptByModel(model)
  const layer3 = await agentPrompt(agent)
  const layer4 = await modeReminder(mode)
  return { layer1, layer2, layer3, layer4 }
}
