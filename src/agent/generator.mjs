import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { requestProvider } from "../provider/router.mjs"

const AGENT_GEN_SYSTEM = `You are an agent definition generator for kkcode, a terminal AI coding agent.
Your task is to generate an agent definition file in YAML format based on the user's description.

An agent is a specialized sub-agent that can be delegated tasks via the task tool.

## YAML Agent Definition Format

\`\`\`yaml
name: agent-name-in-kebab-case
description: "One-line description of what this agent does"
mode: subagent
permission: readonly|full|default
tools:
  - read
  - glob
  - grep
  - list
  - bash
  - write
  - edit
  - task
model: null
temperature: null
hidden: false
prompt: |
  Multi-line system prompt that defines the agent's behavior,
  expertise, and guidelines.
\`\`\`

## Permission Levels
- readonly: can only read files and search (safe for analysis tasks)
- full: can read, write, edit files and run commands (needed for implementation tasks)
- default: inherits from session

## Available Tools
read, glob, grep, list, bash, write, edit, task, background_output, background_cancel, todowrite, question, webfetch

## Rules
- name must be kebab-case, unique, descriptive
- permission should match the agent's purpose (analysis = readonly, implementation = full)
- tools array should be minimal — only include tools the agent actually needs
- prompt should be detailed, specific, and actionable — define the agent's expertise, workflow, and output format
- Output ONLY the YAML content, no explanation or markdown fences
- First line must be a comment: # agent: <name>`

/**
 * Generate an agent definition from a natural language description.
 * Returns { name, filename, content } or null on failure.
 */
export async function generateAgent({ description, configState, providerType, model, baseUrl, apiKeyEnv }) {
  const response = await requestProvider({
    configState,
    providerType,
    model,
    system: AGENT_GEN_SYSTEM,
    messages: [{ role: "user", content: `Create an agent for: ${description}` }],
    tools: [],
    baseUrl,
    apiKeyEnv
  })

  const text = (response.text || "").trim()
  if (!text) return null

  // Extract agent name from first line comment
  let name = null
  const nameMatch = text.match(/^#\s*agent:\s*([a-z0-9-]+)/im)
  if (nameMatch) name = nameMatch[1].toLowerCase()

  // Fallback: derive name from description
  if (!name) {
    name = description
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40)
    if (!name) name = `agent-${Date.now()}`
  }

  // Strip markdown code fences if present
  let content = text
  const fenceMatch = content.match(/```(?:yaml|yml)?\n([\s\S]*?)\n```/)
  if (fenceMatch) content = fenceMatch[1]

  const filename = `${name}.yaml`
  return { name, filename, content }
}

/**
 * Save an agent definition to the global agents directory.
 */
export async function saveAgentGlobal(filename, content) {
  const dir = join(homedir(), ".kkcode", "agents")
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, filename)
  await writeFile(filePath, content, "utf-8")
  return filePath
}

/**
 * Save an agent definition to the project agents directory.
 */
export async function saveAgentProject(filename, content, cwd = process.cwd()) {
  const dir = join(cwd, ".kkcode", "agents")
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, filename)
  await writeFile(filePath, content, "utf-8")
  return filePath
}
