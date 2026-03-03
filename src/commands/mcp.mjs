import { Command } from "commander"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { buildContext, printContextWarnings } from "../context.mjs"
import { McpRegistry } from "../mcp/registry.mjs"
import { ensureDefaultSkillPack } from "../skill/registry.mjs"
import { userRootDir } from "../storage/paths.mjs"

const DEFAULT_MCP_INIT_CONFIG = {
  servers: {
    context7: {
      enabled: false,
      command: "npx",
      args: ["--yes", "@upstash/context7-mcp"],
      startup_timeout_ms: 60000
    }
  }
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function projectMcpPath(cwd = process.cwd()) {
  return join(cwd, ".kkcode", "mcp.json")
}

function globalMcpPath() {
  return join(userRootDir(), "mcp.json")
}

function renderPathLabel(filePath) {
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return filePath
  const homeNorm = resolve(home).replace(/\\/g, "/")
  const fileNorm = resolve(filePath).replace(/\\/g, "/")
  if (fileNorm === homeNorm) return "~"
  if (fileNorm.startsWith(`${homeNorm}/`)) {
    return `~${fileNorm.slice(homeNorm.length)}`
  }
  return filePath
}

function globalScopeLabel() {
  const home = process.env.HOME || process.env.USERPROFILE
  const userRoot = globalMcpPath()
  if (!home) return userRoot
  const homeNorm = resolve(home).replace(/\\/g, "/")
  const rootNorm = resolve(userRoot).replace(/\\/g, "/")
  if (rootNorm === homeNorm) return "~"
  if (rootNorm.startsWith(`${homeNorm}/`)) {
    return `~${rootNorm.slice(homeNorm.length)}`
  }
  return userRoot
}

function legacyMcpPaths(cwd = process.cwd()) {
  return [
    { kind: "local", path: join(cwd, ".mcp.json"), label: ".mcp.json" },
    { kind: "local", path: join(cwd, ".mcp", "config.json"), label: ".mcp/config.json" },
    { kind: "project", path: join(cwd, ".kkcode", "mcp.json"), label: ".kkcode/mcp.json" },
    { kind: "global", path: globalMcpPath(), label: renderPathLabel(globalMcpPath()) }
  ]
}

function stringifyMcpConfig(config) {
  return JSON.stringify(config, null, 2) + "\n"
}

function collectServers(fileConfig) {
  if (!fileConfig || typeof fileConfig !== "object") return []
  const servers = fileConfig.servers || fileConfig.mcpServers || {}
  if (!servers || typeof servers !== "object") return []
  return Object.entries(servers)
    .filter((entry) => {
      const name = entry[0]
      const cfg = entry[1]
      return !!name && cfg !== null && cfg !== undefined
    })
    .map((entry) => entry[0])
}

function parseMcpConfig(text) {
  if (!text || !text.trim()) return { raw: {}, error: "empty" }
  const normalizedText = text.replace(/^\uFEFF/, "").trim()
  const first = normalizedText[0]
  if (first !== "{" && first !== "[") {
    return { raw: null, error: "unsupported format (expected JSON)" }
  }
  try {
    return { raw: JSON.parse(normalizedText), error: null }
  } catch (error) {
    const cleaned = normalizedText
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,\s*([}\]])/g, "$1")
    try {
      return { raw: JSON.parse(cleaned), error: null }
    } catch (fallbackError) {
      return { raw: null, error: error.message || "invalid JSON", fallbackError: fallbackError?.message || "invalid JSON" }
    }
  }
}

