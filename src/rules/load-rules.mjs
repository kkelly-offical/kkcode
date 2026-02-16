import path from "node:path"
import { access, readdir, readFile } from "node:fs/promises"

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function readRuleDir(dir, scope) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  const blocks = []
  for (const file of files) {
    const target = path.join(dir, file)
    const content = (await readFile(target, "utf8")).trim()
    if (!content) continue
    blocks.push({
      scope,
      file: target,
      content
    })
  }
  return blocks
}

async function readSingleRuleFile(filePath, scope) {
  if (!(await exists(filePath))) return []
  const content = (await readFile(filePath, "utf8")).trim()
  if (!content) return []
  return [{ scope, file: filePath, content }]
}

export async function loadRuleBlocks(cwd = process.cwd()) {
  const userHome = process.env.USERPROFILE || process.env.HOME || cwd
  const userRuleFile = path.join(userHome, ".kkcode", "rule.md")
  const userRulesDir = path.join(userHome, ".kkcode", "rules")
  const projectRuleFile = path.join(cwd, ".kkcode", "rule.md")
  const projectRulesDir = path.join(cwd, ".kkcode", "rules")
  const [globalSingle, globalDir, projectSingle, projectDir] = await Promise.all([
    readSingleRuleFile(userRuleFile, "global"),
    readRuleDir(userRulesDir, "global"),
    readSingleRuleFile(projectRuleFile, "project"),
    readRuleDir(projectRulesDir, "project")
  ])
  return [...globalSingle, ...globalDir, ...projectSingle, ...projectDir]
}

export async function renderRulesPrompt(cwd = process.cwd()) {
  const blocks = await loadRuleBlocks(cwd)
  if (!blocks.length) return ""
  return blocks
    .map((block) => {
      return [`<rule scope="${block.scope}" source="${block.file}">`, block.content, `</rule>`].join("\n")
    })
    .join("\n\n")
}
