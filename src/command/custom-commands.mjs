import path from "node:path"
import { access, readdir, readFile } from "node:fs/promises"
import { renderTemplate } from "../util/template.mjs"

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function loadDir(dir, scope) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  const output = []
  for (const file of files) {
    const full = path.join(dir, file)
    const content = (await readFile(full, "utf8")).trim()
    if (!content) continue
    output.push({
      name: path.basename(file, ".md"),
      template: content,
      scope,
      source: full
    })
  }
  return output
}

export async function loadCustomCommands(cwd = process.cwd()) {
  const userRoot = process.env.USERPROFILE || process.env.HOME || cwd
  const userDir = path.join(userRoot, ".kkcode", "commands")
  const projectDir = path.join(cwd, ".kkcode", "commands")
  const [globalCommands, projectCommands] = await Promise.all([loadDir(userDir, "global"), loadDir(projectDir, "project")])
  const map = new Map()
  for (const cmd of [...globalCommands, ...projectCommands]) {
    map.set(cmd.name, cmd)
  }
  return [...map.values()]
}

export function applyCommandTemplate(template, args, vars = {}) {
  const rawArgs = String(args || "").trim()
  const tokens = rawArgs ? rawArgs.split(/\s+/) : []
  let output = template
  output = output.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, i) => tokens[Number(i)] || "")
  output = output.replace(/\$ARGUMENTS/g, rawArgs)
  output = output.replace(/\$(\d+)/g, (_, index) => tokens[Number(index) - 1] || "")
  output = renderTemplate(output, vars)
  return output.trim()
}
