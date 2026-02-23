/**
 * Project Memory — 跨会话项目级知识持久化
 * 存储在 .kkcode/project-memory.json，记住技术栈、惯用模式等
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"

const MEMORY_FILE = ".kkcode/project-memory.json"

export async function loadProjectMemory(cwd) {
  try {
    const raw = await readFile(path.join(cwd, MEMORY_FILE), "utf-8")
    return JSON.parse(raw)
  } catch {
    return { techStack: [], patterns: [], conventions: [], lastUpdated: null }
  }
}

export async function saveProjectMemory(cwd, memory) {
  const filePath = path.join(cwd, MEMORY_FILE)
  await mkdir(path.dirname(filePath), { recursive: true })
  memory.lastUpdated = new Date().toISOString()
  await writeFile(filePath, JSON.stringify(memory, null, 2), "utf-8")
}

export function memoryToContext(memory) {
  if (!memory?.techStack?.length && !memory?.patterns?.length) return ""
  const lines = ["### Project Memory (from previous sessions)"]
  if (memory.techStack?.length) lines.push(`Tech stack: ${memory.techStack.join(", ")}`)
  if (memory.patterns?.length) lines.push(`Patterns: ${memory.patterns.join(", ")}`)
  if (memory.conventions?.length) lines.push(`Conventions: ${memory.conventions.join(", ")}`)
  return lines.join("\n")
}

export function parseMemoryFromPreview(text) {
  const memory = { techStack: [], patterns: [], conventions: [] }
  const techMatch = text.match(/(?:tech.*?stack|技术栈|framework|语言)[:\s]*([^\n]+)/gi)
  if (techMatch) {
    for (const m of techMatch) {
      const items = m.replace(/^[^:：]+[：:]/, "").split(/[,，、;；]/).map(s => s.trim()).filter(Boolean)
      memory.techStack.push(...items)
    }
  }
  memory.techStack = [...new Set(memory.techStack)].slice(0, 20)
  return memory
}
