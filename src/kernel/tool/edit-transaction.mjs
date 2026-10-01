import path from "node:path"
import { readFile, rename, mkdir, mkdtemp, open, lstat, chmod, rm } from "node:fs/promises"
import { diagnoseNoMatch } from "./edit-diagnosis.mjs"

function linesForPatch(text) {
  const value = String(text ?? "")
  return value === "" ? [] : value.split("\n")
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

export function buildStructuredPatch(oldText, newText, {
  oldStart = 1,
  newStart = 1
} = {}) {
  const removed = linesForPatch(oldText)
  const added = linesForPatch(newText)
  return [{
    oldStart,
    oldLineCount: removed.length,
    newStart,
    newLineCount: added.length,
    lines: [
      ...removed.map((text) => ({ type: "remove", text })),
      ...added.map((text) => ({ type: "add", text }))
    ]
  }]
}

export async function atomicWriteFile(target, content) {
  const dir = path.dirname(target)
  const targetInfo = async () => {
    try { return await lstat(target, {bigint: true}) }
    catch (error) {if (error.code === 'ENOENT') return null; throw error}
  }
  const original = await targetInfo()
  if (original && (!original.isFile() || original.nlink !== 1n)) {
    throw Object.assign(new Error('Atomic editing requires a regular single-link target. Use the explicit real file rather than replacing a symbolic or hard-linked alias.'), {code: 'unsafe_atomic_target'})
  }
  const same = current => original ? current && ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => current[key] === original[key]) : current === null
  await mkdir(dir, { recursive: true })
  // Never touch predictable .kkcode.tmp/.bak names controlled by a workspace.
  // Keep original bytes in place until the single atomic commit; a failed
  // write/rename must not restore an old backup over somebody else's changes.
  const staging = await mkdtemp(path.join(dir, '.kkcode-write-'))
  let handle
  try {
    await chmod(staging, 0o700)
    const temporary = path.join(staging, 'content')
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    if (original && process.platform !== 'win32') {
      const created = await handle.stat({bigint: true})
      if (created.uid !== original.uid || created.gid !== original.gid) await handle.chown(Number(original.uid), Number(original.gid))
    }
    // Preserve ordinary permission/executable bits, not setuid/setgid grants
    // on changed code. Private files must not become broadly readable.
    await handle.chmod(original ? Number(original.mode & 0o777n) : 0o666 & ~process.umask())
    await handle.sync(); await handle.close(); handle = null
    for (let attempt = 0; ; attempt++) {
      if (!same(await targetInfo())) throw Object.assign(new Error('Atomic edit target changed while preparing the write; inspect and reread it before retrying.'), {code: 'atomic_target_changed'})
      try { await rename(temporary, target); break }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt))
      }
    }
  } finally {
    await handle?.close().catch(() => {})
    await rm(staging, {recursive: true, force: true}).catch(() => {})
  }
}

export async function replaceInFileTransactional(target, before, after) {
  const absolute = path.resolve(target)
  const content = await readFile(absolute, "utf8")
  const matches = content.split(before).length - 1
  if (matches <= 0) {
    // 此前只返回两个词 "no match" —— 模型唯一能做的是重读整个文件再猜。
    // 现在给出相似度、带行号的最接近匹配与周边原文，让它一轮内能改对。
    return {
      ok: false,
      output: diagnoseNoMatch({ path: absolute, content, before }),
      matches: 0, addedLines: 0, removedLines: 0
    }
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
    return {
      ok: false,
      output: diagnoseNoMatch({ path: absolute, content, before }),
      matches: 0, addedLines: 0, removedLines: 0
    }
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
