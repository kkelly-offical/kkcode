import path from "node:path"
import { access, readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { readReviewState } from "../review/review-store.mjs"
import { fsckSessionStore, getSession } from "./store.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

const DEFAULT_GATE_TIMEOUT_MS = 15 * 60 * 1000
const GATE_PREFS_FILE = path.join(homedir(), ".kkcode", "gate-preferences.json")

// --- Gate preference persistence ---
let cachedPrefs = null

async function loadGatePreferences() {
  if (cachedPrefs) return cachedPrefs
  try {
    const raw = await readFile(GATE_PREFS_FILE, "utf8")
    cachedPrefs = JSON.parse(raw)
    return cachedPrefs
  } catch {
    return null
  }
}

export async function saveGatePreferences(prefs) {
  cachedPrefs = prefs
  await mkdir(path.dirname(GATE_PREFS_FILE), { recursive: true })
  await writeFile(GATE_PREFS_FILE, JSON.stringify(prefs, null, 2), "utf8")
}

export async function hasGatePreferences() {
  const prefs = await loadGatePreferences()
  return prefs !== null
}

export async function getGatePreferences() {
  return loadGatePreferences()
}

export function buildGatePromptText() {
  return [
    "[SYSTEM] LongAgent 质量门控配置",
    "",
    "LongAgent 完成后会运行以下质量检查门控，通过后才标记为完成：",
    "  1. build  — 运行 npm run build 检查构建是否通过",
    "  2. test   — 运行测试套件确保无回归",
    "  3. review — 检查代码审查状态",
    "  4. health — 检查会话存储健康状态",
    "  5. budget — 检查 token 预算是否超限",
    "",
    "请选择要启用的门控（用逗号分隔，或输入 all/none）：",
    "例如: build,test 或 all 或 none",
    "",
    "提示：门控可以在配置文件中随时修改 (agent.longagent.usability_gates)"
  ].join("\n")
}

export function parseGateSelection(answer) {
  const text = String(answer || "").toLowerCase().trim()
  const gates = ["build", "test", "review", "health", "budget"]
  if (text === "all" || text === "全部" || text === "所有") {
    return Object.fromEntries(gates.map(g => [g, true]))
  }
  if (text === "none" || text === "无" || text === "不需要" || text === "跳过") {
    return Object.fromEntries(gates.map(g => [g, false]))
  }
  const selected = new Set(
    text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
  )
  return Object.fromEntries(gates.map(g => [g, selected.has(g)]))
}

function isEnabled(config, gateName) {
  return config?.agent?.longagent?.usability_gates?.[gateName]?.enabled !== false
}

async function fileExists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function readPackageScripts(cwd) {
  const pkgPath = path.join(cwd, "package.json")
  const raw = await readFile(pkgPath, "utf8").catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed?.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {}
  } catch {
    return null
  }
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

function outputSnippet(result) {
  const lines = `${result.stdout || ""}\n${result.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.slice(-12).join(" | ")
}

async function runCommand({ command, args, cwd, timeoutMs = DEFAULT_GATE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let done = false
    let stdout = ""
    let stderr = ""
    let timedOut = false

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on("data", (buf) => {
      stdout += String(buf)
    })
    child.stderr.on("data", (buf) => {
      stderr += String(buf)
    })

    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut: false
      })
    })

    child.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout,
        stderr,
        timedOut
      })
    })
  })
}

async function checkBuildGate({ cwd, config }) {
  if (!isEnabled(config, "build")) {
    return { enabled: false, status: "disabled", reason: "build gate disabled" }
  }
  const scripts = await readPackageScripts(cwd)
  if (!scripts) {
    return { enabled: true, status: "not_applicable", reason: "package.json not found" }
  }
  if (!scripts.build) {
    return { enabled: true, status: "not_applicable", reason: "build script not found" }
  }
  const result = await runCommand({
    command: npmBin(),
    args: ["run", "build", "--silent"],
    cwd
  })
  if (result.ok) {
    return { enabled: true, status: "pass", reason: "build succeeded" }
  }
  return {
    enabled: true,
    status: "fail",
    reason: result.timedOut ? "build timed out" : `build failed with code ${result.code}`,
    output: outputSnippet(result)
  }
}

async function checkTestGate({ cwd, config }) {
  if (!isEnabled(config, "test")) {
    return { enabled: false, status: "disabled", reason: "test gate disabled" }
  }
  const scripts = await readPackageScripts(cwd)
  const hasTestDir = await fileExists(path.join(cwd, "test"))
  const hasNodeTestDir = await fileExists(path.join(cwd, "tests"))

  if (!scripts && !hasTestDir && !hasNodeTestDir) {
    return { enabled: true, status: "not_applicable", reason: "no package.json or test directory" }
  }

  let result
  if (scripts?.test) {
    result = await runCommand({
      command: npmBin(),
      args: ["run", "test", "--silent"],
      cwd
    })
  } else if (hasTestDir || hasNodeTestDir) {
    result = await runCommand({
      command: process.execPath,
      args: ["--test"],
      cwd
    })
  } else {
    return { enabled: true, status: "not_applicable", reason: "test script not found" }
  }

  if (result.ok) {
    return { enabled: true, status: "pass", reason: "tests succeeded" }
  }
  return {
    enabled: true,
    status: "fail",
    reason: result.timedOut ? "tests timed out" : `tests failed with code ${result.code}`,
    output: outputSnippet(result)
  }
}

async function checkReviewGate({ cwd, config, sessionId }) {
  if (!isEnabled(config, "review")) {
    return { enabled: false, status: "disabled", reason: "review gate disabled" }
  }
  const state = await readReviewState(cwd)
  if (!state.files.length) {
    return { enabled: true, status: "not_applicable", reason: "no review file state" }
  }
  if (state.sessionId && sessionId && state.sessionId !== sessionId) {
    return {
      enabled: true,
      status: "not_applicable",
      reason: `review state belongs to other session (${state.sessionId})`
    }
  }
  const pending = state.files.filter((file) => file.status !== "approved")
  if (pending.length > 0) {
    return {
      enabled: true,
      status: "fail",
      reason: `${pending.length} review item(s) not approved`,
      output: pending.slice(0, 5).map((item) => item.path).join(", ")
    }
  }
  return { enabled: true, status: "pass", reason: "all review items approved" }
}

async function checkHealthGate({ config }) {
  if (!isEnabled(config, "health")) {
    return { enabled: false, status: "disabled", reason: "health gate disabled" }
  }
  const report = await fsckSessionStore()
  if (report.ok) {
    return { enabled: true, status: "pass", reason: "session fsck passed" }
  }
  return {
    enabled: true,
    status: "fail",
    reason: "session fsck failed",
    output: report.suggestions.join(" | ")
  }
}

async function checkBudgetGate({ config, sessionId }) {
  if (!isEnabled(config, "budget")) {
    return { enabled: false, status: "disabled", reason: "budget gate disabled" }
  }
  const sessionData = await getSession(sessionId)
  const budgetState = sessionData?.session?.budgetState || null
  if (!budgetState) {
    return { enabled: true, status: "pass", reason: "no budget restriction state" }
  }
  const strategy = config?.usage?.budget?.strategy || "warn"
  if (budgetState.exceeded && strategy === "block") {
    return {
      enabled: true,
      status: "fail",
      reason: "budget exceeded with strategy=block",
      output: (budgetState.warnings || []).join(" | ")
    }
  }
  if ((budgetState.warnings || []).length > 0) {
    return {
      enabled: true,
      status: "warn",
      reason: "budget warning",
      output: budgetState.warnings.join(" | ")
    }
  }
  return { enabled: true, status: "pass", reason: "budget gate passed" }
}

function isPassingStatus(status) {
  return status === "pass" || status === "not_applicable"
}

export async function runUsabilityGates({
  sessionId,
  config,
  cwd = process.cwd(),
  iteration = 0
}) {
  const checks = {
    build: await checkBuildGate({ cwd, config }),
    test: await checkTestGate({ cwd, config }),
    review: await checkReviewGate({ cwd, config, sessionId }),
    health: await checkHealthGate({ config }),
    budget: await checkBudgetGate({ config, sessionId })
  }

  for (const [gate, result] of Object.entries(checks)) {
    await EventBus.emit({
      type: EVENT_TYPES.LONGAGENT_GATE_CHECKED,
      sessionId,
      payload: {
        gate,
        status: result.status,
        reason: result.reason,
        iteration
      }
    })
  }

  const failures = Object.entries(checks)
    .filter(([, result]) => result.enabled !== false && !isPassingStatus(result.status))
    .map(([gate, result]) => ({
      gate,
      status: result.status,
      reason: result.reason,
      output: result.output || ""
    }))

  return {
    allPass: failures.length === 0,
    gates: checks,
    failures
  }
}
