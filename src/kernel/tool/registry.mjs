import { runtimeCwd } from "../core/runtime-context.mjs"
import { modelToolSurface, searchToolMetadata } from './discovery.mjs'
import path from "node:path"
import os from "node:os"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { access, realpath, stat, statfs } from "node:fs/promises"
import { exec as execCb, spawn } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { atomicWriteFile, assertAtomicWriteTarget, recoverCreatedAtomicFile, replaceInFileTransactional, replaceAllInFileTransactional, diffLineCount, buildStructuredPatch } from "./edit-transaction.mjs"
import { registerAtomicMutationPreflights } from './mutation-preflight.mjs'
import { registerBashPreflights, assertBashLifecycle } from './bash-preflight.mjs'
import { withFileLock } from "./file-lock-manager.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { scopedBackgroundTask, scopedBackgroundTasks, cancelScopedBackgroundTask, stopScopedBackgroundTask } from './background-task-scope.mjs'
import {processLifetime, serviceCommand, processLogWindow} from './process-lifetime.mjs'
import { runManagedProcess } from './managed-process.mjs'
import { createTaskTool, createTaskGroupTool, createChildControlTools, taskModelSchema } from "./task-tool.mjs"
import { normalizeToolOutcome } from './result-outcome.mjs'
import { beginToolOperation } from './operation-journal.mjs'
import { markToolNoMutation } from '../core/execution-outcome.mjs'
import { makeToolResult } from '../core/types.mjs'
import { McpRegistry } from "../mcp/registry.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import { askQuestionInteractive } from "./question-prompt.mjs"
import { checkBashAllowed } from "../permission/exec-policy.mjs"
import { safeGitReadInvocation } from '../permission/safe-git-read.mjs'
import { inflateSync } from "node:zlib"
import { truncationNotice, completeNotice } from "./output-budget.mjs"
import { guardedFetch, allowPrivateHosts } from "../../net/url-guard.mjs"
import { readablePage } from "../../net/readable-page.mjs"
import { assertWebDataPolicy } from '../permission/data-policy.mjs'
import { fileOpsTools } from "./file-ops.mjs"
import { normalizePermissionLevel } from "../permission/rules.mjs"
import { gitAutoTools } from "./git-auto.mjs"
import { gitFullAutoTools } from "./git-full-auto.mjs"
import { markFileRead, refreshFileReadStateFromDisk } from "./file-read-state.mjs"
import { validateExistingFileMutation } from "./mutation-guard.mjs"
import { buildMutationObservability } from "../../observability/edit-diagnostics.mjs"
import { resolveWorkspacePath } from "./workspace-fs.mjs"
import { buildRequestHeaders } from "../../http/identity.mjs"
import { IMAGE_EXTENSIONS, IMAGE_MIME_TYPES } from "./image-util.mjs"
import { normalizeImageBlock, IMAGE_LIMITS } from '../media/images.mjs'
import { createBrowserTool } from '../browser/controller.mjs'
import { createToolBatch } from './batch.mjs'
import { createToolProgram } from './program.mjs'
import { archiveToolText, createArtifactTools } from './artifacts.mjs'
import { markStrictBuiltinTools } from '../isolation/docker-executor.mjs'
import { createBrowserBridgeTool } from '../browser/bridge.mjs'
import { createLspTools } from '../lsp/service.mjs'
import { createOfficeTools } from '../office/service.mjs'
import { createBrowserRecipeTools } from './browser-recipe.mjs'
import { createMcpCatalogTools } from './mcp-catalog.mjs'
import { resolveManagedPluginPath } from '../plugin/integrity.mjs'
import {
  readSandboxConfig,
  inspectSandboxStatus,
  buildSandboxedCommand,
  resolveWritableDir,
  takeSandboxUnavailableNotice,
  sandboxFailureHint
} from "./sandbox.mjs"
import { userRootDir } from "../../storage/paths.mjs"
import { deprecatedSingletonAlias } from "../core/deprecations.mjs"
import { loadToolPrompt } from './prompt-loader.mjs'

const exec = promisify(execCb)

function schema(type, description) {
  return { type, description }
}

function safeStringify(value) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

function planSlug(text = "") {
  const raw = String(text || "plan")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return (raw || "plan").slice(0, 48)
}

async function savePlanFile(cwd, plan, files = []) {
  const dir = path.join(cwd, ".kkcode", "plans")
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const firstHeading = String(plan || "").split("\n").find((line) => line.trim()) || "plan"
  const filePath = path.join(dir, `${stamp}-${planSlug(firstHeading)}.md`)
  const body = [
    "---",
    `created_at: ${new Date().toISOString()}`,
    `files: ${JSON.stringify(Array.isArray(files) ? files : [])}`,
    "---",
    "",
    String(plan || "").trim(),
    ""
  ].join("\n")
  await writeFile(filePath, body, "utf8")
  return path.relative(cwd, filePath)
}

function signatureFor(config = {}, cwd = runtimeCwd(), allowProjectSources = true) {
  const payload = {
    cwd,
    allowProjectSources,
    tool: config.tool || {},
    mcp: config.mcp || {},
    runtime: config.runtime || {}
  }
  return JSON.stringify(payload)
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function isWithinWorkspace(cwd, target) {
  const root = path.resolve(cwd)
  const resolved = path.resolve(target)
  return resolved === root || resolved.startsWith(root + path.sep)
}

async function listDir(dir) {
  const items = await readdir(dir, { withFileTypes: true })
  return items.map((item) => `${item.isDirectory() ? "d" : "f"} ${item.name}`).join("\n")
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  const decimals = size >= 10 || unitIndex === 0 ? 0 : 1
  return `${size.toFixed(decimals)} ${units[unitIndex]}`
}

function detectShellInfo() {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe"
  }
  // The user's login shell is not Node's command shell. Keep this identical
  // to the execution path (and the Unix sandbox) rather than advertise Bash
  // syntax such as PIPESTATUS while actually running it under /bin/sh.
  return "/bin/sh"
}

async function detectGitRepo(cwd) {
  try {
    await exec("git rev-parse --is-inside-work-tree", { cwd, timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function detectPackageManagers(cwd) {
  const candidates = [
    ["npm", "package-lock.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lockb"]
  ]
  const present = []
  for (const [name, file] of candidates) {
    if (await exists(path.join(cwd, file))) present.push(name)
  }
  return present
}

function runRg(args, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false
    const child = spawn("rg", ["--no-config", ...args], {
      cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGTERM")
      setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 2000).unref()
      resolve({ ok: false, stdout, stderr: "search timed out" })
    }, timeoutMs)
    child.stdout.on("data", (b) => { stdout += b })
    child.stderr.on("data", (b) => { stderr += b })
    child.on("error", (e) => {
      if (done) return; done = true; clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? "ripgrep (rg) is not installed or is not on PATH; install ripgrep to use grep/glob" : e.message })
    })
    child.on("close", (code) => {
      if (done) return; done = true; clearTimeout(timer)
      resolve({ ok: code === 0 || code === 1, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

async function runGlob(pattern, cwd, searchPath) {
  if (!pattern) return "pattern is required"
  const target = searchPath
    ? await resolveWorkspacePath(cwd, searchPath)
    : "."
  const { ok, stdout, stderr } = await runRg(["--files", "--glob", pattern, target], cwd, 15000)
  if (!ok) return `[search error] ${stderr || "ripgrep could not complete the search"}`
  const text = stdout.trim()
  if (!text) return "no files matched"
  const lines = text.split("\n").filter(Boolean)
  if (lines.length > 200) {
    return lines.slice(0, 200).join("\n") + `\n... (+${lines.length - 200} more files)`
  }
  return `${lines.length} file(s):\n${text}`
}

async function runGrep(pattern, cwd, options = {}) {
  if (!pattern) return "pattern is required"
  const args = []
  if (options.multiline) args.push("-U", "--multiline-dotall")
  if (options.outputMode === "count") args.push("-c")
  else if (options.outputMode === "files") args.push("-l")
  else args.push("-n")
  if (options.beforeContext) args.push("-B", String(options.beforeContext))
  if (options.afterContext) args.push("-A", String(options.afterContext))
  if (options.context) args.push("-C", String(options.context))
  if (options.type) args.push("--type", options.type)
  if (options.glob) args.push("--glob", options.glob)
  if (options.maxCount) args.push("-m", String(options.maxCount))
  if (options.ignoreCase) args.push("-i")
  // Patterns are data even when they start with an option-like prefix.
  args.push('--', pattern)
  args.push(options.path ? await resolveWorkspacePath(cwd, options.path) : ".")
  const { stdout, stderr } = await runRg(args, cwd)
  let text = stdout.trim()
  if (!text && stderr) text = `[search error] ${stderr}`
  if (text && (options.offset || options.headLimit)) {
    const lines = text.split("\n")
    const start = options.offset || 0
    const limit = options.headLimit || lines.length
    text = lines.slice(start, start + limit).join("\n")
  }
  return text || "no matches"
}

const LONG_RUNNING_PATTERNS = [
  /\bnpm\s+run\s+dev\b/i,
  /\bnpm\s+run\s+start\b/i,
  /\bnpm\s+start\b/i,
  /\byarn\s+dev\b/i,
  /\byarn\s+start\b/i,
  /\bpnpm\s+dev\b/i,
  /\bpnpm\s+start\b/i,
  /\bnpx\s+next\s+dev\b/i,
  /\bnpx\s+serve\b/i,
  /\bnode\s+.*server/i,
  /\bwebpack\s+serve\b/i,
  /\bwebpack\s+--watch\b/i,
  /\bjest\s+--watch\b/i,
  /\bnodemon\b/i,
  /\btsc\s+--watch\b/i,
  /\btailwindcss\s+--watch\b/i,
  /\bnpm\s+run\s+serve\b/i,
  /\bnpm\s+run\s+watch\b/i
]

/**
 * read 的四层限制。此前 2000 行与 2000 字符都是内联魔数，且没有字节帽 ——
 * 一个 2000 行的 minified 文件仍能一次吃掉整个上下文预算。
 *
 * 行数上限保留（同行共识，且是有意的行为塑形：逼模型用 grep 定位而不是
 * 整文件倾倒），补的是字节帽与「截断必须发声」。
 */
const READ_DEFAULT_LINES = 2000
const READ_MAX_LINE_CHARS = 2000
/** 单次读取的字节帽，与 opencode 同量级 */
const READ_MAX_BYTES = 50 * 1024
/** 整个文件的大小闸：超过这个数连读都不读，让模型改用 grep */
const READ_MAX_FILE_BYTES = 10 * 1024 * 1024

/**
 * 二进制探测：NUL 字节，或替换字符（U+FFFD）占比过高。
 * 后者是 utf8 解码失败的痕迹 —— 只看扩展名会漏掉没有扩展名的可执行文件。
 */
export function looksBinary(text) {
  const sample = text.slice(0, 8192)
  if (sample.includes("\u0000")) return true
  const replacements = (sample.match(/\uFFFD/g) || []).length
  return sample.length > 0 && replacements / sample.length > 0.1
}

const BASH_TIMEOUT_MS = 120_000
const IS_WIN = process.platform === "win32"
function wrapCmd(cmd) { return IS_WIN ? `chcp 65001 >nul & ${cmd}` : cmd }

/** 按顶层 shell 分隔符分段；引号内容不拆，# 注释不泄漏到前一条命令的 argv。 */
function splitShellSegments(command, { hashComments = !IS_WIN } = {}) {
  const segments = []
  let current = ""
  let quote = ""
  let escaped = false
  let comment = false
  const push = () => {
    const segment = current.trim()
    if (segment) segments.push(segment)
    current = ""
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (comment) {
      if (char === "\n") {
        comment = false
        push()
      }
      continue
    }
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) quote = ""
      continue
    }
    if (char === "\"" || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === "#" && (!current || /\s$/.test(current))) {
      // `#` is a comment introducer for the POSIX shell used on Unix, but it is
      // an ordinary argv character in cmd.exe.  Keep it when the process itself
      // runs under cmd (Windows) or when an explicit `cmd /c|/k` invocation is
      // being inspected on another platform.
      const segmentShell = executableName(splitShellWords(current)[0])
      if (hashComments && segmentShell !== "cmd") {
        comment = true
        continue
      }
    }
    if (char === ";" || char === "\n" || char === "&" || char === "|") {
      push()
      if (command[index + 1] === char) index++
      continue
    }
    current += char
  }
  push()
  return segments
}

/** 只做长驻判定所需的轻量 argv 切分，不执行展开。 */
function splitShellWords(segment) {
  const words = []
  let current = ""
  let quote = ""
  const push = () => {
    if (current) words.push(current)
    current = ""
  }
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]
    if (quote) {
      if (char === quote) quote = ""
      else if (quote === '"' && char === "\\" && /["\\$`]/.test(segment[index + 1] || "")) {
        current += segment[++index]
      }
      else current += char
      continue
    }
    if (char === "\"" || char === "'") {
      quote = char
      continue
    }
    if (char === "\\") {
      const next = segment[index + 1] || ""
      // 空白/引号前是 shell escape；字母前保留反斜杠，才能识别 Windows 路径。
      if (next && /[\s'"\\]/.test(next)) current += segment[++index]
      else current += char
      continue
    }
    if (/\s/.test(char)) push()
    else current += char
  }
  push()
  return words
}

function executableName(token) {
  return String(token || "").split(/[\\/]/).at(-1).toLowerCase().replace(/\.(?:cmd|exe)$/i, "")
}


function wrapperName(token) {
  const name = executableName(token)
  // npx accepts package specs as commands (`npx cross-env@7 ...`).
  return name.replace(/@[^@]+$/, "")
}

function skipCommandWrappers(words, start = 0) {
  let index = start
  while (index < words.length) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || "")) index++

    const wrapper = wrapperName(words[index])
    if (wrapper === "env") {
      index++
      while (index < words.length) {
        const token = words[index]
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
          index++
          continue
        }
        if (token === "--") {
          index++
          break
        }
        if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(token)) {
          index += 2
          continue
        }
        if (token.startsWith("-")) {
          index++
          continue
        }
        break
      }
      continue
    }

    if (["command", "exec", "call"].includes(wrapper)) {
      index++
      while ((words[index] || "").startsWith("-")) index++
      continue
    }

    if (!["time", "sudo", "nice", "nohup", "stdbuf", "cross-env", "xvfb-run"].includes(wrapper)) break
    index++
    const valueOptions = wrapper === "sudo"
      ? new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-c", "--close-from"])
      : wrapper === "time"
        ? new Set(["-f", "--format", "-o", "--output"])
        : wrapper === "nice"
          ? new Set(["-n", "--adjustment"])
          : wrapper === "stdbuf"
            ? new Set(["-i", "--input", "-o", "--output", "-e", "--error"])
            : wrapper === "xvfb-run"
              ? new Set([
                  "-e", "--error-file", "-f", "--auth-file", "-n", "--server-num",
                  "-s", "--server-args", "-p", "--xauth-protocol"
                ])
            : new Set()
    if (wrapper === "cross-env") {
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || "")) index++
      if (words[index] === "--") index++
      continue
    }
    while ((words[index] || "").startsWith("-")) {
      const token = String(words[index])
      if (token === "--") {
        index++
        break
      }
      index += valueOptions.has(token.toLowerCase()) ? 2 : 1
    }
  }
  return index
}

