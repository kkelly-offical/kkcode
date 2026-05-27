import os from "node:os"
import path from "node:path"
import { access, lstat } from "node:fs/promises"
import { userRootDir } from "../storage/paths.mjs"

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function realPathKey(target) {
  try {
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) return path.resolve(await import("node:fs/promises").then((fs) => fs.realpath(target)))
  } catch {}
  return path.resolve(target)
}

async function findGitRoot(cwd) {
  let current = path.resolve(cwd)
  while (true) {
    if (await exists(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

async function projectAncestors(cwd) {
  const start = path.resolve(cwd)
  const root = await findGitRoot(start)
  const dirs = []
  let current = start
  while (true) {
    dirs.push(current)
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

function homeDir() {
  return os.homedir()
}

export async function discoverCompatSkillRoots(cwd = process.cwd(), config = {}) {
  const ecosystems = new Set(config?.compat?.plugins?.ecosystems || ["kkcode", "claude", "codex", "opencode"])
  const roots = []
  const ancestors = await projectAncestors(cwd)

  const home = homeDir()
  if (ecosystems.has("kkcode")) roots.push({ dir: path.join(userRootDir(), "skills"), scope: "global", ecosystem: "kkcode" })
  if (ecosystems.has("claude")) roots.push({ dir: path.join(home, ".claude", "skills"), scope: "global", ecosystem: "claude" })
  if (ecosystems.has("codex")) roots.push({ dir: path.join(home, ".agents", "skills"), scope: "global", ecosystem: "codex" })
  if (ecosystems.has("opencode")) roots.push({ dir: path.join(home, ".config", "opencode", "skills"), scope: "global", ecosystem: "opencode" })

  for (const dir of [...ancestors].reverse()) {
    if (ecosystems.has("kkcode")) roots.push({ dir: path.join(dir, ".kkcode", "skills"), scope: "project", ecosystem: "kkcode" })
    if (ecosystems.has("claude")) roots.push({ dir: path.join(dir, ".claude", "skills"), scope: "project", ecosystem: "claude" })
    if (ecosystems.has("codex")) roots.push({ dir: path.join(dir, ".agents", "skills"), scope: "project", ecosystem: "codex" })
    if (ecosystems.has("opencode")) roots.push({ dir: path.join(dir, ".opencode", "skills"), scope: "project", ecosystem: "opencode" })
  }

  for (const item of config?.compat?.skills?.paths || []) {
    if (typeof item !== "string" || !item.trim()) continue
    const dir = path.isAbsolute(item) ? item : path.resolve(cwd, item)
    roots.push({ dir, scope: "custom", ecosystem: "custom" })
  }

  const seen = new Set()
  const out = []
  for (const root of roots) {
    const key = await realPathKey(root.dir)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

export async function discoverCompatPluginManifestCandidates(cwd = process.cwd(), config = {}) {
  if (config?.compat?.plugins?.enabled === false) return []
  const ecosystems = new Set(config?.compat?.plugins?.ecosystems || ["kkcode", "claude", "codex", "opencode"])
  const ancestors = await projectAncestors(cwd)
  const files = []
  const kkRoot = userRootDir()

  if (ecosystems.has("kkcode")) {
    files.push({ file: path.join(kkRoot, ".kkcode-plugin", "plugin.json"), ecosystem: "kkcode", rootMode: "manifest-dir" })
    files.push({ file: path.join(kkRoot, "plugins"), ecosystem: "kkcode", rootMode: "named-dir", directory: true })
    files.push({ file: path.join(kkRoot, "plugin"), ecosystem: "kkcode", rootMode: "named-dir", directory: true })
  }

  for (const dir of ancestors) {
    if (ecosystems.has("kkcode")) {
      files.push({ file: path.join(dir, ".kkcode-plugin", "plugin.json"), ecosystem: "kkcode", rootMode: "manifest-dir" })
      files.push({ file: path.join(dir, ".kkcode", "plugins"), ecosystem: "kkcode", rootMode: "named-dir", directory: true })
      files.push({ file: path.join(dir, ".kkcode", "plugin"), ecosystem: "kkcode", rootMode: "named-dir", directory: true })
    }
    if (ecosystems.has("claude")) {
      files.push({ file: path.join(dir, ".claude-plugin", "plugin.json"), ecosystem: "claude", rootMode: "parent-dir" })
    }
    if (ecosystems.has("codex")) {
      files.push({ file: path.join(dir, ".codex-plugin", "plugin.json"), ecosystem: "codex", rootMode: "parent-dir" })
    }
  }

  const seen = new Set()
  const out = []
  for (const item of files) {
    const resolved = path.resolve(item.file)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push({ ...item, file: resolved })
  }
  return out
}

export async function discoverOpenCodePluginFiles(cwd = process.cwd(), config = {}) {
  const ecosystems = new Set(config?.compat?.plugins?.ecosystems || ["kkcode", "claude", "codex", "opencode"])
  if (!ecosystems.has("opencode")) return []
  const roots = [
    path.join(homeDir(), ".config", "opencode", "plugins"),
    ...(await projectAncestors(cwd)).map((dir) => path.join(dir, ".opencode", "plugins"))
  ]
  const out = []
  for (const dir of roots) {
    if (!(await exists(dir))) continue
    const { readdir } = await import("node:fs/promises")
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && [".js", ".mjs", ".ts"].includes(path.extname(entry.name))) {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  return out
}
