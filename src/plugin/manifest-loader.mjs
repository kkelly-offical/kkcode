import path from "node:path"
import { access, readFile, readdir } from "node:fs/promises"
import { userRootDir } from "../storage/paths.mjs"

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
}

function isWithin(rootDir, targetPath) {
  const root = path.resolve(rootDir)
  const target = path.resolve(targetPath)
  return target === root || target.startsWith(root + path.sep)
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === "") return []
  return [value]
}

function toStringArray(value) {
  return asArray(value)
    .flatMap((item) => typeof item === "string" ? item.split(",") : [item])
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
}

function resolveRelativePath(rootDir, rawPath, label, errors) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    errors.push(`${label} must be a non-empty relative path`)
    return null
  }
  const resolved = path.resolve(rootDir, rawPath)
  if (!isWithin(rootDir, resolved)) {
    errors.push(`${label} points outside plugin root: ${rawPath}`)
    return null
  }
  return resolved
}

async function listManifestFiles(dir) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, "plugin.json"))
}

async function readJsonFile(filePath, label, errors) {
  try {
    const raw = await readFile(filePath, "utf8")
    return JSON.parse(raw)
  } catch (error) {
    errors.push(`${label} parse failed: ${error.message}`)
    return null
  }
}

function normalizeComponentDirs(value, rootDir, label, errors) {
  return toStringArray(value)
    .map((item) => resolveRelativePath(rootDir, item, label, errors))
    .filter(Boolean)
}

async function normalizeMcpServers(manifest, rootDir, errors) {
  const out = {}
  const inlineServers = manifest.mcpServers || manifest.mcp_servers
  if (isPlainObject(inlineServers)) Object.assign(out, inlineServers)

  for (const entry of asArray(manifest.mcp)) {
    if (typeof entry === "string") {
      const filePath = resolveRelativePath(rootDir, entry, "mcp", errors)
      if (!filePath) continue
      const parsed = await readJsonFile(filePath, `mcp file ${entry}`, errors)
      if (!parsed) continue
      Object.assign(out, parsed.servers || parsed.mcpServers || {})
      continue
    }
    if (!isPlainObject(entry)) {
      errors.push("mcp entries must be strings or objects")
      continue
    }
    if (entry.path) {
      const filePath = resolveRelativePath(rootDir, entry.path, "mcp.path", errors)
      if (!filePath) continue
      const parsed = await readJsonFile(filePath, `mcp file ${entry.path}`, errors)
      if (!parsed) continue
      Object.assign(out, parsed.servers || parsed.mcpServers || {})
    }
    if (isPlainObject(entry.servers)) {
      Object.assign(out, entry.servers)
    }
  }

  return out
}

function normalizeCapabilities(manifest) {
  const caps = isPlainObject(manifest.capabilities) ? manifest.capabilities : {}
  const allowedAgentPermissions = toStringArray(
    caps.allowedAgentPermissions
    || caps.allowed_agent_permissions
    || manifest.allowedAgentPermissions
    || manifest.allowed_agent_permissions
    || ["default"]
  )
  return {
    allowedAgentPermissions: allowedAgentPermissions.length ? allowedAgentPermissions : ["default"]
  }
}

async function loadManifest(filePath, scope) {
  const errors = []
  const manifest = await readJsonFile(filePath, "plugin manifest", errors)
  if (!manifest) return { plugin: null, errors }

  const rootDir = path.dirname(filePath)
  const components = isPlainObject(manifest.components) ? manifest.components : {}
  const name = typeof manifest.name === "string" && manifest.name.trim()
    ? manifest.name.trim()
    : path.basename(rootDir)

  const plugin = {
    name,
    version: typeof manifest.version === "string" ? manifest.version : null,
    enabled: manifest.enabled !== false && manifest.disabled !== true,
    displayName: typeof manifest.displayName === "string" ? manifest.displayName.trim() : null,
    scope,
    source: filePath,
    rootDir,
    skills: normalizeComponentDirs(manifest.skills ?? components.skills, rootDir, "skills", errors),
    agents: normalizeComponentDirs(manifest.agents ?? components.agents, rootDir, "agents", errors),
    hooks: normalizeComponentDirs(manifest.hooks ?? components.hooks, rootDir, "hooks", errors),
    mcpServers: await normalizeMcpServers(manifest, rootDir, errors),
    capabilities: normalizeCapabilities(manifest)
  }

  return { plugin, errors }
}

async function candidateManifestFiles(cwd) {
  const files = [
    path.join(userRootDir(), ".kkcode-plugin", "plugin.json"),
    ...(await listManifestFiles(path.join(userRootDir(), "plugins"))),
    ...(await listManifestFiles(path.join(userRootDir(), "plugin"))),
    path.join(cwd, ".kkcode-plugin", "plugin.json"),
    ...(await listManifestFiles(path.join(cwd, ".kkcode", "plugins"))),
    ...(await listManifestFiles(path.join(cwd, ".kkcode", "plugin")))
  ]

  const seen = new Set()
  return files.filter((file) => {
    const resolved = path.resolve(file)
    if (seen.has(resolved)) return false
    seen.add(resolved)
    return true
  })
}

export async function discoverLocalPluginManifests(cwd = process.cwd()) {
  const files = await candidateManifestFiles(cwd)
  const plugins = []
  const errors = []

  for (const file of files) {
    if (!(await exists(file))) continue
    const scope = isWithin(cwd, file) ? "project" : "global"
    const loaded = await loadManifest(file, scope)
    if (loaded.plugin) plugins.push(loaded.plugin)
    errors.push(...loaded.errors.map((message) => `${file}: ${message}`))
  }

  return { plugins, errors }
}

export function pluginComponentDirs(plugins, key) {
  return plugins.flatMap((plugin) => (plugin.enabled === false ? [] : (plugin[key] || [])).map((dir) => ({
    dir,
    scope: `plugin:${plugin.scope}:${plugin.name}`,
    plugin
  })))
}

export function pluginMcpServers(plugins) {
  const servers = {}
  for (const plugin of plugins) {
    if (plugin.enabled === false) continue
    Object.assign(servers, plugin.mcpServers || {})
  }
  return servers
}