function toolCliArgv(words, name) {
  const isToolExecutable = token => {
    const executable = executableName(token)
    return executable === name || executable.startsWith(name + "@") && executable.length > name.length + 1
  }
  let index = skipCommandWrappers(words)

  if (isToolExecutable(words[index])) return words.slice(index + 1)

  // Published CLI entrypoints have the same behavior as their package bins.
  // Match package paths, not arbitrary scripts containing the tool name.
  if (["node", "nodejs"].includes(executableName(words[index]))) {
    index++
    const nodeValueOptions = new Set([
      "-r", "--require", "--import", "--loader", "--conditions", "--inspect-port"
    ])
    while ((words[index] || "").startsWith("-")) {
      const option = String(words[index]).toLowerCase()
      if (option === "--") {
        index++
        break
      }
      index += nodeValueOptions.has(option) ? 2 : 1
    }
    const script = String(words[index] || "").replace(/\\/g, "/").toLowerCase()
    const entry = script.match(/(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(vite|vitest)\/(.+)$/)
    const entrypoints = name === "vite" ? ["bin/vite.js"] : ["vitest.mjs", "dist/cli.js"]
    if (entry?.[1] === name && entrypoints.includes(entry[2])) {
      return words.slice(index + 1)
    }
    return null
  }

  const launcher = executableName(words[index])
  if (!["npx", "pnpx", "bunx", "pnpm", "yarn", "npm", "bun"].includes(launcher)) return null
  index++
  if (["npm", "pnpm", "yarn", "bun"].includes(launcher) && executableName(words[index]) === "run") {
    index++
    if (!isToolExecutable(words[index])) return null
    index++
    if (words[index] === "--") index++
    return words.slice(index)
  }
  if (["exec", "dlx", "x"].includes(executableName(words[index]))) index++
  while ((words[index] || "").startsWith("-")) {
    const token = words[index]
    if (["-p", "--package", "-c", "--call", "--cache", "--userconfig"].includes(token)) index += 2
    else index++
  }
  if (isToolExecutable(words[index])) return words.slice(index + 1)

  // Package launchers can themselves launch cross-env/nice/stdbuf wrappers.
  // Re-enter only the wrapper consumer (not the launcher parser) to avoid an
  // accidental recursive loop on malformed argv.
  index = skipCommandWrappers(words, index)
  return isToolExecutable(words[index]) ? words.slice(index + 1) : null
}

// 这些 option 的下一个 argv 是值，不能把值恰好叫 run/list
// 时误当成一次性 subcommand。未知形态保守地按默认 watch 处理。
const VITEST_OPTIONS_WITH_VALUE = new Set([
  "--config", "-c", "--root", "-r", "--dir", "--project", "-p", "--workspace",
  "--pool", "--environment", "--reporter", "--outputfile", "--testnamepattern", "-t",
  "--maxworkers", "--minworkers", "--shard", "--inspect", "--inspectbrk",
  "--mode", "--exclude", "--setupfiles", "--inspecthost", "--attachmentsdir",
  "--coverage.include", "--coverage.exclude", "--api.host", "--api.port"
])

function firstVitestPositional(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index] || "")
    const lowered = arg.toLowerCase()
    // `--` 之后是测试文件 filter，不再是 CLI subcommand。
    if (arg === "--") return ""
    if (VITEST_OPTIONS_WITH_VALUE.has(lowered)) {
      index++
      continue
    }
    if (lowered.startsWith("-")) continue
    return lowered
  }
  return ""
}

function vitestInvocationIsLongRunning(args) {
  const lowered = args.map((arg) => String(arg).toLowerCase())
  const positional = firstVitestPositional(args)
  const informational = lowered.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))
  if (informational) return false

  const explicitWatch = positional === "watch" || positional === "dev" || lowered.some((arg) =>
    arg === "--watch" || arg === "--watch=true" || arg === "--run=false"
  )
  if (explicitWatch) return true

  const oneShot = ["run", "list", "init", "related"].includes(positional) || lowered.some((arg) =>
    arg === "--run" || arg === "--run=true" || arg === "--watch=false" ||
    arg === "--clearcache" || arg === "--listtags"
  )
  return !(informational || oneShot)
}

// Consume option values before interpreting subcommands or help/watch flags.
// A value named "build" is not a build invocation (e.g. vite --mode build).
const VITE_VALUE_OPTIONS = new Set([
  "-c", "--config", "--base", "-l", "--loglevel", "--configloader", "-f", "--filter",
  "-m", "--mode", "--port", "--target", "--outdir", "--assetsdir", "--assetsinlinelimit"
])
const VITE_OPTIONAL_VALUE_OPTIONS = new Set([
  "--host", "--open", "--profile", "-d", "--debug", "--ssr", "--sourcemap", "--minify", "--manifest", "--ssrmanifest"
])
function viteInvocationIsLongRunning(args) {
  let positional = "", watch = false, informational = false
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index]).toLowerCase()
    if (arg === "--") break
    if (VITE_VALUE_OPTIONS.has(arg)) { index++; continue }
    if (VITE_OPTIONAL_VALUE_OPTIONS.has(arg)) {
      if (args[index + 1] && !String(args[index + 1]).startsWith("-")) index++
      continue
    }
    if (["--help", "-h", "--version", "-v"].includes(arg)) informational = true
    else if (["--watch", "-w", "--watch=true"].includes(arg)) watch = true
    else if (["--no-watch", "--watch=false"].includes(arg)) watch = false
    else if (!arg.startsWith("-") && !positional) positional = arg
  }
  return !informational && (watch || !["build", "optimize"].includes(positional))
}

function isLongRunningTool(command, name, classify, shellSyntax = {}) {
  for (const segment of splitShellSegments(command, shellSyntax)) {
    const words = splitShellWords(segment)
    const args = toolCliArgv(words, name)
    if (args && classify(args)) return true

    // `sh -c 'vitest ...'` 是真实执行面，不能因外层 wrapper 而漏判。
    const shell = executableName(words[0])
    const commandIndex = ["sh", "bash", "dash", "zsh"].includes(shell)
      ? words.findIndex((word) => /^-[a-z]*c[a-z]*$/i.test(word) || word.toLowerCase() === "/c")
      : -1
    if (
      commandIndex >= 0 &&
      words[commandIndex + 1] &&
      isLongRunningTool(words[commandIndex + 1], name, classify, { hashComments: true })
    ) return true

    // cmd /c 把 /c 后全部 argv 当作命令行；与 POSIX sh -c 的「只有
    // 紧邻一个 argv 是 command string，其余是 $0/$1」不同。
    if (shell === "cmd") {
      const cmdCommandIndex = words.findIndex((word) => ["/c", "/k"].includes(word.toLowerCase()))
      if (
        cmdCommandIndex >= 0 &&
        words[cmdCommandIndex + 1] &&
        isLongRunningTool(words.slice(cmdCommandIndex + 1).join(" "), name, classify, { hashComments: false })
      ) return true
      // `/k` deliberately keeps cmd.exe open after the child exits.  It is
      // therefore long-running even when the nested Vitest form is one-shot.
      if (cmdCommandIndex >= 0 && words[cmdCommandIndex].toLowerCase() === "/k") return true
    }

    // PowerShell 的 -Command 可以是单个引号字符串，也可以是后续多个 argv。
    // 后者需要全部拼回内层命令，否则会丢掉 --run/--watch。
    if (["pwsh", "powershell"].includes(shell)) {
      const powershellCommandIndex = words.findIndex((word) =>
        ["-c", "-command", "-commandwithargs"].includes(word.toLowerCase())
      )
      if (
        powershellCommandIndex >= 0 &&
        words[powershellCommandIndex + 1] &&
        isLongRunningTool(words.slice(powershellCommandIndex + 1).join(" "), name, classify, { hashComments: true })
      ) return true
    }

    if (shell === "cross-env-shell") {
      let innerIndex = 1
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[innerIndex] || "")) innerIndex++
      if (words[innerIndex] && isLongRunningTool(words.slice(innerIndex).join(" "), name, classify, shellSyntax)) return true
    }
  }
  return false
}

export function isLongRunningCommand(command) {
  const cmd = String(command || "").trim()
  return isLongRunningTool(cmd, "vitest", vitestInvocationIsLongRunning)
    || isLongRunningTool(cmd, "vite", viteInvocationIsLongRunning)
    || LONG_RUNNING_PATTERNS.some((re) => re.test(cmd))
}

/**
 * 一条命令的实际执行。沙箱与非沙箱只在这里分叉：
 * - 无沙箱：保留宿主 shell 语义和 Windows UTF-8 包装。
 * - 有沙箱：命令文本作为 `sh -c` 的一个 argv 传给 bwrap，
 *   全程不拼字符串 —— 拼接方案下命令里的引号会被沙箱参数表二次解释。
 */
function spawnShell({ command, cwd, timeoutMs, env, signal, stopSignal = null, onOutput = null, sandbox = null, invocation = null }) {
  if (sandbox) {
    return runManagedProcess({ command: sandbox.command, args: sandbox.args, cwd, timeoutMs, env, signal, stopSignal, onOutput })
  }
  if (invocation) return runManagedProcess({ command: invocation.command, args: invocation.args, cwd, timeoutMs, env: invocation.env, signal, stopSignal, onOutput })
  return runManagedProcess({ command: wrapCmd(command), cwd, timeoutMs, env, signal, stopSignal, onOutput, shell: detectShellInfo() })
}

/**
 * 组装本次 bash 调用的沙箱形态。
 *
 * mode!=auto 时立刻返回，不探测、不 mkdir —— 默认档必须与 0.8.0 完全同路径。
 * 后端不可用时回落现状，但带一行可见说明（每进程一次）：模型必须知道自己
 * 没被隔离。包装成功后若 bwrap 自己起不来，错误在 runBash 里原样透出，
 * 这里**不**做二次回落。
 */
async function prepareBashSandbox(ctx = {}, command = "", argv = null) {
  const config = ctx?.config || ctx?.configState?.config || null
  const raw = readSandboxConfig(config)
  if (raw.mode !== "auto") return { spawn: null, notice: "", hint: "" }

  const status = await inspectSandboxStatus(config)
  if (!status.available) {
    return { spawn: null, notice: takeSandboxUnavailableNotice(status), hint: "" }
  }

  const workspaceDir = await realPathOrSelf(path.resolve(ctx?.cwd || runtimeCwd()))
  const tmpDir = await realPathOrSelf(os.tmpdir())
  const homeStateDir = userRootDir()
  // bwrap 的 --bind 源目录不存在就整条命令失败，而 ~/.kkcode 在全新安装里
  // 可能还没建过
  await mkdir(homeStateDir, { recursive: true }).catch(() => {})
  const extraWritableDirs = []
  for (const entry of raw.writableDirs) {
    const dir = resolveWritableDir(entry, { workspaceDir })
    // 配置里的陈旧条目不该让每一条命令都挂掉，所以不存在就跳过
    if (dir && await exists(dir)) extraWritableDirs.push(await realPathOrSelf(dir))
  }

  const spawnSpec = buildSandboxedCommand({
    backend: status.backend,
    command,
    argv,
    workspaceDir,
    tmpDir,
    homeStateDir: await realPathOrSelf(homeStateDir),
    extraWritableDirs,
    network: status.network
  })
  if (!spawnSpec) return { spawn: null, notice: "", hint: "" }
  return {
    spawn: spawnSpec,
    notice: "",
    hint: sandboxFailureHint({
      backend: status.backend,
      network: status.network,
      writableDirs: [workspaceDir, tmpDir, homeStateDir, ...extraWritableDirs]
    })
  }
}

async function realPathOrSelf(target) {
  return realpath(target).catch(() => target)
}

async function runBash(command, cwd, timeoutMs = BASH_TIMEOUT_MS, options = {}) {
  if (!options.background && isLongRunningCommand(command)) {
    return { ok: false, blocked: true, status: 'blocked',
      output: `[blocked] "${command}" looks like a long-running/dev-server command that would block execution. Please tell the user to run it manually in their terminal, or use run_in_background: true.`,
      metadata: { exitCode: null, timedOut: false, cancelled: false, captureIncomplete: false, started: false } }
  }
  const { env: extraEnv = null, maxChars = 30000, sandbox = null, sandboxHint = "", invocation = null } = options
  // A host-controlled read invocation's scrubbed environment is authoritative;
  // merging caller/ambient variables back would re-enable Git executables.
  const env = invocation?.env || (extraEnv ? { ...process.env, ...extraEnv } : process.env)
  const out = await spawnShell({ command, cwd, timeoutMs, env, sandbox, invocation, signal: options.signal, stopSignal: options.stopSignal, onOutput: options.onOutput })
  const { exitCode, exitSignal, timedOut, cancelled, captureIncomplete, terminationIncomplete, started } = out
  const ok = exitCode === 0 && !timedOut && !cancelled && !captureIncomplete && !terminationIncomplete && !out.errorCode
  const metadata = { exitCode, exitSignal, timedOut, cancelled, captureIncomplete, terminationIncomplete, started,
    cwd, ...(out.stopRequested ? {stopRequested: true} : {}),
    ...(invocation ? { executionAdapter: 'controlled-git-read' } : {}),
    ...(started && (timedOut || cancelled || captureIncomplete || terminationIncomplete || exitSignal) ? { outcomeUnknown: true } : {}) }
  const result = { ok, status: cancelled ? 'cancelled' : ok ? 'completed' : 'error', cancelled,
    code: cancelled ? 'cancelled' : timedOut ? 'process_timeout' : out.errorCode || (ok ? null : 'process_failed'), metadata }
  const captured = `${out.stdout || ""}${out.stderr || ""}`
  const raw = captured.trim() || out.errorMessage || "(empty output)"
  const status = cancelled ? '[cancelled]' : timedOut ? '[timed out]'
    : captureIncomplete ? `${Number.isInteger(exitCode) && exitCode !== 0 ? `[exit ${exitCode}]\n` : ''}[capture incomplete]` : exitCode === 0 ? ''
      : exitCode !== null ? `[exit ${exitCode}]` : `[process error${exitSignal ? `: ${exitSignal}` : ''}]`

  // 上限跟着模型上下文走（见 tool/output-budget.mjs），并且截断要说清怎么拿更多
  // —— 此前是硬编码 30000 且只说「超了」，模型无从判断该缩范围还是该分页。
  const limit = Math.max(4000, Number(maxChars) || 30000)
  const tail = `${out.errorCode === 'PROCESS_CHILDREN_RUNNING' ? `\n[process] ${out.errorMessage}` : ''}${sandboxHint && !ok ? `\n${sandboxHint}` : ''}`
  // Preserve the actual captured bytes before display trim/truncation. Keep the
  // existing bounded exec capture: hitting its cap is explicitly PARTIAL, not
  // an excuse to retry the command or claim an unlimited complete archive.
  if (captured.length > limit && options.artifactAccess) {
    // Stopping work must not erase its evidence. This archives only bytes that
    // have already drained, with the same scope checks and a PARTIAL marker.
    const archived = await archiveToolText({ output: captured, access: options.artifactAccess,
      callId: options.toolCallId, limit, complete: !captureIncomplete && !timedOut && !cancelled && !terminationIncomplete })
    return { ...result, output: `${status ? `${status}\n` : ''}${archived.output}${tail}`,
      metadata: { ...archived.metadata, ...metadata } }
  }
  const body = raw.length > limit
    ? `${raw.slice(0, limit)}\n\n${truncationNotice({
        shown: limit,
        total: raw.length,
        unit: "chars",
        hint: "Inspect existing files/logs for more output; do not replay a command with side effects merely to recover truncated output."
      })}`
    : raw
  // 沙箱里失败时补一句「哪些目录可写」：EROFS / Permission denied 在沙箱内是
  // 预期结果，不加这行的话模型会把它当成环境损坏，然后开始瞎修
  return { ...result, output: status ? `${status}\n${body}${tail}` : `${body}${tail}` }
}

