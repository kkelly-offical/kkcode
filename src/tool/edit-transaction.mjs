import path from "node:path"
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises"

function tmpPath(target) {
  return `${target}.kkcode.tmp`
}

function backupPath(target) {
  return `${target}.kkcode.bak`
}

/**
 * Count added/removed lines between two text snippets using LCS.
 * For snippets under 500 lines, uses O(m*n) DP. For larger texts, falls back to simple line-count diff.
 */
export function diffLineCount(oldText, newText) {
  const oldLines = String(oldText || "").split(/\r?\n/)
  const newLines = String(newText || "").split(/\r?\n/)
  const m = oldLines.length
  const n = newLines.length

  // Fast path: identical
  if (oldText === newText) return { added: 0, removed: 0 }

  // For large texts, fall back to simple counting to avoid O(m*n) blowup
  if (m > 500 || n > 500) {
    // Build a set of old lines with counts
    const oldCounts = new Map()
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) || 0) + 1)
    const newCounts = new Map()
    for (const line of newLines) newCounts.set(line, (newCounts.get(line) || 0) + 1)
    let common = 0
    for (const [line, count] of oldCounts) {
      common += Math.min(count, newCounts.get(line) || 0)
    }
    return { added: n - common, removed: m - common }
  }

  // LCS via DP
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }
  const common = dp[m][n]
  return { added: n - common, removed: m - common }
}

export async function atomicWriteFile(target, content) {
  const dir = path.dirname(target)
  await mkdir(dir, { recursive: true })
  const tmp = tmpPath(target)
  const bak = backupPath(target)
  let hadOriginal = false
  try {
    const existing = await readFile(target, "utf8")
    hadOriginal = true
    await writeFile(bak, existing, "utf8")
  } catch {
    hadOriginal = false
  }

  try {
    await writeFile(tmp, content, "utf8")
    await rename(tmp, target)
    if (hadOriginal) {
      await unlink(bak).catch(() => {})
    }
  } catch (error) {
    if (hadOriginal) {
      const bakContent = await readFile(bak, "utf8").catch(() => null)
      if (bakContent !== null) {
        await writeFile(target, bakContent, "utf8").catch(() => {})
      }
      await unlink(bak).catch(() => {})
    }
    await unlink(tmp).catch(() => {})
    throw error
  }
}

export async function replaceInFileTransactional(target, before, after) {
  const absolute = path.resolve(target)
  const content = await readFile(absolute, "utf8")
  const matches = content.split(before).length - 1
  if (matches <= 0) {
    return { ok: false, output: "no match", matches: 0, addedLines: 0, removedLines: 0 }
  }
  if (matches > 1) {
    return { ok: false, output: `ambiguous: found ${matches} occurrences, expected exactly 1. Provide more surrounding context to match uniquely.`, matches, addedLines: 0, removedLines: 0 }
  }
  const next = content.replace(before, after)
  await atomicWriteFile(absolute, next)
  const diff = diffLineCount(before, after)
  return {
    ok: true,
    output: `replaced 1 occurrence`,
    matches: 1,
    addedLines: diff.added,
    removedLines: diff.removed
  }
}

export async function replaceAllInFileTransactional(target, before, after) {
  const absolute = path.resolve(target)
  const content = await readFile(absolute, "utf8")
  const matches = content.split(before).length - 1
  if (matches <= 0) {
    return { ok: false, output: "no match", matches: 0, addedLines: 0, removedLines: 0 }
  }
  const next = content.replaceAll(before, after)
  await atomicWriteFile(absolute, next)
  const diff = diffLineCount(content, next)
  return {
    ok: true,
    output: `replaced ${matches} occurrence(s)`,
    matches,
    addedLines: diff.added,
    removedLines: diff.removed
  }
}
