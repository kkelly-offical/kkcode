import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { memoryDir } from "../storage/paths.mjs"

/**
 * Instinct Manager — automatic pattern learning system.
 *
 * Instincts are small, atomic learned behaviors extracted from sessions.
 * Each instinct has a confidence score (0.3–0.9) that increases with repeated observation.
 * High-confidence instincts are injected into the system prompt to guide future behavior.
 */

function instinctsPath(cwd) {
  return path.join(memoryDir(cwd), "instincts.json")
}

function generateId() {
  return "inst_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

async function loadStore(cwd) {
  try {
    const raw = await readFile(instinctsPath(cwd), "utf8")
    return JSON.parse(raw)
  } catch {
    return { instincts: [], version: 1 }
  }
}

async function saveStore(cwd, store) {
  const dir = memoryDir(cwd)
  await mkdir(dir, { recursive: true })
  await writeFile(instinctsPath(cwd), JSON.stringify(store, null, 2) + "\n", "utf8")
}

/**
 * Add or reinforce an instinct.
 * If a similar pattern already exists (fuzzy match), increase its confidence.
 * Otherwise create a new instinct at base confidence 0.3.
 */
export async function addInstinct(cwd, pattern, category = "workflow") {
  const store = await loadStore(cwd)
  const normalized = pattern.trim().toLowerCase()

  // Fuzzy match: check if any existing instinct is substantially similar
  const existing = store.instincts.find((inst) => {
    const existingNorm = inst.pattern.trim().toLowerCase()
    return existingNorm === normalized || similarity(existingNorm, normalized) > 0.8
  })

  if (existing) {
    existing.observations = (existing.observations || 1) + 1
    existing.confidence = Math.min(0.9, existing.confidence + 0.1)
    existing.lastSeenAt = Date.now()
  } else {
    store.instincts.push({
      id: generateId(),
      pattern: pattern.trim(),
      confidence: 0.3,
      observations: 1,
      category,
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    })
  }

  await saveStore(cwd, store)
  return existing || store.instincts[store.instincts.length - 1]
}

/**
 * List instincts at or above a minimum confidence threshold.
 */
export async function listInstincts(cwd, minConfidence = 0.0) {
  const store = await loadStore(cwd)
  return store.instincts
    .filter((inst) => inst.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
}

/**
 * Remove an instinct by ID.
 */
export async function removeInstinct(cwd, id) {
  const store = await loadStore(cwd)
  const before = store.instincts.length
  store.instincts = store.instincts.filter((inst) => inst.id !== id)
  if (store.instincts.length < before) {
    await saveStore(cwd, store)
    return true
  }
  return false
}

/**
 * Export all instincts for team sharing.
 */
export async function exportInstincts(cwd) {
  const store = await loadStore(cwd)
  return {
    exportedAt: Date.now(),
    count: store.instincts.length,
    instincts: store.instincts
  }
}

/**
 * Import instincts from a teammate's export.
 * Merges by pattern similarity — existing patterns get reinforced, new ones get added at 0.3.
 */
export async function importInstincts(cwd, data) {
  if (!data || !Array.isArray(data.instincts)) return { imported: 0, reinforced: 0 }
  let imported = 0
  let reinforced = 0
  for (const inst of data.instincts) {
    if (!inst.pattern) continue
    const result = await addInstinct(cwd, inst.pattern, inst.category || "workflow")
    if (result.observations > 1) reinforced++
    else imported++
  }
  return { imported, reinforced }
}

/**
 * Format high-confidence instincts for system prompt injection.
 * Returns a prompt section string, or empty string if no qualifying instincts.
 */
export async function formatInstinctsForPrompt(cwd, minConfidence = 0.5) {
  const instincts = await listInstincts(cwd, minConfidence)
  if (instincts.length === 0) return ""

  const lines = [
    "",
    "## Learned Patterns",
    "",
    "These patterns have been observed across your sessions. Follow them unless the user explicitly requests otherwise:",
    ""
  ]

  for (const inst of instincts.slice(0, 20)) {
    const conf = inst.confidence.toFixed(1)
    lines.push(`- [${conf}] ${inst.pattern}`)
  }

  if (instincts.length > 20) {
    lines.push(`  ... and ${instincts.length - 20} more learned patterns`)
  }

  return lines.join("\n")
}

// ── Simple string similarity (Dice coefficient) ──

function similarity(a, b) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const bigrams = new Map()
  for (let i = 0; i < a.length - 1; i++) {
    const bi = a.slice(i, i + 2)
    bigrams.set(bi, (bigrams.get(bi) || 0) + 1)
  }
  let matches = 0
  for (let i = 0; i < b.length - 1; i++) {
    const bi = b.slice(i, i + 2)
    const count = bigrams.get(bi) || 0
    if (count > 0) {
      matches++
      bigrams.set(bi, count - 1)
    }
  }
  return (2 * matches) / (a.length + b.length - 2)
}