function lockOptions(ctx = {}) {
  const mode = String(ctx?.config?.tool?.write_lock?.mode || "file_lock")
  const waitTimeoutMs = Math.max(0, Number(ctx?.config?.tool?.write_lock?.wait_timeout_ms || 120000))
  const owner = String(ctx?.taskId || ctx?.sessionId || ctx?.turnId || "kkcode")
  return { mode, waitTimeoutMs, owner }
}

function mutationMetadata({
  operation,
  filePath,
  originalContent = null,
  updatedContent = null,
  structuredPatch = [],
  addedLines = 0,
  removedLines = 0,
  stageId = null,
  taskId = null
}) {
  return {
    fileChanges: [{
      path: filePath,
      tool: operation,
      addedLines,
      removedLines,
      stageId,
      taskId
    }],
    mutation: {
      operation,
      filePath,
      originalContent,
      updatedContent,
      structuredPatch,
      addedLines,
      removedLines
    },
    observability: buildMutationObservability({
      fileChanges: [{
        path: filePath,
        tool: operation,
        addedLines,
        removedLines,
        stageId,
        taskId
      }],
      mutation: {
        operation,
        filePath,
        originalContent,
        updatedContent,
        structuredPatch,
        addedLines,
        removedLines
      }
    })
  }
}

async function loadDynamicTools(dirs) {
  const loaded = []
  for (const dir of dirs) {
    const absolute = await resolveManagedPluginPath(dir)
    if (!absolute) continue
    if (!(await exists(absolute))) continue
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (![".mjs", ".js"].includes(path.extname(entry.name).toLowerCase())) continue
      const file = path.join(absolute, entry.name)
      try {
        const mod = await import(pathToFileURL(file).href)
        const def = mod.default || mod.tool || mod
        if (!def || typeof def !== "object" || typeof def.name !== "string" || typeof def.execute !== "function") {
          continue
        }
        loaded.push({
          name: def.name,
          description: def.description || `dynamic tool from ${file}`,
          inputSchema: def.inputSchema || { type: "object", properties: {}, required: [] },
          execute: def.execute
        })
      } catch {
        // ignore invalid tool module
      }
    }
  }
  return loaded
}

