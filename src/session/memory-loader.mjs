import { readFile } from "node:fs/promises"
import { memoryDir, memoryFilePath, ensureMemoryDir } from "../storage/paths.mjs"
import { formatInstinctsForPrompt } from "./instinct-manager.mjs"

const MAX_MEMORY_LINES = 200

/**
 * Load auto memory content for injection into system prompt.
 * Returns formatted memory block or empty string if no MEMORY.md exists.
 */
export async function loadAutoMemory(cwd = process.cwd()) {
  await ensureMemoryDir(cwd)
  const memDir = memoryDir(cwd)
  const memFile = memoryFilePath(cwd)

  let content = ""
  try {
    content = (await readFile(memFile, "utf8")).trim()
  } catch {
    // No MEMORY.md yet — that's fine
  }

  const lines = [
    "# Auto Memory",
    "",
    `You have a persistent auto memory directory at \`${memDir.replace(/\\/g, "/")}/\`. Its contents persist across conversations.`,
    "",
    "As you work, consult your memory files to build on previous experience. When you encounter a mistake that seems like it could be common, check your auto memory for relevant notes — and if nothing is written yet, record what you learned.",
    "",
    "Guidelines:",
    "- `MEMORY.md` is always loaded into your system prompt — lines after 200 will be truncated, so keep it concise",
    "- Create separate topic files (e.g., `debugging.md`, `patterns.md`) for detailed notes and link to them from MEMORY.md",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Organize memory semantically by topic, not chronologically",
    "- Use the `write` and `edit` tools to update your memory files",
    "",
    "What to save:",
    "- Stable patterns and conventions confirmed across multiple interactions",
    "- Key architectural decisions, important file paths, and project structure",
    "- User preferences for workflow, tools, and communication style",
    "- Solutions to recurring problems and debugging insights",
    "",
    "What NOT to save:",
    "- Session-specific context (current task details, in-progress work, temporary state)",
    "- Information that might be incomplete — verify against project docs before writing",
    "- Anything that duplicates or contradicts existing project instruction files",
    "- Speculative or unverified conclusions from reading a single file",
    "",
    "Explicit user requests:",
    "- When the user asks you to remember something across sessions (e.g., \"always use bun\", \"never auto-commit\"), save it immediately",
    "- When the user asks to forget or stop remembering something, find and remove the relevant entries from your memory files"
  ]

  if (content) {
    const truncated = content.split("\n").slice(0, MAX_MEMORY_LINES)
    if (content.split("\n").length > MAX_MEMORY_LINES) {
      truncated.push(`\n... (truncated at ${MAX_MEMORY_LINES} lines)`)
    }
    lines.push("", "## MEMORY.md", "", ...truncated)
  } else {
    lines.push("", "## MEMORY.md", "", "Your MEMORY.md is currently empty. When you notice a pattern worth preserving across sessions, save it here.")
  }

  // Inject learned instincts (high-confidence patterns from previous sessions)
  try {
    const instinctBlock = await formatInstinctsForPrompt(cwd, 0.5)
    if (instinctBlock) {
      lines.push(instinctBlock)
    }
  } catch {
    // Instinct loading failure is non-critical
  }

  return lines.join("\n")
}
