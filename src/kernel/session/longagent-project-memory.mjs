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
  const ts = Array.isArray(memory?.techStack) ? memory.techStack : []
  const pt = Array.isArray(memory?.patterns) ? memory.patterns : []
  const cv = Array.isArray(memory?.conventions) ? memory.conventions : []
  if (!ts.length && !pt.length) return ""
  const lines = ["### Project Memory (from previous sessions)"]
  if (ts.length) lines.push(`Tech stack: ${ts.join(", ")}`)
  if (pt.length) lines.push(`Patterns: ${pt.join(", ")}`)
  if (cv.length) lines.push(`Conventions: ${cv.join(", ")}`)
  return lines.join("\n")
}

export function parseMemoryFromPreview(text) {
  const memory = { techStack: [], patterns: [], conventions: [] }
  // Only match lines that clearly declare tech stack (require colon separator)
  const techMatch = text.match(/(?:tech\s*stack|技术栈|frameworks?|主要语言|dependencies)\s*[：:]\s*([^\n]+)/gi)
  if (techMatch) {
    for (const m of techMatch) {
      const items = m.replace(/^[^:：]+[：:]/, "").split(/[,，、;；]/).map(s => s.trim()).filter(s => {
        // Filter out overly generic or long items (likely false positives)
        return s.length >= 2 && s.length <= 40 && !/^\d+$/.test(s)
      })
      memory.techStack.push(...items)
    }
  }
  memory.techStack = [...new Set(memory.techStack)].slice(0, 20)
  return memory
}