function builtinTools(config) {
  const listTool = {
    name: "list",
    description: "List files and subdirectories in a directory. Returns entry names with type prefix (d=directory, f=file). Use this for quick directory overview; use `glob` for recursive pattern matching.",
    inputSchema: {
      type: "object",
      properties: { path: schema("string", "directory path") },
      required: []
    },
    async execute(args, ctx) {
      const target = await resolveWorkspacePath(ctx.cwd, args.path || ".", { mustExist: true })
      return listDir(target)
    }
  }

  const sysinfoTool = {
    name: "sysinfo",
    description: "Return structured, read-only system and runtime information for the current machine/workspace. Good for OS/runtime/workspace/cpu/memory/disk summaries without relying on raw shell output.",
    inputSchema: {
      type: "object",
      properties: {
        sections: {
          type: "array",
          description: "optional sections to return: os, runtime, workspace, cpu, memory, disk",
          items: { type: "string" }
        },
        path: schema("string", "optional workspace path for disk/workspace inspection (default: cwd)")
      },
      required: []
    },
    async execute(args, ctx) {
      const targetPath = await resolveWorkspacePath(ctx.cwd, String(args.path || "."), { mustExist: true })
      const requestedSections = Array.isArray(args.sections) && args.sections.length
        ? args.sections.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
        : ["os", "runtime", "workspace", "cpu", "memory", "disk"]
      const sectionSet = new Set(requestedSections)

      const result = {
        generatedAt: new Date().toISOString(),
        path: targetPath,
        sections: {}
      }

      if (sectionSet.has("os")) {
        result.sections.os = {
          platform: process.platform,
          arch: process.arch,
          hostname: os.hostname(),
          release: os.release(),
          version: typeof os.version === "function" ? os.version() : null
        }
      }

      if (sectionSet.has("runtime")) {
        result.sections.runtime = {
          nodeVersion: process.version,
          shell: detectShellInfo(),
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          uptimeHuman: `${Math.round(process.uptime())}s`
        }
      }

      if (sectionSet.has("workspace")) {
        const packageManagers = await detectPackageManagers(targetPath)
        result.sections.workspace = {
          cwd: targetPath,
          isGitRepo: await detectGitRepo(targetPath),
          packageManagers,
          hasPackageJson: await exists(path.join(targetPath, "package.json")),
          hasNodeModules: await exists(path.join(targetPath, "node_modules"))
        }
      }

      if (sectionSet.has("cpu")) {
        const cpus = os.cpus() || []
        result.sections.cpu = {
          cores: cpus.length,
          model: cpus[0]?.model || null,
          loadAverage: typeof os.loadavg === "function" ? os.loadavg() : []
        }
      }

      if (sectionSet.has("memory")) {
        const total = os.totalmem()
        const free = os.freemem()
        result.sections.memory = {
          totalBytes: total,
          freeBytes: free,
          usedBytes: Math.max(0, total - free),
          total: formatBytes(total),
          free: formatBytes(free),
          used: formatBytes(Math.max(0, total - free))
        }
      }

      if (sectionSet.has("disk")) {
        try {
          const disk = await statfs(targetPath)
          const blockSize = Number(disk.bsize || disk.frsize || 0)
          const totalBytes = Number(disk.blocks || 0) * blockSize
          const freeBytes = Number(disk.bavail || disk.bfree || 0) * blockSize
          result.sections.disk = {
            path: targetPath,
            totalBytes,
            freeBytes,
            usedBytes: Math.max(0, totalBytes - freeBytes),
            total: formatBytes(totalBytes),
            free: formatBytes(freeBytes),
            used: formatBytes(Math.max(0, totalBytes - freeBytes))
          }
        } catch (error) {
          result.sections.disk = {
            path: targetPath,
            error: error.message
          }
        }
      }

      const summaryParts = []
      if (result.sections.os) summaryParts.push(`${result.sections.os.platform}/${result.sections.os.arch}`)
      if (result.sections.runtime) summaryParts.push(`node ${result.sections.runtime.nodeVersion}`)
      if (result.sections.workspace) summaryParts.push(result.sections.workspace.isGitRepo ? "git repo" : "non-git cwd")
      if (result.sections.memory) summaryParts.push(`mem ${result.sections.memory.used}/${result.sections.memory.total}`)
      if (result.sections.disk?.total) summaryParts.push(`disk ${result.sections.disk.used}/${result.sections.disk.total}`)
      result.summary = summaryParts.join(" · ")

      return result
    }
  }

  // 扩展名与 MIME 表来自 image-util.mjs（本文件顶部 import）—— 这里曾经是
  // 第二份手写拷贝，与那份靠记忆保持同步，实际上已经漂移。

  function readNotebook(raw) {
    const notebook = JSON.parse(raw)
    if (!notebook.cells || !Array.isArray(notebook.cells)) return "Not a valid .ipynb file (missing cells array)"
    const lines = []
    notebook.cells.forEach((cell, i) => {
      const type = cell.cell_type || "unknown"
      lines.push(`--- Cell ${i} [${type}] ---`)
      const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "")
      lines.push(source)
      if (cell.outputs && cell.outputs.length > 0) {
        lines.push("[Output]:")
        for (const out of cell.outputs) {
          if (out.text) lines.push(Array.isArray(out.text) ? out.text.join("") : String(out.text))
          else if (out.data?.["text/plain"]) {
            const plain = out.data["text/plain"]
            lines.push(Array.isArray(plain) ? plain.join("") : String(plain))
          }
        }
      }
      lines.push("")
    })
    return lines.join("\n")
  }

  /**
   * 解出 PDF 里所有内容流的明文。
   *
   * 此前的实现直接对整个文件按 latin1 解码后正则抓括号内的字符串。那对
   * **几乎所有现代 PDF 都无效** —— 内容流默认用 FlateDecode 压缩，抓到的是
   * 压缩字节里偶然出现的括号，产出一堆乱码当正文。而 `pages` 参数虽然在
   * schema 里声明了，代码从头到尾没读过。
   *
   * 这里先按 `stream ... endstream` 切出流、对 FlateDecode 的用 zlib 解压，
   * 再从解压后的内容里抓文本操作符。不引依赖：inflate 在 node:zlib 里。
   */
  function pdfContentStreams(buffer) {
    const streams = []
    const marker = Buffer.from("stream")
    const endMarker = Buffer.from("endstream")
    let cursor = 0
    while (cursor < buffer.length) {
      const start = buffer.indexOf(marker, cursor)
      if (start === -1) break
      const end = buffer.indexOf(endMarker, start)
      if (end === -1) break

      // 流字典在 stream 关键字之前，看它有没有声明 FlateDecode
      const dictStart = Math.max(0, start - 400)
      const dict = buffer.slice(dictStart, start).toString("latin1")

      // stream 之后是 CRLF 或 LF
      let dataStart = start + marker.length
      if (buffer[dataStart] === 0x0d) dataStart++
      if (buffer[dataStart] === 0x0a) dataStart++
      const raw = buffer.slice(dataStart, end)

      if (/\/FlateDecode/.test(dict)) {
        try {
          streams.push(inflateSync(raw).toString("latin1"))
        } catch {
          // 损坏或用了这里不支持的过滤器（LZW/DCT 等）—— 跳过而不是塞乱码
        }
      } else if (!/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) {
        streams.push(raw.toString("latin1"))
      }
      cursor = end + endMarker.length
    }
    return streams
  }

  /** 从一个已解压的内容流里抽文本：只认 Tj / TJ / ' / " 这几个显示操作符。 */
  function textFromContentStream(content) {
    const out = []
    // (字符串) Tj  |  [(a) -2 (b)] TJ  |  (s) '  |  (s) "
    const showRegex = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g
    const opRegex = /(\[(?:[^\][]|\[[^\]]*\])*\]|\((?:\\.|[^\\()])*\))\s*(TJ|Tj|'|")/g
    let match
    while ((match = opRegex.exec(content)) !== null) {
      const operand = match[1]
      let piece = ""
      let literal
      showRegex.lastIndex = 0
      while ((literal = showRegex.exec(operand)) !== null) {
        piece += literal[0].startsWith("<")
          ? hexStringToText(literal[0])
          : decodePdfLiteral(literal[0].slice(1, -1))
      }
      if (piece.trim()) out.push(piece)
    }
    return out
  }

  function hexStringToText(token) {
    const hex = token.slice(1, -1).replace(/\s+/g, "")
    let text = ""
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const code = parseInt(hex.slice(i, i + 2), 16)
      if (code >= 32 || code === 10 || code === 9) text += String.fromCharCode(code)
    }
    return text
  }

  function decodePdfLiteral(body) {
    return body
      .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
      .replace(/\\b/g, "\b").replace(/\\f/g, "\f")
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\([()\\])/g, "$1")
  }

  /** `pages` 形如 "1-5" / "3" / "2-" —— 返回 1-based 的判定函数。 */
  function parsePageRange(spec) {
    const text = String(spec || "").trim()
    if (!text) return null
    const match = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(text)
    if (!match) return null
    const from = Number(match[1])
    const to = match[2] === undefined ? from : match[2] === "" ? Infinity : Number(match[2])
    if (!from || to < from) return null
    return (page) => page >= from && page <= to
  }

  function extractPdfText(buffer, pagesSpec = "") {
    const streams = pdfContentStreams(buffer)
    if (!streams.length) {
      return "(PDF contains no extractable text — it may be image-based, encrypted, or use an unsupported filter)"
    }

    // 内容流与页面不是严格一一对应（一页可以拆成多个流），但按流序号过滤是
    // 无外部依赖前提下最接近 `pages` 语义的做法。做不到精确时说清楚，
    // 而不是假装 pages 生效了 —— 声明了却不实现是这个参数原本的问题。
    const inRange = parsePageRange(pagesSpec)
    const selected = inRange ? streams.filter((_, index) => inRange(index + 1)) : streams
    if (inRange && !selected.length) {
      return `(no content streams in range ${pagesSpec}; the PDF has ${streams.length})`
    }

    const texts = selected.flatMap((content) => textFromContentStream(content))
    if (!texts.length) {
      return "(PDF content streams decoded, but contain no text-showing operators — likely scanned images)"
    }
    const body = texts.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim()
    const note = inRange
      ? `\n\n[pages ${pagesSpec}: ${selected.length} of ${streams.length} content stream(s); streams do not map 1:1 to pages]`
      : ""
    return body + note
  }

  const readTool = {
    name: "read",
    description: 'Read source text with line numbers, validated raster images, PDF text or notebook cells. SVG is source text by default; use view="image" for a safe rendered PNG preview. Use offset/limit for text ranges. Existing-file mutations require a recent source read; viewing pixels does not authorize overwriting source.',
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "file path"),
        offset: schema("number", "start line number (1-based, optional)"),
        limit: schema("number", "max lines to return (optional)"),
        encoding: schema("string", "file encoding (default: utf8)"),
        view: { type: 'string', enum: ['auto', 'text', 'image'], description: 'auto reads SVG as source; image explicitly renders a static SVG or decodes a raster preview; text reads source with line numbers' },
        pages: schema("string", "page range for PDF files, e.g. '1-5' (optional)")
      },
      required: ["path"]
    },
    async execute(args, ctx) {
      const target = await resolveWorkspacePath(ctx.cwd, args.path, { mustExist: true })
      const ext = path.extname(target).toLowerCase()

      // SVG remains editable source. A pixel preview is an explicit operation.
      if (args.view === 'image' || (IMAGE_EXTENSIONS.has(ext) && ext !== '.svg' && args.view !== 'text')) {
        const info = await stat(target)
        if (!info.isFile() || info.size > IMAGE_LIMITS.bytes) return { ok: false, code: 'invalid_image', output: 'Image preview requires a regular file no larger than 20 MiB' }
        try {
          const buffer = await readFile(target)
          const image = await normalizeImageBlock({ data: buffer.toString('base64'), mediaType: IMAGE_MIME_TYPES[ext] }, { allowSvg: args.view === 'image' })
          return { type: 'image', output: `Image file: ${args.path} (${buffer.length} bytes, ${image.mediaType}, ${image.width}×${image.height})${image.originalMediaType ? ' — rendered from static SVG; source remains unchanged' : ''}`, data: `data:${image.mediaType};base64,${image.data}` }
        } catch (error) { return { ok: false, code: 'invalid_image', output: error.message } }
      }

      // PDF files: extract text
      if (ext === ".pdf") {
        const buffer = await readFile(target)
        return extractPdfText(buffer, args.pages)
      }

      // Jupyter notebooks: parse cells
      if (ext === ".ipynb") {
        const raw = await readFile(target, "utf8")
        const fileStat = await stat(target)
        markFileRead(target, {
          content: raw,
          timestamp: fileStat.mtimeMs,
          isPartialView: false
        })
        return readNotebook(raw)
      }

      // Default: text file with line numbers
      const encoding = /** @type {BufferEncoding} */ (args.encoding || "utf8")
      const fileStat = await stat(target)

      // 大小预检：此前没有任何检查，一个 2GB 的文件会直接读进内存
      if (fileStat.size > READ_MAX_FILE_BYTES) {
        return `error: file is ${fileStat.size} bytes, over the ${READ_MAX_FILE_BYTES} byte read limit. `
          + "Use grep to search it, or read with offset/limit to take a slice."
      }

      const content = await readFile(target, encoding)

      // 二进制探测：此前没有，读 .so/.zip 会按 utf8 解成一屏 U+FFFD
      // 然后带着行号进上下文，白白吃掉输出预算
      if (looksBinary(content)) {
        return `error: ${args.path} looks like a binary file (${fileStat.size} bytes). `
          + "Reading it as text would fill the context with replacement characters."
      }

      const allLines = content.split("\n")
      const start = Math.max(0, (Number(args.offset) || 1) - 1)
      if (allLines.length > 0 && start >= allLines.length) {
        // 越界 offset 此前静默返回空串，状态还是 completed
        return `error: offset ${start + 1} is past the end of the file (${allLines.length} lines).`
      }
      const slice = allLines.slice(start, start + (Number(args.limit) || READ_DEFAULT_LINES))

      const numbered = []
      let bytesUsed = 0
      let cappedByBytes = false
      for (let i = 0; i < slice.length; i++) {
        const line = slice[i]
        const clipped = line.length > READ_MAX_LINE_CHARS
          ? line.slice(0, READ_MAX_LINE_CHARS) + truncationNotice({ shown: READ_MAX_LINE_CHARS, total: line.length, unit: "chars" })
          : line
        // 字节帽：行数与单行上限都拦不住 minified 或宽表文件。先到先停。
        if (bytesUsed + clipped.length > READ_MAX_BYTES) {
          cappedByBytes = true
          break
        }
        bytesUsed += clipped.length
        numbered.push(`${String(start + i + 1).padStart(6)}→${clipped}`)
      }

      const lastLine = start + numbered.length
      const isPartialView = start > 0 || lastLine < allLines.length

      markFileRead(target, {
        // 存模型实际看到的内容。此前存未截断原文，模型照着截断行去 edit
        // 必然 no match，而且无从判断原因。
        content: isPartialView ? slice.slice(0, numbered.length).join("\n") : content,
        timestamp: fileStat.mtimeMs,
        offset: isPartialView ? start + 1 : undefined,
        limit: isPartialView ? numbered.length : undefined,
        isPartialView
      })

      // 截断必须发声并说清怎么续读。此前完全静默 —— 读一个 3000 行的文件
      // 在第 2000 行戛然而止，模型以为自己读完了整个文件。
      const footer = cappedByBytes
        ? truncationNotice({
            shown: bytesUsed,
            total: content.length,
            unit: "chars",
            hint: `Output capped at ${READ_MAX_BYTES} bytes. Use read with offset=${lastLine + 1} to continue.`
          })
        : lastLine < allLines.length
          ? truncationNotice({
              shown: numbered.length,
              total: allLines.length,
              unit: "lines",
              hint: `Use read with offset=${lastLine + 1} to continue.`
            })
          : completeNotice({ total: allLines.length, unit: "lines" })

      return `${numbered.join("\n")}\n${footer}`
    }
  }

  const writeTool = {
    name: "write",
    description: "Create or overwrite a file atomically, creating parents as needed. Default to one complete write; append chunks only when the content cannot fit one call. Existing-file writes require a recent full source read. Prefer edit for small changes. Modes: overwrite, append, insert.",
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "file path"),
        content: schema("string", "file content to write"),
        mode: schema("string", "write mode: 'overwrite' (default), 'append' (add to end), 'insert' (insert at line number)"),
        insert_at_line: schema("number", "1-based line number for insert mode. Content is inserted BEFORE this line.")
      },
      required: ["path", "content"]
    },
    async execute(args, ctx) {
      const target = await resolveWorkspacePath(ctx.cwd, args.path)
      const content = String(args.content ?? "")
      const mode = String(args.mode || "overwrite")

      // Guard: detect empty/parse-error writes that would destroy existing content
      if (args.__parse_error) {
        return {
          output: `error: tool call arguments were corrupted (JSON parse failed). The write was NOT executed. This usually means the response was truncated — try using write with mode="append" to build the file incrementally.`,
          metadata: { blocked: true, reason: "parse_error" }
        }
      }
      if (!content && !args.content && mode === "overwrite") {
        return {
          output: `error: content is empty or missing. The write was NOT executed. If you intended to create an empty file, pass content as an empty string explicitly.`,
          metadata: { blocked: true, reason: "empty_content" }
        }
      }

      if (await exists(target)) {
        const validation = await validateExistingFileMutation({
          targetPath: target,
          displayPath: String(args.path || target),
          operation: "writing to it",
          requireFullRead: true
        })
        if (!validation.ok) {
          return {
            output: validation.message,
            metadata: { blocked: true, reason: validation.reason, fileChanges: [] }
          }
        }
      }

      let previous = ""
      const options = lockOptions(ctx)

      const runWrite = async () => {
        let missing = false
        try {
          previous = await readFile(target, "utf8")
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          missing = true
          previous = ""
        }

        if (mode === "append") {
          const separator = previous && !previous.endsWith("\n") ? "\n" : ""
          await atomicWriteFile(target, previous + separator + content, {expectedContent: missing ? null : previous})
        } else if (mode === "insert") {
          const lineNum = Math.max(1, Number(args.insert_at_line) || 1)
          const lines = previous ? previous.split("\n") : []
          const insertIdx = Math.min(lineNum - 1, lines.length)
          const newLines = content.split("\n")
          lines.splice(insertIdx, 0, ...newLines)
          await atomicWriteFile(target, lines.join("\n"), {expectedContent: missing ? null : previous})
        } else {
          // overwrite (default)
          await atomicWriteFile(target, content, {expectedContent: missing ? null : previous})
        }
      }

      if (options.mode === "file_lock") {
        await withFileLock({
          targetPath: target,
          owner: options.owner,
          waitTimeoutMs: options.waitTimeoutMs,
          run: runWrite
        })
      } else {
        await runWrite()
      }

      let finalContent
      try { finalContent = await readFile(target, "utf8") } catch { finalContent = content }
      await refreshFileReadStateFromDisk(target, { content: finalContent }).catch(() => {})
      const diff = diffLineCount(previous, finalContent)
      const modeLabel = mode === "append" ? "appended" : mode === "insert" ? "inserted" : "written"
      return {
        output: `${modeLabel}: ${target}`,
        metadata: mutationMetadata({
          operation: "write",
          filePath: String(args.path || target),
          originalContent: previous,
          updatedContent: finalContent,
          structuredPatch: buildStructuredPatch(previous, finalContent),
          addedLines: diff.added,
          removedLines: diff.removed,
          stageId: ctx.stageId || null,
          taskId: ctx.logicalTaskId || ctx.taskId || null
        })
      }
    }
  }

  /** @type {{name: string, description: string, inputSchema: Record<string, any>, execute: Function}} */
  const editTool = {
    name: "edit",
    description: "Edit files after reading them: exact before/after replacement, start_line/end_line/content range replacement, or atomic changes across files. Choose exactly one form. Existing patch/multiedit names remain compatible aliases.",
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "file path"),
        before: schema("string", "target snippet"),
        after: schema("string", "replacement snippet"),
        replace_all: schema("boolean", "replace all occurrences instead of requiring unique match (default: false)")
      },
      required: ["path", "before", "after"]
    },
    async execute(args, ctx) {
      if (Array.isArray(args.changes)) return multieditTool.execute(args, ctx)
      if (args.start_line !== undefined) return patchTool.execute(args, ctx)
      const target = await resolveWorkspacePath(ctx.cwd, args.path, { mustExist: true })
      let staleNotice = ""
      if (await exists(target)) {
        const validation = await validateExistingFileMutation({
          targetPath: target,
          displayPath: String(args.path || target),
          operation: "editing it",
          // 锚点：外部改动后若它仍精确且唯一匹配，落点没有歧义 —— 放行而不是
          // 让模型重读全文。replace_all 时锚点本就会命中多处，降级条件不成立，
          // 自然回到硬失败，这是对的。
          anchor: args.replace_all ? "" : String(args.before || "")
        })
        if (!validation.ok) {
          return {
            output: validation.message,
            metadata: { blocked: true, reason: validation.reason, fileChanges: [] }
          }
        }
        // 降级放行必须让模型知道文件变过 —— 否则它会以为自己手里的副本还是新的
        if (validation.notice) staleNotice = validation.notice
      }
      const options = lockOptions(ctx)
      const runEdit = async () =>
        args.replace_all
          ? replaceAllInFileTransactional(target, String(args.before), String(args.after))
          : replaceInFileTransactional(target, String(args.before), String(args.after))
      const result = options.mode === "file_lock"
        ? await withFileLock({
            targetPath: target,
            owner: options.owner,
            waitTimeoutMs: options.waitTimeoutMs,
            run: runEdit
          })
        : await runEdit()
      if (result?.ok === false) {
        return markToolNoMutation({
          ok: false,
          error: "edit_failed",
          output: result.output || "edit failed",
          metadata: { fileChanges: [] }
        })
      }
      const updatedContent = await readFile(target, "utf8").catch(() => null)
      await refreshFileReadStateFromDisk(target, { content: updatedContent ?? undefined }).catch(() => {})
      return {
        output: staleNotice ? `${staleNotice}\n${result.output}` : result.output,
        metadata: mutationMetadata({
          operation: "edit",
          filePath: String(args.path || target),
          originalContent: String(args.before),
          updatedContent: String(args.after),
          structuredPatch: buildStructuredPatch(String(args.before), String(args.after)),
          addedLines: Number(result.addedLines || 0),
          removedLines: Number(result.removedLines || 0),
          stageId: ctx.stageId || null,
          taskId: ctx.logicalTaskId || ctx.taskId || null
        })
      }
    }
  }

  const globTool = {
    name: "glob",
    description: "Find files by glob pattern recursively. Use this instead of `bash` with find/ls. Optionally specify a `path` to search within a specific directory. Returns up to 200 matching file paths.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: schema("string", "glob pattern, e.g. **/*.mjs, src/**/*.ts"),
        path: schema("string", "directory to search in (default: cwd)")
      },
      required: ["pattern"]
    },
    async execute(args, ctx) {
      return runGlob(String(args.pattern || ""), ctx.cwd, args.path || null)
    }
  }

  const grepTool = {
    name: "grep",
    description: "Search file contents by regex pattern. Use this instead of `bash` with grep/rg. Supports searching within a specific file or directory via `path`, output modes (content/files/count), multiline matching, context lines, and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: schema("string", "regex or string pattern"),
        path: schema("string", "file or directory to search in (default: cwd). Use this to search within a specific file."),
        output_mode: schema("string", "output mode: 'content' (lines with numbers), 'files' (file paths only, default), 'count' (match counts per file)"),
        type: schema("string", "file type filter, e.g. js, ts, py (optional)"),
        glob: schema("string", "glob filter, e.g. *.mjs, src/**/*.ts (optional)"),
        max_count: schema("number", "max matches per file (optional)"),
        context: schema("number", "lines of context around match, -C (optional)"),
        before_context: schema("number", "lines before each match, -B (optional)"),
        after_context: schema("number", "lines after each match, -A (optional)"),
        ignore_case: schema("boolean", "case insensitive search (optional)"),
        multiline: schema("boolean", "enable cross-line matching (optional)"),
        head_limit: schema("number", "limit output to first N lines/entries (optional)"),
        offset: schema("number", "skip first N lines/entries before head_limit (optional)")
      },
      required: ["pattern"]
    },
    async execute(args, ctx) {
      // camelCase keys (maxCount/ignoreCase) are legacy aliases: accepted silently
      // so saved sessions and older prompts keep working, but never advertised.
      return runGrep(String(args.pattern || ""), ctx.cwd, {
        path: args.path || null,
        outputMode: args.output_mode || "files",
        type: args.type || null,
        glob: args.glob || null,
        maxCount: args.max_count ?? args.maxCount ?? null,
        context: args.context || null,
        beforeContext: args.before_context || null,
        afterContext: args.after_context || null,
        ignoreCase: !!(args.ignore_case ?? args.ignoreCase),
        multiline: !!args.multiline,
        headLimit: args.head_limit || null,
        offset: args.offset || null
      })
    }
  }

  const bashTool = {
    name: "bash",
    description: "Run a shell command in cwd using /bin/sh on Unix or ComSpec/cmd on Windows. Use dedicated read/edit/search/file/HTTP tools when available. For a long build use yield_time_ms to return a managed task handle while it runs. For a temporary development server use lifetime: service with one foreground command and a finite timeout; inspect readiness/logs using task_output and request graceful shutdown with task_stop. Waiting does not extend the process deadline. A clean exit is required; forced termination or lost effects still require inspection. Never use unjoined shell &. Non-zero exits are reported as [exit N]; large output is archived for artifact_read/artifact_search, so do not add tail/grep pipelines to tests.",
    inputSchema: {
      type: "object",
      properties: {
        command: schema("string", "shell command; on POSIX do not append unjoined shell &. Use an owned test harness or a managed background command without shell &; explicit wait joins are allowed."),
        timeout: schema("number", "timeout in ms (default 120000, max 600000)"),
        lifetime: {type: 'string', enum: ['command', 'service'], description: 'command (default): finite job; service: managed temporary foreground server, default 600000ms, max 3600000ms. Stop it before final verification. Strict runs use bounded tests instead.'},
        yield_time_ms: schema('number', 'wait for a managed command before returning its task handle (0-30000ms). Does not kill or extend the process; poll with task_output.'),
        description: schema("string", "human-readable description of what this command does (optional)"),
        run_in_background: schema("boolean", "return a managed task handle; without yield_time_ms returns immediately. Uses the selected lifetime and finite timeout. No detached shell &."),
        cwd: schema("string", "working directory, relative to the workspace root (optional, default: workspace root)"),
        env: schema("object", "extra environment variables for this command only, e.g. {\"NODE_ENV\":\"test\"} (optional). Added on top of the inherited environment.")
      },
      required: ["command"]
    },
    async execute(args, ctx) {
      // Also protect the legacy direct-call API; governed calls already run
      // the identity-bound preflight before opening an operation record.
      assertBashLifecycle(args,{language:ctx.config?.language})
      const command = String(args.command || "")
      const lifetime = processLifetime(args, ctx.config)
      const {timeoutMs} = lifetime
      const processCommand = lifetime.service ? serviceCommand(command) : command

      // 执行策略检查。审批档必须传进去 —— exec-policy 与 PermissionEngine 是
      // 两套互不通话的权限词汇，不传的话 YOLO 档在这里等同于最严格档，
      // 而模式说明写的是「每个审批提示都跳过」。
      const policyCheck = checkBashAllowed(command, ctx.config, {
        approvalLevel: normalizePermissionLevel(ctx.config?.permission || {}),
        autoReviewed: ctx.autoReviewed === true
      })
      if (!policyCheck.allowed) {
        return {
          ok: false,
          blocked: true,
          error: "execution_policy_violation",
          message: policyCheck.reason,
          suggestion: "Use git_snapshot to create temporary snapshots, then manually commit when satisfied."
        }
      }

      // cwd 必须过 resolveWorkspacePath —— 否则 `cwd: "../.."` 就能把整个
      // 工作区边界抬走，后续所有相对路径判定都在错误的根下做。
      const runCwd = args.cwd
        ? await resolveWorkspacePath(ctx.cwd, String(args.cwd), { mustExist: true })
        : ctx.cwd
      const extraEnv = args.env && typeof args.env === "object" && !Array.isArray(args.env)
        ? Object.fromEntries(
            Object.entries(args.env)
              .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
              .map(([key, value]) => [key, String(value)])
          )
        : null
      const maxChars = Number(ctx.toolResultLimit) || 30000

      // 第三层防护：OS 级隔离。默认 off，此时下面两条执行路径与 0.8.0 完全相同。
      // 后台任务也包 —— 否则 run_in_background: true 就是一个绕过沙箱的开关。
      let invocation
      try { invocation = await safeGitReadInvocation(command, args, { cwd: runCwd, signal: ctx.signal, timeoutMs }) }
      catch (error) {
        const cancelled = ctx.signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
        return { ok: false, status: cancelled ? 'cancelled' : 'error', cancelled,
          code: cancelled ? 'cancelled' : 'controlled_git_preparation_failed', output: error.message,
          metadata: { started: false, exitCode: null, timedOut: false, cancelled, captureIncomplete: false } }
      }
      const sandbox = await prepareBashSandbox(ctx, processCommand, invocation ? [invocation.command, ...invocation.args] : null)

      if (lifetime.yielding) {
        // 这里**不**再拦长命令。前台那道拦截的提示语原文是「或者用
        // run_in_background: true」，而这里又把它堵回去 —— 文档承诺的唯一
        // 逃生口在代码里不存在，模型照提示改参数后拿到的还是 blocked。
        // 后台本来就是长命令该去的地方：它有独立超时，不阻塞对话。
        const task = await BackgroundManager.launch({
          description: args.description || command,
          payload: { workerType: 'bash', command, cwd: runCwd, parentSessionId: ctx.sessionId || null,
            turnId: ctx.turnId || null, toolCallId: ctx.toolCallId || null,
            workerTimeoutMs: timeoutMs, commandTimeoutMs: timeoutMs,
            lifetime: lifetime.lifetime,
            envProvided: Object.keys(extraEnv || {}).length > 0 },
          run: async ({ signal, stopSignal, log }) => {
            // Submission's operation ends with the launch acknowledgement.
            // The actual background process needs its OWN durable outcome, so
            // the owner can inspect/acknowledge a cancellation or lost effect.
            let operation
            let dispatchStarted = false
            let pendingOutput = '', skippedOutput = 0, flushing = Promise.resolve()
            const flush = () => {
              if (!pendingOutput) return flushing
              const text = (skippedOutput ? `[Live preview omitted ${skippedOutput} earlier characters; inspect the final output/archive receipt after settlement.]\n` : '') + pendingOutput
              pendingOutput = ''; skippedOutput = 0
              flushing = flushing.then(() => log(text))
              return flushing
            }
            const outputTimer = setInterval(() => { void flush().catch(() => {}) }, 500)
            try {
              operation = await beginToolOperation({sessionId: ctx.sessionId, turnId: ctx.turnId, tool: 'bash', args: {command, cwd: runCwd, background: true, env: extraEnv}})
              dispatchStarted = true
              const result = await runBash(processCommand, runCwd, timeoutMs, {
                background: true, env: extraEnv, maxChars, sandbox: sandbox.spawn, sandboxHint: sandbox.hint, invocation,
                artifactAccess: ctx.artifactAccess, toolCallId: ctx.toolCallId, signal,
                stopSignal: lifetime.service ? stopSignal : null,
                onOutput: text => { const combined = pendingOutput + text; skippedOutput += Math.max(0, combined.length - 32000); pendingOutput = combined.slice(-32000) }
              })
              // Progress-log storage is separate from the already observed
              // process outcome. Never turn a known exit into an unknown
              // operation merely because its live preview could not be saved.
              try { await flush() } catch {
                Object.assign(result.metadata, {liveLogIncomplete: true})
                result.output += '\n[Live progress log was not fully saved; inspect this final output and its archive receipt.]'
              }
              const uncertain = 'outcomeUnknown' in result.metadata && result.metadata.outcomeUnknown === true
              await operation?.finish(uncertain ? 'uncertain' : 'settled')
              return {...result, metadata: {...result.metadata, ...(operation ? {operationId: operation.id} : {})}}
            } catch (error) {
              // Even a storage/archive exception must retain the operation's
              // identity. A bare background error/string loses the only safe
              // owner-recovery path and cannot be promoted to an exit receipt.
              await operation?.finish('uncertain').catch(() => {})
              return {ok: false, status: 'error', error: error.message, output: error.message,
                metadata: {started: dispatchStarted, exitCode: null, timedOut: false, cancelled: signal.aborted,
                  captureIncomplete: dispatchStarted, ...(dispatchStarted ? {outcomeUnknown: true} : {}),
                  ...(operation ? {operationId: operation.id} : {})}}
            } finally { clearInterval(outputTimer) }
          },
          config: ctx.config,
          signal: ctx.signal
        })
        const observed = lifetime.waitMs > 0 ? await BackgroundManager.waitForTask(task.id, {timeoutMs: lifetime.waitMs, tickMs: 50}) : task
        const launched = `background task launched: ${task.id}\nLifetime: ${lifetime.lifetime}; command timeout: ${timeoutMs}ms; cwd: ${runCwd}. Waiting does not extend this deadline.\nStatus: ${observed?.status || task.status}. Use task_output with task_id and optional wait_ms/cursor for progress. ${lifetime.service ? 'Use task_stop for graceful shutdown; the service must close resources and exit normally. Forced stopping remains subject to inspection.' : 'A launch receipt is not a completed check.'}`
        return { ok: true, status: observed?.status || task.status, background_task_id: task.id,
          output: sandbox.notice ? `${sandbox.notice}\n${launched}` : launched,
          metadata: { backgroundTask: { id: task.id, kind: 'bash', phase: 'submitted', status: observed?.status || task.status,
            parentSessionId: ctx.sessionId || null, turnId: ctx.turnId || null, commandTimeoutMs: timeoutMs },
            process: {taskId: task.id, status: observed?.status || task.status, cwd: runCwd, lifetime: lifetime.lifetime, timeoutMs} } }
      }

      const output = await runBash(command, runCwd, timeoutMs, {
        env: extraEnv,
        maxChars,
        sandbox: sandbox.spawn,
        sandboxHint: sandbox.hint,
        invocation,
        artifactAccess: ctx.artifactAccess,
        toolCallId: ctx.toolCallId,
        signal: ctx.signal
      })
      if (typeof output === 'object') return { ...output, output: sandbox.notice ? `${sandbox.notice}\n${output.output}` : output.output }
      return sandbox.notice ? `${sandbox.notice}\n${output}` : output
    }
  }

  const outputTool = {
    name: "background_output",
    description: "Retrieve status, logs, and result of a background task owned by this session by task_id. Covers owned background `task`, `bash`, and longagent lanes. Alias of `task_output` — prefer `task_output` for new work.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: schema("string", "background task id")
      },
      required: ["task_id"]
    },
    async execute(args, ctx) {
      const task = await scopedBackgroundTask(String(args.task_id || ""), ctx)
      if (!task) return "background task not found"
      return {
        ...BackgroundManager.summarize(task),
        result: task.result,
        error: task.error || null
      }
    }
  }

  const taskListTool = {
    name: "task_list",
    description: "List background tasks owned by this session with concise lifecycle summaries.",
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute(args, ctx) {
      const tasks = await scopedBackgroundTasks(ctx)
      return tasks.map((task) => BackgroundManager.summarize(task))
    }
  }


  const taskParallelTool = {
    name: "task_parallel",
    description: "Show background tasks owned by this session grouped as parallel subagent lanes.",
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute(args, ctx) {
      const tasks = await scopedBackgroundTasks(ctx)
      return BackgroundManager.summarizeParallel(tasks)
    }
  }

  const taskGetTool = {
    name: "task_get",
    description: "Retrieve one background task owned by this session with its summary and result payload by task_id. Alias of `task_output` — prefer `task_output` for new work.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: schema("string", "background task id")
      },
      required: ["task_id"]
    },
    async execute(args, ctx) {
      const task = await scopedBackgroundTask(String(args.task_id || ""), ctx)
      if (!task) return "background task not found"
      return {
        ...BackgroundManager.summarize(task),
        result: task.result,
        error: task.error || null
      }
    }
  }

  const taskStopTool = {
    name: "task_stop",
    description: "Stop an owned task. Managed services receive a graceful stop request; inspect task_output until they exit. Other tasks are cancelled. Force cancels immediately and may require effect inspection. Stopping is not rollback or verification.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: schema("string", "background task id"),
        force: schema('boolean', 'force cancellation instead of requesting graceful service shutdown (default false)')
      },
      required: ["task_id"]
    },
    async execute(args, ctx) {
      const task = await scopedBackgroundTask(String(args.task_id || ''), ctx)
      if (!task) return 'background task not found'
      const graceful = args.force !== true && task.payload?.lifetime === 'service'
      const ok = await (graceful ? stopScopedBackgroundTask : cancelScopedBackgroundTask)(task.id, ctx)
      return ok ? graceful ? 'graceful stop requested; use task_output to verify the actual exit and retained effects' : 'cancel requested' : 'background task not found'
    }
  }

  const taskOutputTool = {
    name: "task_output",
    description: "Read an owned task's status, cwd, incremental logs, result and next action. wait_ms waits up to 30000ms without changing its deadline; pass the returned cursor on the next call to avoid repeating logs.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: schema("string", "background task id"),
        wait_ms: schema('number', 'wait up to 30000ms for completion; 0 returns immediately'),
        cursor: schema('number', 'log cursor from the previous task_output; default 0')
      },
      required: ["task_id"]
    },
    async execute(args, ctx) {
      let task = await scopedBackgroundTask(String(args.task_id || ""), ctx)
      if (!task) return "background task not found"
      const deadline = Date.now() + Math.min(30000, Math.max(0, Number(args.wait_ms) || 0))
      while (['pending', 'running'].includes(task.status) && Date.now() < deadline) {
        ctx.signal?.throwIfAborted()
        // A short bounded wait also lets user steering reach the next boundary.
        if (await ctx.hasPendingInput?.()) break
        await BackgroundManager.waitForAny([task.id], Math.min(100, deadline - Date.now()))
        task = await scopedBackgroundTask(task.id, ctx)
        if (!task) return 'background task not found'
      }
      return {
        ...BackgroundManager.summarize(task),
        logs: processLogWindow(task, args.cursor),
        result: task.result,
        error: task.error || null
      }
    }
  }

  const cancelTool = {
    name: "background_cancel",
    description: "Alias of task_stop for an owned background task. Managed services normally close cooperatively; force=true requests cancellation. Prefer task_stop for new work.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: schema("string", "background task id"),
        force: schema('boolean', 'force cancellation instead of cooperative service shutdown')
      },
      required: ["task_id"]
    },
    async execute(args, ctx) {
      return taskStopTool.execute(args, ctx)
    }
  }

  const todoReadTool = {
    name: 'todo_read',
    description: 'Read the authoritative durable task list for the current session, including stable item IDs, owners, dependencies and revision. This is authored progress, never a verification result. Reading does not alter the list or authorize project writes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, ctx) {
      const { isSessionTodoService } = await import('../session/todo-service.mjs')
      if (!isSessionTodoService(ctx.todoService) || ctx.todoService.sessionId !== ctx.sessionId) throw Object.assign(new Error('A host-bound session todo service is required'), { code: 'todo_scope' })
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw Object.assign(new Error('todo_read accepts no session selector or other parameters'), { code: 'todo_invalid' })
      return JSON.stringify(await ctx.todoService.list())
    }
  }

  const todowriteTool = {
    name: "todowrite",
    description: "Maintain the durable plan in every mode. Use mode: merge to update selected items while preserving other work; replace (legacy default) cancels omitted unfinished own items. Read todo_read to obtain existing IDs and revision; never invent IDs. Use reason when cancelling superseded work or explaining a blocker. Status is authored progress, not verification. Other agents' items are read-only.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "integer", minimum: 0, description: "Revision returned by the last todo update; stale writes are rejected" },
        mode: {type: 'string', enum: ['merge', 'replace'], description: 'Prefer merge for incremental changes. replace cancels omitted unfinished own items; default replace for compatibility.'},
        todos: {
          type: "array",
          maxItems: 100,
          description: "The updated list of this agent's items; do not remove completed history",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: schema("string", "Stable returned ID for existing items; omit only for a new item"),
              content: schema("string", "task description in imperative form (e.g. 'Run tests')"),
              activeForm: schema("string", "present continuous form shown during execution (e.g. 'Running tests')"),
              status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked", "cancelled"], description: "authored progress only, not observed verification" },
              reason: schema('string', 'why work is blocked, cancelled or replanned; max 512 characters'),
              dependencies: { type: "array", items: { type: "string" }, description: "Existing todo IDs in this session" },
              evidenceRefs: { type: "array", items: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: ["message", "part"] }, id: { type: "string" } }, required: ["kind", "id"] }, description: "Existing same-session message/part references, not file paths or verification claims" }
            },
            required: ["content", "status"]
          }
        }
      },
      required: ["todos"],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const { isSessionTodoService } = await import('../session/todo-service.mjs')
      if (!isSessionTodoService(ctx.todoService) || ctx.todoService.sessionId !== ctx.sessionId) throw Object.assign(new Error('A host-bound session todo service is required'), { code: 'todo_scope' })
      try {
        const snapshot = await ctx.todoService.update(args, { sessionId: ctx.sessionId, signal: ctx.signal })
        return JSON.stringify({ ...snapshot, note: 'Authored task progress only. Completed items are not proof that tests or acceptance passed.' })
      } catch (error) {
        if (!['todo_conflict', 'todo_scope'].includes(error.code)) throw error
        // Return current IDs/state for deliberate replanning, without advancing
        // the service baseline or pretending the stale write was accepted.
        const snapshot = await ctx.todoService.list()
        return { status: error.code === 'todo_conflict' ? 'blocked' : 'error', code: error.code, error: error.message,
          output: JSON.stringify({ updated: false, snapshot, message: 'Use the current returned IDs and explicit expectedRevision. Reconcile the intended changes with mode: merge; omit id only for a new item. No update was accepted.' }) }
      }
    }
  }

  const questionTool = {
    name: "question",
    description: "Ask the user one or more structured questions and wait for their answers. Use when you need user input to proceed — e.g. ambiguous requirements, implementation choices, or missing information. Supports predefined options, multi-select, and custom text input. Returns actual user answers.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "questions to ask the user",
          items: {
            type: "object",
            properties: {
              id: schema("string", "unique question identifier"),
              text: schema("string", "question text"),
              header: schema("string", "short label for tab chip (max 12 chars)"),
              description: schema("string", "supplementary description (optional)"),
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: schema("string", "option display text"),
                    value: schema("string", "option value (defaults to label)"),
                    description: schema("string", "option description (optional)")
                  },
                  required: ["label"]
                },
                description: "predefined choices (optional)"
              },
              multi: schema("boolean", "allow multiple selections (default false)"),
              allowCustom: schema("boolean", "allow custom text input (default true)")
            },
            required: ["id", "text"]
          }
        }
      },
      required: ["questions"]
    },
    async execute(args) {
      if (args && args._allowQuestion === false) {
        return "question tool disabled in this phase"
      }
      const questions = Array.isArray(args.questions) ? args.questions : []
      if (questions.length === 0) {
        return "error: at least one question is required"
      }
      // Normalize questions
      const normalized = questions.map((q, i) => ({
        id: String(q.id || `q${i}`),
        text: String(q.text || ""),
        description: q.description ? String(q.description) : "",
        options: Array.isArray(q.options) ? q.options.map((o) => ({
          label: String(o.label || ""),
          value: String(o.value || o.label || ""),
          description: o.description ? String(o.description) : ""
        })) : [],
        multi: !!q.multi,
        allowCustom: q.allowCustom !== false
      }))
      const answers = await askQuestionInteractive({ questions: normalized })
      // Format response
      const lines = normalized.map((q) => {
        const answer = answers[q.id] ?? "(skipped)"
        return `[${q.id}] ${q.text} → ${answer}`
      })
      return lines.join("\n")
    }
  }

  const webfetchTool = {
    name: "webfetch",
    description: "Read a public, unauthenticated HTTP(S) URL. Static HTML is converted to readable Markdown with source links; text/JSON/XML remain text. No JavaScript rendering or model summarization. Bounded network and decoded content; displayed text may be truncated. Use Browser for dynamic pages, read for local files, and http_request for APIs requiring headers.",
    inputSchema: {
      type: "object",
      properties: {
        url: schema("string", "URL to fetch"),
        prompt: schema("string", "deprecated; leave empty. Read the returned content, then perform extraction in the conversation. Nonempty values are rejected.")
      },
      required: ["url"]
    },
    async execute(args, ctx = {}) {
      const url = String(args.url || "")
      if (String(args.prompt || "").trim()) return "error: webfetch does not run a processing prompt. Omit prompt, read the returned page, then extract or summarize in the conversation."
      try {
        // 出网校验（SSRF）。此前只检查 URL 前缀，于是
        // `http://127.0.0.1:38412/admin` 的响应体会被原样读回来 —— 实测确认。
        // 逐跳校验重定向，否则只校验第一个 URL 等于没校验。
        const { response, url: finalUrl } = await guardedFetch(url, {
          headers: buildRequestHeaders({
            target: "webfetch",
            accept: "text/html, text/plain, application/json"
          }),
          signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
        }, { allowPrivate: allowPrivateHosts(ctx.config), assertTarget: target => assertWebDataPolicy(ctx.config || {}, target.href) })
        if (!response.ok) return `error: HTTP ${response.status}`
        const text = await readablePage(response, finalUrl.href)
        const limit = Math.max(4000, Number(ctx.toolResultLimit) || 50000)
        return text.length > limit
          ? `${text.slice(0, limit)}\n${truncationNotice({
              shown: limit,
              total: text.length,
              unit: "chars",
              hint: "Fetch a more specific URL or path to see the rest."
            })}`
          : text
      } catch (error) {
        return `error: ${error.message}`
      }
    }
  }

  const httpRequestTool = {
    name: "http_request",
    description: "Make an HTTP request with a chosen method, headers, and body. Use this for APIs (POST/PUT/PATCH/DELETE, JSON payloads, auth headers). For simply reading a public page as text, use `webfetch`. Private and loopback addresses and cloud metadata endpoints are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        url: schema("string", "target URL (http or https)"),
        method: schema("string", "HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD (default: GET)"),
        headers: schema("object", "request headers, e.g. {\"Content-Type\":\"application/json\"}"),
        body: schema("string", "request body as a string; JSON must be pre-serialized"),
        timeout_ms: schema("number", "timeout in milliseconds (default 30000, max 120000)")
      },
      required: ["url"]
    },
    async execute(args, ctx = {}) {
      const method = String(args.method || "GET").toUpperCase()
      const ALLOWED = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
      if (!ALLOWED.includes(method)) {
        return `error: unsupported method "${method}". Allowed: ${ALLOWED.join(", ")}`
      }
      if ((method === "GET" || method === "HEAD") && args.body) {
        return `error: ${method} cannot carry a body`
      }

      const headers = buildRequestHeaders({
        target: "http_request",
        accept: "application/json, text/plain, */*",
        customHeaders: args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)
          ? Object.fromEntries(
              Object.entries(args.headers)
                // 头名按 RFC 7230 token；带控制字符的名字能撑开请求走私
                .filter(([k]) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k))
                .map(([k, v]) => [k, String(v).replace(/[\r\n]/g, "")])
            )
          : {}
      })

      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 30000, 1000), 120_000)
      try {
        const { response, url: finalUrl, redirects } = await guardedFetch(String(args.url || ""), {
          method,
          headers,
          body: args.body === undefined ? undefined : String(args.body),
          signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        }, { allowPrivate: allowPrivateHosts(ctx.config), assertTarget: target => assertWebDataPolicy(ctx.config || {}, target.href) })

        const text = method === "HEAD" ? "" : await response.text()
        const limit = Math.max(4000, Number(ctx.toolResultLimit) || 50000)
        const shownBody = text.length > limit
          ? `${text.slice(0, limit)}\n${truncationNotice({
              shown: limit,
              total: text.length,
              unit: "chars",
              hint: "Narrow the request (query params, Range header, or a more specific endpoint)."
            })}`
          : text

        const lines = [`HTTP ${response.status} ${response.statusText}`.trim()]
        if (redirects > 0) lines.push(`(after ${redirects} redirect${redirects > 1 ? "s" : ""} → ${finalUrl.href})`)
        const contentType = response.headers.get("content-type")
        if (contentType) lines.push(`content-type: ${contentType}`)
        if (shownBody) lines.push("", shownBody)
        return lines.join("\n")
      } catch (error) {
        return `error: ${error.message}`
      }
    }
  }

  const skillTool = {
    name: "skill",
    description: "Invoke a registered skill by name. Skills are pre-built prompt templates or programmable modules that provide specialized capabilities. Use this when a task matches an available skill listed in the system prompt, or when the user mentions a skill command like '$commit'.",
    /**
     * 技能的风险取决于它是哪一种，一个工具名对应不了一个固定档位：
     *
     *   - `template` / `skill_md`：把模板展开成一段提示词，对系统零副作用。
     *     等价于用户自己把那段话打出来 —— 展开之后模型要做什么，每一步仍然
     *     各自过权限。归 `prompt`（与只读同档）。
     *   - `mjs`：调用 skill.run()，**执行任意 JS**。归 `task`，需要审批。
     *
     * 此前一律归 `task`，后果是技能在非交互环境里彻底不可用：`ask` 会落到
     * permission.non_tty_default（默认 deny），于是模型能在系统提示里读到
     * 完整的技能清单，却一个也调不动。
     */
    capabilityFor(args) {
      const name = String(args?.skill || "").trim()
      if (!name || !SkillRegistry.isReady()) return "task"
      const skill = SkillRegistry.get(name)
      if (!skill) return "task"
      return skill.type === "mjs" ? "task" : "prompt"
    },
    inputSchema: {
      type: "object",
      properties: {
        skill: schema("string", "skill name without '/' prefix (e.g. 'commit', 'init', 'frontend')"),
        args: schema("string", "optional arguments to pass to the skill (e.g. 'vue' for $init vue)")
      },
      required: ["skill"]
    },
    async execute(args, ctx) {
      const name = String(args.skill || "").trim()
      if (!name) return "error: skill name is required"
      if (!SkillRegistry.isReady()) return "error: skill registry not initialized"
      const skill = SkillRegistry.get(name)
      if (!skill) {
        const available = SkillRegistry.list().map(s => s.name).join(", ")
        return `error: skill "${name}" not found. Available: ${available}`
      }
      // disable-model-invocation hides the skill from the system prompt listing;
      // without this check the model could still invoke it by guessing the name
      // (Kimi Code rejects these at the same boundary).
      if (skill.disableModelInvocation) {
        return `error: skill "${name}" is not model-invocable (disable-model-invocation). It can only be run by the user as $${name}.`
      }
      const result = await SkillRegistry.execute(name, String(args.args || ""), {
        invocation: 'model',
        cwd: ctx.cwd,
        mode: ctx.mode || "agent",
        model: ctx.model || "",
        provider: ctx.provider || "",
        config: ctx.config || null
      })
      if (!result) return `skill /${name} returned no output`
      ctx.restrictSkillTools?.(skill.allowedTools)
      // contextFork skills return { prompt, contextFork, model }
      if (typeof result === "object" && result.contextFork) {
        return result.prompt || ""
      }
      return result
    }
  }

  const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
  const EXA_TIMEOUT_MS = 25000

  async function callExaMcp(toolName, args, signal, config = {}) {
    assertWebDataPolicy(config, EXA_MCP_URL)
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    })
    const response = await fetch(EXA_MCP_URL, {
      redirect: 'error',
      method: "POST",
      headers: buildRequestHeaders({
        target: "exa",
        accept: "application/json, text/event-stream",
        contentType: "application/json"
      }),
      body,
      signal: signal || AbortSignal.timeout(EXA_TIMEOUT_MS)
    })
    if (!response.ok) {
      const err = await response.text().catch(() => "")
      throw new Error(`Exa search error (${response.status}): ${err}`)
    }
    const text = await response.text()
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6))
        if (data.result?.content?.[0]?.text) return data.result.content[0].text
      }
    }
    return null
  }

  const websearchTool = {
    name: "websearch",
    description: "Search the web for up-to-date information. Use this PROACTIVELY when you are unsure about facts, APIs, library versions, error messages, or anything beyond your training data. Reduces hallucination by grounding answers in real search results. Returns relevant web page content.",
    inputSchema: {
      type: "object",
      properties: {
        query: schema("string", "search query"),
        numResults: schema("number", "number of results to return (default: 5)"),
        type: schema("string", "search type: 'auto' (default), 'fast' (quick), 'deep' (comprehensive)")
      },
      required: ["query"]
    },
    async execute(args, ctx) {
      const query = String(args.query || "").trim()
      if (!query) return "error: query is required"
      try {
        const result = await callExaMcp("web_search_exa", {
          query,
          numResults: Number(args.numResults) || 5,
          type: args.type || "auto",
          livecrawl: "fallback"
        }, ctx.signal, ctx.config)
        return result || "No results found. Try a different query."
      } catch (error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") return "error: search request timed out"
        return `error: ${error.message}`
      }
    }
  }

  const codesearchTool = {
    name: "codesearch",
    description: "Search for code examples, API documentation, and SDK usage. Use this PROACTIVELY when working with unfamiliar libraries, frameworks, or APIs. Returns relevant code snippets and documentation from the web. Especially useful for: correct API signatures, configuration examples, migration guides, and best practices.",
    inputSchema: {
      type: "object",
      properties: {
        query: schema("string", "search query for APIs, libraries, SDKs (e.g. 'Express.js middleware', 'React useState hook')"),
        tokensNum: schema("number", "amount of context to return, 1000-50000 (default: 5000)")
      },
      required: ["query"]
    },
    async execute(args, ctx) {
      const query = String(args.query || "").trim()
      if (!query) return "error: query is required"
      try {
        const result = await callExaMcp("get_code_context_exa", {
          query,
          tokensNum: Math.min(Math.max(Number(args.tokensNum) || 5000, 1000), 50000)
        }, ctx.signal, ctx.config)
        return result || "No code context found. Try a more specific query."
      } catch (error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") return "error: code search request timed out"
        return `error: ${error.message}`
      }
    }
  }

  const multieditTool = {
    name: "multiedit",
    description: "Validate multiple file edits, then apply a batch. On failure, restore only matching committed bytes; preserve concurrent changes and explicitly report incomplete recovery. New batch files move to private recoverable storage, not permanent deletion. This is not a filesystem-wide atomic commit. Each existing file must have been read first.",
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          description: "list of file changes to apply atomically",
          items: {
            type: "object",
            properties: {
              path: schema("string", "file path"),
              before: schema("string", "text to find (required for edits, omit for new file creation)"),
              after: schema("string", "replacement text (for edits) or full content (for new files)"),
              replace_all: schema("boolean", "replace all occurrences of before (default: false)")
            },
            required: ["path", "after"]
          }
        }
      },
      required: ["changes"]
    },
    async execute(args, ctx) {
      const changes = Array.isArray(args.changes) ? args.changes : []
      if (!changes.length) return "error: at least one change is required"

      // Phase 1: validate all changes and collect original content for rollback
      const snapshots = [] // { path, original, isNew }
      const resolved = []
      const staleNotices = []
      for (const change of changes) {
        const target = await resolveWorkspacePath(ctx.cwd, change.path)
        // Also protect direct host-library callers: every target must be safe
        // before Phase 2 can publish any member of this batch.
        await assertAtomicWriteTarget(target)
        const originalExists = await exists(target)
        const hasBefore = Object.prototype.hasOwnProperty.call(change, "before")
        const isCreate = !originalExists && !hasBefore
        if (originalExists && !hasBefore) {
          return `error: "${change.path}" already exists. Provide a "before" snippet for existing-file multiedit changes.`
        }
        let original = null
        try {
          original = await readFile(target, "utf8")
        } catch { /* new file */ }

        if (!isCreate && original === null) {
          return `error: "${change.path}" does not exist. Omit "before" only for new-file creation.`
        }

        if (!isCreate && original !== null) {
          const validation = await validateExistingFileMutation({
            targetPath: target,
            displayPath: String(change.path || target),
            operation: "applying this multiedit change",
            anchor: change.replace_all ? "" : String(change.before || "")
          })
          if (!validation.ok) return validation.message
          if (validation.notice) staleNotices.push(validation.notice)
          const matches = (original || "").split(change.before).length - 1
          if (matches === 0) return `error: no match for "before" in ${change.path}. Re-read the file and check your snippet.`
          if (matches > 1 && !change.replace_all) return `error: ${matches} matches in ${change.path} — set replace_all: true or provide more context.`
        }

        snapshots.push({ path: target, original, isNew: original === null })
        resolved.push({ target, ...change, isCreate })
      }

      // Phase 2: apply all changes
      const applied = []
      const workingCopy = new Map()
      // Resolve interactions within a batch in memory, before publishing even
      // its first member. A second edit that removes its own later anchor is
      // a validation failure, not a reason to create and undo real effects.
      for (const change of resolved) {
        const content = workingCopy.has(change.target) ? workingCopy.get(change.target) : snapshots.find(s => s.path === change.target)?.original
        if (change.isCreate) workingCopy.set(change.target, String(change.after))
        else {
          if (typeof content !== 'string' || !content.includes(change.before)) {
            return `error: change ${resolved.indexOf(change) + 1} for ${change.path} no longer matches after an earlier change in this batch. No file writes were performed; split the changes or use a surviving snippet.`
          }
          workingCopy.set(change.target, change.replace_all ? content.replaceAll(change.before, change.after) : content.replace(change.before, change.after))
        }
      }
      try {
        // 同一文件的多个 change 必须逐个叠加。此前每个 change 都从
        // `snap.original`（批次前的原始内容）算起，于是同一文件出现两次时
        // 第二个 change 会覆盖掉第一个 —— 静默丢改动，没有任何报错。
        for (const [target, content] of workingCopy) {
          ctx.signal?.throwIfAborted()
          const snap = snapshots.find(s => s.path === target)
          await atomicWriteFile(target, content, {expectedContent: snap?.original ?? null})
          applied.push(target)
          await refreshFileReadStateFromDisk(target).catch(() => {})
        }
      } catch (error) {
        // A rollback must not overwrite concurrent owner changes or falsely
        // claim best-effort cleanup succeeded. Never unlink created contents.
        const cancelled = ctx.signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR'
        const restored = [], recoveryFiles = [], failures = cancelled ? [{path: '(batch)', code: 'cancelled', message: 'Batch stopped; already-applied files were preserved, not rolled back.'}] : []
        for (const target of cancelled ? [] : [...new Set(applied)].reverse()) {
          const snap = snapshots.find(s => s.path === target)
          if (!snap) continue
          try {
            if (snap.isNew) {
              recoveryFiles.push({path: target, recoveryPath: await recoverCreatedAtomicFile(target, workingCopy.get(target))})
            } else if (snap.original !== null) {
              await atomicWriteFile(target, snap.original, {expectedContent: workingCopy.get(target)})
            }
            restored.push(target)
            await refreshFileReadStateFromDisk(target).catch(() => {})
          } catch (rollbackError) {
            failures.push({path: target, code: rollbackError.code || 'rollback_failed', message: String(rollbackError.message).slice(0, 400), ...(rollbackError.recoveryPath ? {recoveryPath: rollbackError.recoveryPath} : {})})
          }
        }
        const complete = failures.length === 0
        return {ok: false, status: cancelled ? 'cancelled' : 'error', cancelled, code: cancelled ? 'cancelled' : complete ? 'multiedit_failed' : 'multiedit_recovery_incomplete',
          output: `error: failed at ${applied.length + 1}/${resolved.length} — ${complete ? 'all changes rolled back' : 'rollback incomplete; current files preserved, owner inspection required'}. Cause: ${error.message}` +
            (recoveryFiles.length ? '\nRecoverable created files:\n' + recoveryFiles.map(item => item.recoveryPath).join('\n') : '') +
            (failures.length ? '\nUnresolved recovery:\n' + failures.map(item => `${item.path}: ${item.message}${item.recoveryPath ? ' — preserved at ' + item.recoveryPath : ''}`).join('\n') : ''),
          metadata: {rollback: {complete, restored, recoveryFiles, failures}, ...(complete ? {} : {outcomeUnknown: true}),
            fileChanges: [...new Set(applied)].map(target => ({path: target, tool: 'multiedit'}))}}
      }

      // Phase 3: summarize
      const unique = [...workingCopy.keys()].map(target => resolved.find(change => change.target === target))
      const summary = unique.map(c => `  ${c.isCreate ? "+" : "~"} ${c.path}`).join("\n")
      return {
        output: [
          ...staleNotices,
          `${unique.length} file(s) updated in one checked batch:\n${summary}`
        ].join("\n"),
        metadata: {
          fileChanges: unique.map(c => ({
            path: String(c.path || c.target),
            tool: "multiedit",
            stageId: ctx.stageId || null,
            taskId: ctx.logicalTaskId || ctx.taskId || null
          })),
          mutations: unique.map((c) => {
            const snap = snapshots.find((s) => s.path === c.target)
            const originalContent = snap?.original ?? null
            const updatedContent = workingCopy.get(c.target)
            const diff = diffLineCount(originalContent ?? "", updatedContent)
            return {
              operation: "multiedit",
              filePath: String(c.path || c.target),
              originalContent,
              updatedContent,
              structuredPatch: buildStructuredPatch(originalContent ?? "", updatedContent),
              addedLines: diff.added,
              removedLines: diff.removed
            }
          })
        }
      }
    }
  }

  const enterPlanTool = {
    name: "enter_plan",
    description: "Enter planning mode. Use this PROACTIVELY when the task is non-trivial and requires architectural decisions, multi-file changes, or when multiple valid approaches exist. After calling this, outline your plan, then call `exit_plan` to present it to the user for approval.",
    inputSchema: {
      type: "object",
      properties: {
        reason: schema("string", "why planning is needed (shown to user)")
      },
      required: []
    },
    async execute(args, ctx) {
      ctx._planMode = true
      return `Planning mode entered. Outline your plan now, then call exit_plan to present it for user approval.${args.reason ? ` Reason: ${args.reason}` : ""}`
    }
  }

  const exitPlanTool = {
    name: "exit_plan",
    description: "Present your plan to the user for approval. The user will see the plan and can approve, reject, or request changes. Only call this after enter_plan and after you have outlined a complete plan in your response.",
    inputSchema: {
      type: "object",
      properties: {
        plan: schema("string", "the complete plan text to present to the user"),
        files: {
          type: "array", items: { type: "string" },
          description: "list of files that will be created or modified"
        }
      },
      required: ["plan"]
    },
    async execute(args, ctx) {
      if (!ctx._planMode) {
        return {
          output: "Cannot exit plan mode — you are not currently in plan mode. Call enter_plan first.",
          metadata: {}
        }
      }
      ctx._planMode = false
      const plan = String(args.plan || "")
      const files = Array.isArray(args.files) ? args.files : []
      const planPath = await savePlanFile(ctx.cwd, plan, files)
      return {
        output: `Plan saved to ${planPath} and submitted for next-step selection.`,
        metadata: {
          planApproval: true,
          plan,
          files,
          planPath
        }
      }
    }
  }

  const notebookeditTool = {
    name: "notebookedit",
    description: "Edit a Jupyter notebook (.ipynb) cell. Supports replace, insert, and delete operations on individual cells. Use this instead of `write` when modifying notebooks — it preserves cell metadata and outputs. Notebooks must be read first and stale notebooks are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "notebook file path (.ipynb)"),
        cell_number: schema("number", "0-indexed cell number to operate on (default: 0)"),
        new_source: schema("string", "new cell source content"),
        cell_type: { type: "string", enum: ["code", "markdown"], description: "cell type (required for insert)" },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "operation type (default: replace)" }
      },
      required: ["path", "new_source"]
    },
    async execute(args, ctx) {
      const target = await resolveWorkspacePath(ctx.cwd, args.path, { mustExist: true })
      if (await exists(target)) {
        const validation = await validateExistingFileMutation({
          targetPath: target,
          displayPath: String(args.path || target),
          operation: "editing the notebook",
          requireFullRead: true
        })
        if (!validation.ok) {
          return {
            output: validation.message,
            metadata: { blocked: true, reason: validation.reason, fileChanges: [] }
          }
        }
      }
      const raw = await readFile(target, "utf8")
      const notebook = JSON.parse(raw)
      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        return "error: not a valid .ipynb file (missing cells array)"
      }
      const mode = args.edit_mode || "replace"
      const cellNum = Number(args.cell_number ?? 0)
      const source = String(args.new_source ?? "")
      const sourceLines = source.split("\n").map((line, i, arr) => i < arr.length - 1 ? line + "\n" : line)

      if (mode === "insert") {
        const cellType = args.cell_type
        if (!cellType || !["code", "markdown"].includes(cellType)) {
          return "error: cell_type is required for insert mode (must be 'code' or 'markdown')"
        }
        const newCell = {
          cell_type: cellType,
          metadata: {},
          source: sourceLines
        }
        if (cellType === "code") {
          newCell.execution_count = null
          newCell.outputs = []
        }
        const insertAt = cellNum < 0 ? 0 : Math.min(cellNum + 1, notebook.cells.length)
        notebook.cells.splice(insertAt, 0, newCell)
      } else if (mode === "delete") {
        if (cellNum < 0 || cellNum >= notebook.cells.length) {
          return `error: cell_number ${cellNum} out of range (0-${notebook.cells.length - 1})`
        }
        notebook.cells.splice(cellNum, 1)
      } else {
        // replace
        if (cellNum < 0 || cellNum >= notebook.cells.length) {
          return `error: cell_number ${cellNum} out of range (0-${notebook.cells.length - 1})`
        }
        const cell = notebook.cells[cellNum]
        cell.source = sourceLines
        if (args.cell_type && args.cell_type !== cell.cell_type) {
          cell.cell_type = args.cell_type
          if (args.cell_type === "markdown") {
            delete cell.execution_count
            delete cell.outputs
          } else if (args.cell_type === "code") {
            cell.execution_count = null
            cell.outputs = []
          }
        }
      }

      const finalNotebook = JSON.stringify(notebook, null, 1) + "\n"
      await atomicWriteFile(target, finalNotebook, {expectedContent: raw})
      await refreshFileReadStateFromDisk(target, { content: finalNotebook }).catch(() => {})
      const actionLabel = mode === "insert" ? "inserted" : mode === "delete" ? "deleted" : "replaced"
      return {
        output: `${actionLabel} cell ${cellNum} in ${args.path} (${notebook.cells.length} cells total)`,
        metadata: mutationMetadata({
          operation: "notebookedit",
          filePath: String(args.path || target),
          originalContent: raw,
          updatedContent: finalNotebook,
          structuredPatch: buildStructuredPatch(raw, finalNotebook),
          addedLines: 0,
          removedLines: 0,
          stageId: ctx.stageId || null,
          taskId: ctx.logicalTaskId || ctx.taskId || null
        })
      }
    }
  }

  const patchTool = {
    name: "patch",
    description: "Replace a range of lines in a file by line numbers. Read the file first with `read` (use offset/limit for large files) to see line numbers, then specify the line range to replace. Lines are 1-based and inclusive. Ideal for modifying specific sections of large files without needing to match exact text.",
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "file path"),
        start_line: schema("number", "first line to replace (1-based, inclusive)"),
        end_line: schema("number", "last line to replace (1-based, inclusive)"),
        content: schema("string", "replacement content (replaces the line range). Empty string deletes lines.")
      },
      required: ["path", "start_line", "end_line", "content"]
    },
    async execute(args, ctx) {
      const target = await resolveWorkspacePath(ctx.cwd, args.path, { mustExist: true })

      if (await exists(target)) {
        const validation = await validateExistingFileMutation({
          targetPath: target,
          displayPath: String(args.path || target),
          operation: "patching it"
        })
        if (!validation.ok) {
          return {
            output: validation.message,
            metadata: { blocked: true, reason: validation.reason, fileChanges: [] }
          }
        }
      }

      const startLine = Math.max(1, Number(args.start_line) || 1)
      const endLine = Math.max(startLine, Number(args.end_line) || startLine)
      const content = String(args.content ?? "")

      const options = lockOptions(ctx)
      let result
      const runPatch = async () => {
        const existing = await readFile(target, "utf8")
        const lines = existing.split("\n")
        if (startLine > lines.length) {
          throw new Error(`start_line ${startLine} exceeds file length (${lines.length} lines)`)
        }
        const startIdx = startLine - 1
        const endIdx = Math.min(endLine, lines.length)
        const newLines = content === "" ? [] : content.split("\n")
        lines.splice(startIdx, endIdx - startIdx, ...newLines)
        const final = lines.join("\n")
        await atomicWriteFile(target, final, {expectedContent: existing})
        return { removedCount: endIdx - startIdx, insertedCount: newLines.length, previous: existing, final }
      }

      if (options.mode === "file_lock") {
        result = await withFileLock({ targetPath: target, owner: options.owner, waitTimeoutMs: options.waitTimeoutMs, run: runPatch })
      } else {
        result = await runPatch()
      }

      await refreshFileReadStateFromDisk(target, { content: result.final }).catch(() => {})
      return {
        output: `patched ${args.path}: replaced lines ${startLine}-${endLine} (removed ${result.removedCount}, inserted ${result.insertedCount})`,
        metadata: mutationMetadata({
          operation: "patch",
          filePath: String(args.path || target),
          originalContent: result.previous,
          updatedContent: result.final,
          structuredPatch: buildStructuredPatch(result.previous, result.final, { oldStart: startLine, newStart: startLine }),
          addedLines: result.insertedCount,
          removedLines: result.removedCount,
          stageId: ctx.stageId || null,
          taskId: ctx.logicalTaskId || ctx.taskId || null
        })
      }
    }
  }

  const gitTools = config?.git_auto?.enabled !== false ? gitAutoTools : []
  // One advertised edit lane, backed by the same mature transactional paths.
  // Direct legacy tool names and their exact schemas remain in the registry.
  editTool.inputSchema = {
    type: 'object',
    properties: { ...editTool.inputSchema.properties, ...patchTool.inputSchema.properties, changes: multieditTool.inputSchema.properties.changes },
    oneOf: [
      { required: ['path', 'before', 'after'], not: { anyOf: [{ required: ['start_line'] }, { required: ['changes'] }] } },
      { required: ['path', 'start_line', 'end_line', 'content'], not: { anyOf: [{ required: ['before'] }, { required: ['changes'] }] } },
      { required: ['changes'], not: { anyOf: [{ required: ['path'] }, { required: ['before'] }, { required: ['start_line'] }] } }
    ]
  }
  const gitFullAutoToolsList = config?.git_auto?.full_auto === true ? gitFullAutoTools : []
  
  return [listTool, sysinfoTool, readTool, writeTool, editTool, patchTool, multieditTool, globTool, grepTool, bashTool, createTaskTool(), createTaskGroupTool(), ...createChildControlTools(), outputTool, cancelTool, taskListTool, taskParallelTool, taskGetTool, taskStopTool, taskOutputTool, todoReadTool, todowriteTool, questionTool, skillTool, webfetchTool, httpRequestTool, websearchTool, codesearchTool, notebookeditTool, enterPlanTool, exitPlanTool, ...createArtifactTools(), ...fileOpsTools, ...gitTools, ...gitFullAutoToolsList]
}

