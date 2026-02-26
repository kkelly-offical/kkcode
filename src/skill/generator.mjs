import { writeFile, mkdir } from "node:fs/promises"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import { requestProvider } from "../provider/router.mjs"

const SKILL_GEN_SYSTEM = `You are a skill generator for kkcode, a terminal AI coding agent.
Your task is to generate a skill file based on the user's description.

A skill is a reusable slash command. You can generate two types:

## Type 1: Markdown Template (.md)
Simple prompt templates with variable expansion.
Variables: $ARGUMENTS, $CWD, $MODE, $PROJECT, $1, $2, ...

Example:
\`\`\`markdown
Review the code changes in $CWD and provide feedback.
Focus on: $ARGUMENTS
Project: $PROJECT
\`\`\`

## Type 2: Programmable Skill (.mjs)
JavaScript module with full control. Must export: name, description, run(ctx).
ctx has: { args, cwd, mode, model, provider }

Example:
\`\`\`javascript
export const name = "test-coverage"
export const description = "Run tests and analyze coverage"

export async function run({ args, cwd }) {
  return \`Run the test suite in \${cwd} and analyze code coverage.
Focus on: \${args || "all files"}
Report uncovered lines and suggest tests to add.\`
}
\`\`\`

## Rules
- Choose .md for simple prompt templates, .mjs for anything needing logic
- The skill name should be kebab-case
- Keep the generated prompt focused and actionable
- Output ONLY the file content, no explanation
- First line must be a comment with the skill name: <!-- skill: name --> for .md, or // skill: name for .mjs`

/**
 * Generate a skill file from a natural language description.
 * Returns { name, filename, content, type } or null on failure.
 */
export async function generateSkill({ description, configState, providerType, model, baseUrl, apiKeyEnv }) {
  const response = await requestProvider({
    configState,
    providerType,
    model,
    system: SKILL_GEN_SYSTEM,
    messages: [{ role: "user", content: `Create a skill for: ${description}` }],
    tools: [],
    baseUrl,
    apiKeyEnv
  })

  const text = (response.text || "").trim()
  if (!text) return null

  // Detect type from content
  const isMjs = text.includes("export ") || text.includes("export const") || text.includes("export async")
  const type = isMjs ? "mjs" : "md"

  // Extract skill name from first line comment
  let name = null
  const nameMatch = text.match(/(?:<!--\s*skill:\s*|\/\/\s*skill:\s*)([a-z0-9-]+)/i)
  if (nameMatch) name = nameMatch[1].toLowerCase()

  // Fallback: derive name from description
  if (!name) {
    name = description
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40)
    if (!name) name = `skill-${Date.now()}`
  }

  // Strip markdown code fences if present
  let content = text
  const fenceMatch = content.match(/```(?:markdown|javascript|js|mjs)?\n([\s\S]*?)\n```/)
  if (fenceMatch) content = fenceMatch[1]

  // Safety: reject .mjs skills that contain dangerous patterns
  if (type === "mjs") {
    const dangerPatterns = [
      /child_process/,
      /\bexec\s*\(/,
      /\bspawn\s*\(/,
      /\beval\s*\(/,
      /Function\s*\(/,
      /require\s*\(\s*['"]fs['"]\s*\)/
    ]
    const hasDanger = dangerPatterns.some(p => p.test(content))
    if (hasDanger) {
      return { name, filename: `${name}.${type}`, content, type, needsReview: true, reviewReason: "contains potentially dangerous code patterns (child_process, exec, eval, etc.)" }
    }
  }

  const filename = `${name}.${type}`
  return { name, filename, content, type }
}

/**
 * Save a skill to the global skills directory.
 */
export async function saveSkillGlobal(filename, content) {
  const dir = join(homedir(), ".kkcode", "skills")
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, filename)
  await writeFile(filePath, content, "utf-8")
  return filePath
}

/**
 * Save a skill to the project skills directory.
 */
export async function saveSkillProject(filename, content, cwd = process.cwd()) {
  const dir = join(cwd, ".kkcode", "skills")
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, filename)
  await writeFile(filePath, content, "utf-8")
  return filePath
}