export function createMcpCommand() {
  const cmd = new Command("mcp").description("manage MCP servers and tools")

  cmd
    .command("list")
    .description("list configured and healthy MCP servers")
    .action(async () => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      console.log(JSON.stringify(McpRegistry.listServers(), null, 2))
    })

  cmd
    .command("tools")
    .description("list tools for all MCP servers")
    .action(async () => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      console.log(JSON.stringify(McpRegistry.listTools(), null, 2))
    })

  cmd
    .command("resources")
    .description("list resources for MCP server")
    .requiredOption("--server <name>", "server name")
    .action(async (options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      const list = await McpRegistry.listResources(options.server)
      console.log(JSON.stringify(list, null, 2))
    })

  cmd
    .command("templates")
    .description("list templates for MCP server")
    .requiredOption("--server <name>", "server name")
    .action(async (options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      const list = await McpRegistry.listTemplates(options.server)
      console.log(JSON.stringify(list, null, 2))
    })

  cmd
    .command("test")
    .description("test MCP health and tool discovery")
    .option("--json", "print JSON output", false)
    .action(async (options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      const snapshot = McpRegistry.healthSnapshot()
      const tools = McpRegistry.listTools()
      const healthy = snapshot.filter((item) => item.ok).length
      const unhealthy = snapshot.length - healthy

      if (options.json) {
        console.log(JSON.stringify({
          configured: snapshot.length,
          healthy,
          unhealthy,
          tools: tools.length,
          servers: snapshot
        }, null, 2))
        return
      }

      console.log(`configured: ${snapshot.length}`)
      console.log(`healthy: ${healthy}`)
      console.log(`unhealthy: ${unhealthy}`)
      console.log(`tools: ${tools.length}`)
      for (const item of snapshot) {
        const status = item.ok ? "ok" : "fail"
        const reason = item.reason || "-"
        const error = item.error ? ` | ${item.error}` : ""
        console.log(`- ${item.name} [${item.transport}] ${status} (${reason})${error}`)
      }
    })

  cmd
    .command("discover")
    .description("discover MCP config files in current workspace")
    .option("--json", "print JSON output", false)
    .action(async (options) => {
      const cwd = process.cwd()
      const candidates = legacyMcpPaths(cwd)
      const results = []

      for (const item of candidates) {
        const existsNow = await exists(item.path)
        if (!existsNow) {
          results.push({ ...item, exists: false })
          continue
        }

        const text = await readFile(item.path, "utf8")
        const { raw, error, fallbackError } = parseMcpConfig(text)
        const servers = collectServers(raw)
        results.push({
          ...item,
          exists: true,
          parsed: error === null,
          parseError: error,
          parseFallbackError: fallbackError || null,
          servers,
          serverCount: servers.length
        })
      }

      const foundCount = results.filter((entry) => entry.exists).length
      if (options.json) {
        console.log(JSON.stringify({ total: candidates.length, found: foundCount, configs: results }, null, 2))
        return
      }

      if (!foundCount) {
        console.log("no MCP config file found")
        console.log("run: kkcode mcp init --project")
        return
      }

      for (const item of results) {
        if (!item.exists) continue
        if (!item.parsed) {
          const pathHint = item.parseFallbackError ? ` fallback=${item.parseFallbackError}` : ""
          console.log(`- ${item.label}: parse error (${item.parseError})${pathHint}`)
          if (item.parseError?.includes("unsupported format")) {
            console.log("  tip: check file is JSON and contains { servers: ... } or { mcpServers: ... }")
          }
        } else {
          console.log(`- ${item.label}: ${item.serverCount} server(s)`)
          for (const serverName of item.servers) {
            console.log(`  - ${serverName}`)
          }
        }
      }
    })

  cmd
    .command("init")
    .description("initialize MCP config for quick one-click import")
    .option("--global", `write to ${globalScopeLabel()}`)
    .option("--project", "write to .kkcode/mcp.json")
    .option("--all", "write both global and project config")
    .option("--force", "overwrite existing files")
    .option("--with-skills", "also initialize built-in skill packs")
    .action(async (options) => {
      const includeProject = options.all || options.project || (!options.global && !options.project)
      const includeGlobal = options.all || options.global || (!options.global && !options.project)
      const targets = []

      if (includeProject) targets.push(projectMcpPath(process.cwd()))
      if (includeGlobal) targets.push(globalMcpPath())

      if (!targets.length) {
        console.log("no target selected for MCP init")
        return
      }

      const rendered = stringifyMcpConfig(DEFAULT_MCP_INIT_CONFIG)
      for (const target of targets) {
        await mkdir(dirname(target), { recursive: true })
        if (await exists(target) && !options.force) {
          console.log(`skip: exists ${target}`)
          continue
        }
        await writeFile(target, rendered, "utf8")
        console.log(`created: ${target}`)
      }

      if (options.withSkills) {
        const seedResults = await ensureDefaultSkillPack({
          cwd: process.cwd(),
          force: options.force || false,
          includeProject,
          includeGlobal
        })
        if (seedResults.length) {
          console.log("skill init summary:")
          for (const item of seedResults) {
            const created = item.created.join(", ")
            const skipped = item.skipped.join(", ")
            if (created.length) {
              console.log(`- [${item.scope}] created: ${created}`)
            }
            if (skipped.length) {
              console.log(`- [${item.scope}] already exists: ${skipped}`)
            }
          }
        }
      }

      console.log("tip: set enabled: true for desired servers after editing")
      if (options.withSkills) {
        console.log("tip: run kkcode skill init to re-seed or adjust scopes")
      }
      console.log("kkcode mcp discover  # verify config is readable")
      console.log("kkcode mcp test      # verify health")
    })

  return cmd
}