function mcpTools(mcpRegistry) {
  return mcpRegistry.listTools().map((tool) => ({
    name: tool.id,
    description: `[mcp:${tool.server}] ${tool.description}`,
    inputSchema: tool.inputSchema,
    async execute(args, ctx) {
      try {
        const result = await mcpRegistry.callTool(tool.id, args || {}, ctx.signal || null)
        return { output: result.output, content: result.content || [], structuredContent: result.structuredContent, metadata: { mcp: { content: result.content || [], structuredContent: result.structuredContent } } }
      } catch (error) {
        const reason = error.reason || "unknown"
        const server = error.server || tool.server
        return { output: `[MCP Error: ${server} ${reason}] ${error.message}`, status: 'error', metadata: { outcomeUnknown: error.operationNotStarted !== true && error.details?.knownOutcome !== true && error.code !== 'mcp_auth_required' && !['spawn_failed', 'connection_refused', 'mcp_auth_required', 'not_found', 'not_supported', 'shutting_down'].includes(reason) } }
      }
    }
  }))
}

function toolAllowedByMode(toolName, mode) {
  if (mode === "plan") {
    return !["write", "edit", "patch", "multiedit", "notebookedit", "git_snapshot", "git_restore", "git_apply_patch", "git_delete_snapshot"].includes(toolName)
  }
  return true
}

