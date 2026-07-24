import path from "node:path"
import { access, readFile, readdir } from "node:fs/promises"
import { userRootDir } from "../storage/paths.mjs"
import {
  discoverCompatPluginManifestCandidates,
  discoverOpenCodePluginFiles
} from "../compat/ecosystem-discovery.mjs"

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

async function expandCandidate(item) {
  if (!item.directory) return [item]
  return (await listManifestFiles(item.file)).map((file) => ({
    ...item,
    file,
    directory: false,
    rootMode: "manifest-dir"
  }))
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

function normalizeComponentSpec(value, rootDir, label, errors) {
  if (isPlainObject(value)) {
    return {
      enabled: value.enabled !== false,
      dirs: normalizeComponentDirs(value.dirs ?? value.paths ?? value.path ?? value.dir ?? [], rootDir, label, errors)
    }
  }
  return {
    enabled: true,
    dirs: normalizeComponentDirs(value, rootDir, label, errors)
  }
}

async function normalizeMcpServers(manifest, rootDir, errors) {
  const out = {}
  const inlineServers = manifest.mcpServers || manifest.mcp_servers
  if (isPlainObject(inlineServers)) Object.assign(out, inlineServers)
  if (typeof inlineServers === "string") {
    const filePath = resolveRelativePath(rootDir, inlineServers, "mcpServers", errors)
    if (filePath) {
      const parsed = await readJsonFile(filePath, `mcp file ${inlineServers}`, errors)
      if (parsed) Object.assign(out, parsed.servers || parsed.mcpServers || parsed.mcp_servers || {})
    }
  }

  for (const entry of asArray(manifest.mcp)) {
    if (typeof entry === "string") {
      const filePath = resolveRelativePath(rootDir, entry, "mcp", errors)
      if (!filePath) continue
      const parsed = await readJsonFile(filePath, `mcp file ${entry}`, errors)
      if (!parsed) continue
      Object.assign(out, parsed.servers || parsed.mcpServers || parsed.mcp_servers || {})
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
      Object.assign(out, parsed.servers || parsed.mcpServers || parsed.mcp_servers || {})
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

function manifestRootDir(filePath, rootMode) {
  const manifestDir = path.dirname(filePath)
  if (rootMode === "parent-dir") return path.dirname(manifestDir)
  return manifestDir
}

function collectUnsupported(manifest, ecosystem) {
  const out = []
  const components = isPlainObject(manifest.components) ? manifest.components : {}
  const keys = [
    ["apps", "apps"],
    ["lsp", "lsp"],
    ["monitors", "monitors"],
    ["commands", "commands"],
    ["tools", "tools"]
  ]
  for (const [key, label] of keys) {
    if (manifest[key] !== undefined || components[key] !== undefined) {
      out.push({ kind: "unsupported_component", ecosystem, component: label })
    }
  }
  return out
}

async function loadManifest(filePath, scope, { ecosystem = "kkcode", rootMode = "manifest-dir" } = {}) {
  const errors = []
  const manifest = await readJsonFile(filePath, "plugin manifest", errors)
  if (!manifest) return { plugin: null, errors }

  const rootDir = manifestRootDir(filePath, rootMode)
  const components = isPlainObject(manifest.components) ? manifest.components : {}
  const name = typeof manifest.name === "string" && manifest.name.trim()
    ? manifest.name.trim()
    : path.basename(rootDir)
  const rawSkills = manifest.skills ?? components.skills
  const defaultPortableSkills = rawSkills === undefined && ["claude", "codex"].includes(ecosystem)
    ? ["./skills", "./"]
    : rawSkills
  const skillSpec = normalizeComponentSpec(defaultPortableSkills, rootDir, "skills", errors)
  const agentSpec = normalizeComponentSpec(manifest.agents ?? components.agents, rootDir, "agents", errors)
  const hookSpec = normalizeComponentSpec(manifest.hooks ?? components.hooks, rootDir, "hooks", errors)

  const plugin = {
    name,
    version: typeof manifest.version === "string" ? manifest.version : null,
    manifestVersion: manifest.manifest_version ?? manifest.manifestVersion ?? 1,
    ecosystem,
    sourceEcosystem: ecosystem,
    enabled: manifest.enabled !== false && manifest.disabled !== true,
    displayName: typeof manifest.displayName === "string" ? manifest.displayName.trim() : null,
    description: typeof manifest.description === "string" ? manifest.description : null,
    author: manifest.author || null,
    homepage: typeof manifest.homepage === "string" ? manifest.homepage : null,
    repository: manifest.repository || null,
    license: typeof manifest.license === "string" ? manifest.license : null,
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter((item) => typeof item === "string") : [],
    disabledReason: typeof manifest.disabled_reason === "string" ? manifest.disabled_reason : null,
    scope,
    source: filePath,
    rootDir,
    skillsEnabled: skillSpec.enabled,
    agentsEnabled: agentSpec.enabled,
    hooksEnabled: hookSpec.enabled,
    skills: skillSpec.dirs,
    agents: agentSpec.dirs,
    hooks: hookSpec.dirs,
    mcpServers: await normalizeMcpServers(manifest, rootDir, errors),
    capabilities: normalizeCapabilities(manifest),
    unsupported: collectUnsupported(manifest, ecosystem)
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

export async function discoverLocalPluginManifests(cwd = process.cwd(), config = {}, {
  allowProjectSources = true
} = {}) {
  const compatCandidates = await discoverCompatPluginManifestCandidates(cwd, config)
  const legacyFiles = (await candidateManifestFiles(cwd)).map((file) => ({
    file,
    ecosystem: "kkcode",
    rootMode: "manifest-dir"
  }))
  const rawCandidates = [...compatCandidates, ...legacyFiles]
  const expanded = []
  for (const item of rawCandidates) expanded.push(...await expandCandidate(item))
  const seen = new Set()
  const files = expanded.filter((item) => {
    const resolved = path.resolve(item.file)
    if (seen.has(resolved)) return false
    seen.add(resolved)
    return true
  })
  const plugins = []
  const errors = []

  for (const item of files) {
    const file = item.file
    if (!(await exists(file))) continue
    const scope = isWithin(cwd, file) ? "project" : "global"
    if (!allowProjectSources && scope === "project") continue
    const loaded = await loadManifest(file, scope, item)
    if (loaded.plugin) plugins.push(loaded.plugin)
    errors.push(...loaded.errors.map((message) => `${file}: ${message}`))
    if (loaded.plugin?.unsupported?.length) {
      for (const unsupported of loaded.plugin.unsupported) {
        errors.push(`${file}: unsupported_component ${unsupported.component} from ${unsupported.ecosystem}`)
      }
    }
  }

  for (const file of await discoverOpenCodePluginFiles(cwd, config)) {
    const ext = path.extname(file)
    const scope = isWithin(cwd, file) ? "project" : "global"
    if (!allowProjectSources && scope === "project") continue
    plugins.push({
      name: path.basename(file, ext),
      version: null,
      manifestVersion: 1,
      ecosystem: "opencode",
      sourceEcosystem: "opencode",
      enabled: false,
      displayName: null,
      description: null,
      scope,
      source: file,
      rootDir: path.dirname(file),
      skillsEnabled: false,
      agentsEnabled: false,
      hooksEnabled: false,
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: {},
      capabilities: { allowedAgentPermissions: ["default"] },
      unsupported: [{ kind: "unsupported_component", ecosystem: "opencode", component: `plugin-file:${ext}` }]
    })
    errors.push(`${file}: unsupported_component opencode plugin files are discovered but not executed`)
  }

  return { plugins, errors }
}

export function pluginComponentDirs(plugins, key) {
  const enabledFlag = `${key}Enabled`
  return plugins.flatMap((plugin) => (plugin.enabled === false || plugin[enabledFlag] === false ? [] : (plugin[key] || [])).map((dir) => ({
    dir,
    scope: `plugin:${plugin.scope}:${plugin.name}`,
    plugin
  })))
}

export function pluginMcpServers(plugins) {
  const servers = {}
  for (const plugin of plugins) {
    if (plugin.enabled === false) continue
    for (const [name, server] of Object.entries(plugin.mcpServers || {})) {
      servers[`${plugin.name}/${name}`] = { ...server, pluginName: plugin.name, sourceEcosystem: plugin.sourceEcosystem || plugin.ecosystem || "kkcode" }
    }
  }
  return servers
}
