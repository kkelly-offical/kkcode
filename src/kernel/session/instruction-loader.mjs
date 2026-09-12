import path from "node:path"
import { access, readFile } from "node:fs/promises"

const CANDIDATES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "KKCODE.md", ".kkcode.md", "kkcode.md"]

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export async function loadInstructions(cwd = process.cwd()) {
  const blocks = []
  for (const file of CANDIDATES) {
    const target = path.join(cwd, file)
    if (!(await exists(target))) continue
    const content = (await readFile(target, "utf8")).trim()
    if (!content) continue
    blocks.push(`Instructions from ${target}\n${content}`)
  }
  return blocks
}
