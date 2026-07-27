import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { mkdir } from "node:fs/promises"
import { PACKAGE_NAME, PACKAGE_VERSION } from "../version.mjs"
import { updateStatePath } from "../storage/paths.mjs"
import { shouldAutoInstallUpdate } from "../cli/preflight.mjs"
import { buildRequestHeaders } from "../http/identity.mjs"

const DEFAULT_REGISTRY = "https://registry.npmjs.org"
const DEFAULT_TIMEOUT_MS = 2500

function normalizeRegistry(registry = DEFAULT_REGISTRY) {
  return String(registry || DEFAULT_REGISTRY).replace(/\/+$/, "")
}

function encodePackageName(name) {
  // replaceAll：字符串模式的 replace 只换第一个匹配。今天的包名只有一个
  // 斜杠所以看不出问题，但这是个等着被更深的命名空间踩中的坑。
  return String(name).replaceAll("/", "%2F")
}

function parseVersion(version) {
  const match = String(version || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : []
  }
}

function compareIdentifier(a, b) {
  if (a === b) return 0
  const aNum = typeof a === "number"
  const bNum = typeof b === "number"
  if (aNum && bNum) return a > b ? 1 : -1
  if (aNum) return -1
  if (bNum) return 1
  return String(a) > String(b) ? 1 : -1
}

export function compareVersions(a, b) {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  if (!av || !bv) return String(a || "").localeCompare(String(b || ""))
  for (const key of ["major", "minor", "patch"]) {
    if (av[key] !== bv[key]) return av[key] > bv[key] ? 1 : -1
  }
  const aPre = av.prerelease
  const bPre = bv.prerelease
  if (!aPre.length && !bPre.length) return 0
  if (!aPre.length) return 1
  if (!bPre.length) return -1
  const len = Math.max(aPre.length, bPre.length)
  for (let i = 0; i < len; i++) {
    if (aPre[i] === undefined) return -1
    if (bPre[i] === undefined) return 1
    const cmp = compareIdentifier(aPre[i], bPre[i])
    if (cmp !== 0) return cmp
  }
  return 0
}

export function updateConfig(config = {}) {
  return {
    enabled: config.update?.enabled !== false,
    notifyOnStartup: config.update?.notify_on_startup !== false,
    autoInstall: Boolean(config.update?.auto_install),
    channel: config.update?.channel || "latest",
    checkIntervalHours: Number(config.update?.check_interval_hours ?? 12),
    registry: config.update?.registry || DEFAULT_REGISTRY,
    timeoutMs: Number(config.update?.timeout_ms ?? DEFAULT_TIMEOUT_MS)
  }
}

async function readUpdateState(file = updateStatePath()) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return {}
  }
}

async function writeUpdateState(state, file = updateStatePath()) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
}

export async function fetchPackageMetadata({ packageName = PACKAGE_NAME, registry = DEFAULT_REGISTRY, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this Node runtime")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs || DEFAULT_TIMEOUT_MS)))
  try {
    const url = `${normalizeRegistry(registry)}/${encodePackageName(packageName)}`
    const res = await fetchImpl(url, {
      headers: buildRequestHeaders({
        target: "npm-registry",
        accept: "application/vnd.npm.install-v1+json, application/json"
      }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function checkForUpdate(config = {}, options = {}) {
  const cfg = updateConfig(config)
  if (!cfg.enabled && !options.force) return { ok: false, skipped: true, reason: "disabled" }

  const now = Number(options.now ?? Date.now())
  const stateFile = options.stateFile || updateStatePath()
  const state = options.state ?? await readUpdateState(stateFile)
  const intervalMs = Math.max(0, cfg.checkIntervalHours) * 60 * 60 * 1000
  if (!options.force && intervalMs > 0 && state.checkedAt && now - Date.parse(state.checkedAt) < intervalMs) {
    return { ok: true, skipped: true, reason: "interval", state }
  }

  const metadata = await fetchPackageMetadata({
    packageName: options.packageName || PACKAGE_NAME,
    registry: cfg.registry,
    timeoutMs: cfg.timeoutMs,
    fetchImpl: options.fetchImpl
  })
  const distTags = metadata["dist-tags"] || {}
  const latestVersion = distTags[cfg.channel] || distTags.latest || metadata.version
  const currentVersion = options.currentVersion || PACKAGE_VERSION
  const hasUpdate = Boolean(latestVersion && compareVersions(latestVersion, currentVersion) > 0)
  const result = {
    ok: true,
    packageName: options.packageName || PACKAGE_NAME,
    channel: cfg.channel,
    currentVersion,
    latestVersion,
    hasUpdate,
    installSpec: `${options.packageName || PACKAGE_NAME}@${cfg.channel}`,
    checkedAt: new Date(now).toISOString()
  }
  await writeUpdateState(result, stateFile)
  return result
}

export function updateMessage(result) {
  if (!result?.hasUpdate) return null
  return `Update available: kkcode ${result.currentVersion} -> ${result.latestVersion} (${result.channel}). Run: kkcode update --install`
}

export async function maybeNotifyUpdateOnStartup(config = {}, options = {}) {
  const cfg = updateConfig(config)
  if (!cfg.enabled || !cfg.notifyOnStartup || process.env.KKCODE_DISABLE_UPDATE_CHECK === "1") return null
  try {
    const result = await checkForUpdate(config, options)
    const message = updateMessage(result)
    if (message) {
      const print = options.print || console.error
      print(message)
      // KKCODE_AUTO_UPDATE 优先于 update.auto_install，方便容器/CI 里显式开启
      if (shouldAutoInstallUpdate(config, options.env || process.env)) {
        const install = await installUpdate(config, { channel: result.channel, stdio: "ignore" })
        if (install.ok) print(`kkcode update installed ${result.latestVersion}; restart kkcode to use it.`)
        else print(`kkcode auto-update failed: ${install.error}`)
      }
    }
    return result
  } catch (error) {
    if (options.verbose) (options.print || console.error)(`kkcode update check failed: ${error.message}`)
    return { ok: false, error: error.message }
  }
}

function runCommand(command, args, { cwd = process.cwd(), env = process.env, stdio = "inherit" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio, shell: process.platform === "win32" })
    child.on("exit", (code) => resolve({ ok: code === 0, code }))
    child.on("error", (error) => resolve({ ok: false, code: 1, error: error.message }))
  })
}

export async function installUpdate(config = {}, options = {}) {
  const cfg = updateConfig(config)
  const channel = options.channel || cfg.channel || "latest"
  const packageName = options.packageName || PACKAGE_NAME
  const npm = options.npmCommand || process.env.npm_execpath || "npm"
  const args = ["install", "-g", `${packageName}@${channel}`]
  const result = await (options.runCommand || runCommand)(npm, args, options)
  if (!result.ok) return { ok: false, code: result.code, error: result.error || `npm exited with ${result.code}` }
  return { ok: true, command: npm, args }
}