/**
 * ToolRegistry 工厂（1.0.0 阶段 2a）：initialized/tools/签名缓存收编为实例
 * 字段（M3 §四.2），每个 kernel 实例一份工具集。
 *
 * @param {object} [deps]
 * @param {typeof McpRegistry} [deps.mcpRegistry] MCP 注册表（默认进程级连接池，§7.2 显式契约）
 * @param {boolean} [deps.deferMcp] MCP 后台加载装配开关：createKernel 置 true
 *   —— boot/回合不 await MCP 连接，不就绪的工具不进广告面，收口（mcp.loaded）
 *   后经 onLoad 原子换入；`mcp.background_load: false` 可退回前台。直接自建
 *   注册表的调用方（测试 / SDK 定制组装）缺省保持「initialize 返回即就绪」
 *   的同步语义 —— 那是工具注册表对自有调用方的既有契约，不默认改写。
 * @param {(diagnostic: object) => any} [deps.onDiagnostic] Host-only rejection diagnostics; metadata never supplies this callback.
 */
export function createToolRegistry({ mcpRegistry = McpRegistry, deferMcp = false, onDiagnostic = null } = {}) {
  const browser = createBrowserTool()
  const bridge = createBrowserBridgeTool()
  const batch = createToolBatch()
  // Pure tool-definition factories: reserve the complete host namespace even
  // when an optional builtin/source is disabled. No tool is executed here.
  const reservedNames = new Set([
    ...builtinTools({ git_auto: { enabled: true, full_auto: true } }), browser, bridge, batch,
    ...createBrowserRecipeTools(browser), ...createLspTools(), ...createOfficeTools(),
    ...createMcpCatalogTools(mcpRegistry), createToolProgram(), { name: 'tool_search' }
  ].map(tool => tool.name))
  // Identity is host-owned, never a field a local/plugin/MCP definition can
  // forge. In particular an mcp_ prefix is not evidence of MCP provenance.
  const toolSources = new WeakMap()
  const state = {
    initialized: false,
    tools: [],
    loadedAt: 0,
    lastSignature: "",
    lastCwd: "",
    lastConfig: null,
    lastAllowProjectSources: true,
    refreshing: false,
    diagnostics: []
  }

  function admitExtensions(existing, candidates) {
    const existingNames = new Set(existing.map(tool => tool.name))
    const counts = new Map()
    for (const { tool } of candidates) counts.set(tool.name, (counts.get(tool.name) || 0) + 1)
    const tools = [], diagnostics = []
    for (const { tool, source } of candidates) {
      const code = reservedNames.has(tool.name) ? 'reserved_builtin_name'
        : typeof tool.name !== 'string' || !tool.name.trim() ? 'invalid_tool_name'
          : existingNames.has(tool.name) || counts.get(tool.name) > 1 ? 'duplicate_tool_name' : null
      if (code) {
        const toolName = String(tool.name || '').replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 160)
        diagnostics.push({ code, source, tool: toolName, message: `Rejected ${source} tool ${JSON.stringify(toolName)}: ${code === 'reserved_builtin_name' ? 'the identifier is reserved for a host builtin, even when disabled' : code === 'duplicate_tool_name' ? 'the identifier is ambiguous with another registered tool' : 'a nonempty tool identifier is required'}. This tool was not registered or executed.` })
        continue
      }
      toolSources.set(tool, source)
      tools.push(tool)
    }
    return { tools, diagnostics }
  }

  function reportDiagnostics(diagnostics, { replaceMcp = false } = {}) {
    state.diagnostics = [...(replaceMcp ? state.diagnostics.filter(item => item.source !== 'mcp') : []), ...diagnostics].slice(0, 512)
    for (const diagnostic of diagnostics) {
      try { Promise.resolve(onDiagnostic?.({ ...diagnostic })).catch(() => {}) }
      catch { /* A diagnostic listener cannot grant registration or break valid peers. */ }
    }
    return state.diagnostics.map(item => ({ ...item }))
  }

  // MCP 后台加载收口时把新工具原子换进广告面（refreshMcpTools 内部是整体替换
  // mcp_ 切片）。UI 的通知不走这里 —— 那是 mcp.loaded 事件的职责。
  if (typeof mcpRegistry.onLoad === "function") {
    mcpRegistry.onLoad(() => {
      try {
        ToolRegistry.refreshMcpTools()
      } catch { /* 刷新失败保持旧广告面，下一轮加载再试 */ }
    })
  }

  const ToolRegistry = {
    /** @param {{ config?: Record<string, any>, cwd?: string, force?: boolean, allowProjectSources?: boolean }} [options] */
    async initialize({
      config = {},
      cwd = runtimeCwd(),
      force = false,
      allowProjectSources = true
    } = {}) {
      const ttlMs = Math.max(0, Number(config.runtime?.tool_registry_cache_ttl_ms || 30000))
      const sig = signatureFor(config, cwd, allowProjectSources)
      const cacheValid =
        state.initialized &&
        !force &&
        state.lastSignature === sig &&
        state.lastCwd === cwd &&
        Date.now() - state.loadedAt <= ttlMs
      if (cacheValid) return { diagnostics: state.diagnostics.map(item => ({ ...item })) }

      const tools = []
      const extensions = []

      if (config.tool?.sources?.builtin !== false) {
        tools.push(...registerBashPreflights(registerAtomicMutationPreflights(markStrictBuiltinTools(builtinTools(config)))))
        if (config.tool?.browser?.enabled !== false) tools.push(...markStrictBuiltinTools([browser]))
        if (config.tool?.browser?.enabled !== false) tools.push(bridge)
        if (config.tool?.browser?.enabled !== false) tools.push(...markStrictBuiltinTools(createBrowserRecipeTools(browser)))
        tools.push(...markStrictBuiltinTools(createLspTools()))
        tools.push(...markStrictBuiltinTools(createOfficeTools()))
        tools.push(...createMcpCatalogTools(mcpRegistry))
        tools.push(batch)
        if (config.tool?.program?.enabled === true) tools.push(...markStrictBuiltinTools([createToolProgram()]))
        tools.push({
          name: 'tool_search',
          description: 'Find tools by task, capability or exact name, including MCP integrations and detailed builtin usage. Returns schemas and instructions and enables matching tools for this turn; never runs them or grants permission.',
          inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1024 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false },
          async execute(args, ctx) {
            const available = await ToolRegistry.list({ mode: ctx.mode, config: ctx.config, cwd: ctx.cwd })
            const eligible = available.filter(tool => tool.name !== 'tool_search' && (!ctx.allowedToolNames || ctx.allowedToolNames.includes(tool.name)))
            const matches = searchToolMetadata(eligible, String(args.query || ''), args.limit)
            ctx.activateTools?.(matches.map(tool => tool.name))
            const found = await Promise.all(matches.map(async ({ score: _score, ...tool }) => ({ ...tool, instructions: /^[a-z0-9_-]+$/i.test(tool.name) ? await loadToolPrompt(`${tool.name}.txt`).catch(() => '') : '' })))
            return { tools: found, activated: typeof ctx.activateTools === 'function', note: 'Discovery does not authorize tool execution; all existing permission gates still apply.' }
          }
        })
      }
      for (const tool of tools) toolSources.set(tool, 'builtin')

      if (config.tool?.sources?.local !== false) {
        const localDirs = (config.tool?.local_dirs || [])
          .map((dir) => path.resolve(cwd, dir))
          .filter((dir) => allowProjectSources || !isWithinWorkspace(cwd, dir))
        extensions.push(...(await loadDynamicTools(localDirs)).map(tool => ({ tool, source: 'local' })))
      }

      if (config.tool?.sources?.plugin !== false) {
        const pluginDirs = (config.tool?.plugin_dirs || [])
          .map((dir) => path.resolve(cwd, dir))
          .filter((dir) => allowProjectSources || !isWithinWorkspace(cwd, dir))
        extensions.push(...(await loadDynamicTools(pluginDirs)).map(tool => ({ tool, source: 'plugin' })))
      }

      if (config.tool && config.tool?.sources?.mcp !== false) {
        // MCP 后台加载只在 deferMcp 装配（createKernel）下生效：连接/工具发现
        // 挂到后台，initialize 立即返回 —— 不就绪的 MCP 工具**不进广告面**
        // （mcpTools 只快照已就绪的部分），加载收口后经 onLoad → refreshMcpTools
        // 原子换入。选「就绪前排除」而不是「首个用到的 turn 短等待」：广告面只
        // 陈述现在确定可用的东西，回合延迟不被 MCP 连接时间绑架。
        const defer = deferMcp && config.mcp?.background_load !== false && typeof mcpRegistry.onLoad === "function"
        await mcpRegistry.initialize(config, { cwd, allowProjectSources, defer })
        extensions.push(...mcpTools(mcpRegistry).map(tool => ({ tool, source: 'mcp' })))
      }

      const admitted = admitExtensions(tools, extensions)
      state.tools = [...tools, ...admitted.tools]
      state.initialized = true
      state.loadedAt = Date.now()
      state.lastSignature = sig
      state.lastCwd = cwd
      state.lastConfig = config
      state.lastAllowProjectSources = allowProjectSources
      return { diagnostics: reportDiagnostics(admitted.diagnostics) }
    },

    getDiagnostics() { return state.diagnostics.map(item => ({ ...item })) },

    sourceOf(tool) { return toolSources.get(tool) || null },

    isReady() {
      return state.initialized
    },
    async shutdown() {
      const results = await Promise.allSettled([browser.shutdown(), bridge.shutdown()])
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },

    /** @param {{ mode?: string, cwd?: string, config?: Record<string, any>, allowProjectSources?: boolean }} [options] */
    async list({
      mode,
      cwd = runtimeCwd(),
      config = undefined,
      allowProjectSources = undefined
    } = {}) {
      const resolvedConfig = config === undefined ? state.lastConfig || {} : config
      const resolvedAllowProjectSources = allowProjectSources === undefined
        ? state.lastAllowProjectSources
        : allowProjectSources
      if (!state.initialized) {
        await this.initialize({
          config: resolvedConfig,
          cwd,
          allowProjectSources: resolvedAllowProjectSources
        })
      } else {
        await this.initialize({
          config: resolvedConfig,
          cwd,
          force: false,
          allowProjectSources: resolvedAllowProjectSources
        })
      }
      return state.tools
        .filter((tool) => toolAllowedByMode(tool.name, mode))
        .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    },

    async get(toolName) {
      return state.tools.find((tool) => tool.name === toolName) || null
    },

    async listForModel(options = {}) {
      const tools = await this.list(options)
      return modelToolSurface(tools, options).map(tool => tool.name === 'task'
        ? { ...tool, inputSchema: taskModelSchema(tool.inputSchema) } : tool)
    },

    async call(toolName, args, ctx) {
      const tool = await this.get(toolName)
      if (!tool) {
        return {
          name: toolName,
          status: "error",
          output: `unknown tool: ${toolName}`,
          error: `unknown tool: ${toolName}`
        }
      }
      try {
        const output = await tool.execute(args || {}, ctx)
        return makeToolResult({ name: toolName, ...normalizeToolOutcome(output, ctx?.signal) })
      } catch (error) {
        return {
          name: toolName,
          status: "error",
          output: error.message,
          error: error.message
        }
      }
    },

    refreshMcpTools() {
      if (!state.initialized || state.refreshing) return
      if (!state.lastConfig?.tool || state.lastConfig.tool.sources?.mcp === false) return { diagnostics: state.diagnostics.map(item => ({ ...item })) }
      state.refreshing = true
      try {
        // Atomic replacement by source identity, with per-tool quarantine. A
        // single malicious/colliding server name must not erase valid peers.
        const nonMcp = state.tools.filter(tool => toolSources.get(tool) !== 'mcp')
        const admitted = admitExtensions(nonMcp, mcpTools(mcpRegistry).map(tool => ({ tool, source: 'mcp' })))
        state.tools = [...nonMcp, ...admitted.tools]
        return { diagnostics: reportDiagnostics(admitted.diagnostics, { replaceMcp: true }), admitted: admitted.tools.length, rejected: admitted.diagnostics.length }
      } finally {
        state.refreshing = false
      }
    }
  }
  return ToolRegistry
}

const defaultToolRegistry = createToolRegistry()

/**
 * 兼容别名（deprecated）：进程级默认 ToolRegistry 实例。旧 import 路径继续
 * 工作，每次方法调用经 deprecations.mjs 记录；新代码用 createKernel() 句柄
 * 的 `tools` 命名空间。
 */
export const ToolRegistry = deprecatedSingletonAlias(
  "kernel.singleton.tool-registry",
  "模块级单例 `ToolRegistry` 已收编为 kernel 实例字段：新代码改用 createKernel() 句柄的 `tools` 命名空间",
  defaultToolRegistry
)
