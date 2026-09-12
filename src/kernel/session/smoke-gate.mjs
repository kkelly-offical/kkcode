import path from "node:path"
import { pathToFileURL } from "node:url"
import { readFile, access } from "node:fs/promises"
import { runGateCommand, outputSnippet } from "./gate-command.mjs"

/**
 * smoke 门禁：把产物真的跑起来。
 *
 * 为什么需要它：现有五道门禁（build/test/review/health/budget）全是静态检查。
 * `npm run build` 退出码为 0 只说明编译通过，`npm test` 通过只说明测试里覆盖
 * 到的路径没坏 —— 两者都接不住「编译过了但一启动就崩」。这类失败在改动入口
 * 文件、改动 import 图、删掉一个还有人引用的导出时最常见，而那恰恰是 agent
 * 最爱做的改动。
 *
 * 判定方式刻意保守：**只在能确定入口点时才生效**，否则返回 not_applicable。
 * 一个乱猜启动命令的门禁会在别人的项目里制造假失败，比没有这道门禁更糟。
 */

const DEFAULT_TIMEOUT_MS = 20000

/**
 * 一眼可见的运行时崩溃签名。
 *
 * 只认这些「一定是坏了」的签名，不做通用的 error 关键字匹配 —— 正常启动
 * 日志里出现 "error" 的项目太多了（`errorHandler registered`、
 * `0 errors` 之类），宽泛匹配会把它们全判成失败。
 */
const CRASH_SIGNATURES = [
  { pattern: /\bERR_MODULE_NOT_FOUND\b/, label: "missing module (ERR_MODULE_NOT_FOUND)" },
  { pattern: /\bERR_REQUIRE_ESM\b/, label: "CommonJS/ESM mismatch (ERR_REQUIRE_ESM)" },
  { pattern: /\bERR_UNSUPPORTED_DIR_IMPORT\b/, label: "directory import (ERR_UNSUPPORTED_DIR_IMPORT)" },
  { pattern: /^\s*SyntaxError:/m, label: "SyntaxError at load time" },
  { pattern: /^\s*ReferenceError:/m, label: "ReferenceError at load time" },
  { pattern: /^\s*TypeError:.*is not a function/m, label: "TypeError: not a function" },
  { pattern: /Cannot find module/, label: "Cannot find module" },
  { pattern: /\bEADDRINUSE\b/, label: "port already in use (EADDRINUSE)" },
  { pattern: /UnhandledPromiseRejection/, label: "unhandled promise rejection" }
]

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function readPackage(cwd) {
  try {
    return JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"))
  } catch {
    return null
  }
}

/**
 * 确定这个项目该怎么"跑一下"。
 *
 * 优先级反映的是确定性从高到低：显式配置 > package.json 声明的入口 >
 * 惯例文件名。走到最后都没有就返回 null —— 宁可不判，不可乱判。
 */
export async function resolveSmokeTarget(cwd, config) {
  const configured = config?.agent?.longagent?.usability_gates?.smoke
  if (configured?.command) {
    return {
      kind: "configured",
      command: String(configured.command),
      args: Array.isArray(configured.args) ? configured.args.map(String) : [],
      shell: false,
      describe: `configured command: ${configured.command}`
    }
  }

  const pkg = await readPackage(cwd)

  // CLI 项目：bin 指向的文件加 --version / --help，是最安全的"跑一下"——
  // 它必须完整加载模块图，但不会起服务、不会写盘、不会等输入。
  const bin = pkg?.bin
  const binPath = typeof bin === "string" ? bin : bin && typeof bin === "object" ? Object.values(bin)[0] : null
  if (binPath && await exists(path.join(cwd, binPath))) {
    return {
      kind: "bin",
      command: process.execPath,
      args: [path.join(cwd, binPath), "--version"],
      shell: false,
      describe: `${binPath} --version`
    }
  }

  // 库项目：import 一次入口。ESM 的大部分加载期错误都在这一步暴露。
  const entry = pkg?.exports?.["."] || pkg?.exports || pkg?.main || pkg?.module
  const entryPath = typeof entry === "string" ? entry : entry?.import || entry?.default
  if (typeof entryPath === "string" && await exists(path.join(cwd, entryPath))) {
    return {
      kind: "entry",
      command: process.execPath,
      // 必须转成 file:// URL：Windows 上 `await import("C:\\x\\index.mjs")` 里的
      // `C:` 会被当成 URL scheme，抛 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 那会让
      // 这道门禁在每一个 Windows 库项目上都报假失败。
      args: ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.resolve(cwd, entryPath)).href)})`],
      shell: false,
      describe: `import ${entryPath}`
    }
  }

  return null
}

/**
 * @returns {{enabled: boolean, status: string, reason: string, output?: string, evidence?: object}}
 *   形状与其余五道门禁一致（见 gate-contract.mjs 的契约说明）。
 */
export async function checkSmokeGate({ cwd = process.cwd(), config = {} } = {}) {
  if (config?.agent?.longagent?.usability_gates?.smoke?.enabled === false) {
    return { enabled: false, status: "disabled", reason: "smoke gate disabled" }
  }

  const target = await resolveSmokeTarget(cwd, config)
  if (!target) {
    // 乱猜启动命令会在别人的项目里制造假失败 —— 不判比错判好
    return {
      enabled: true,
      status: "not_applicable",
      reason: "no runnable entry point found (set agent.longagent.usability_gates.smoke.command to enable)"
    }
  }

  const timeoutMs = Math.min(
    Math.max(Number(config?.agent?.longagent?.usability_gates?.smoke?.timeout_ms) || DEFAULT_TIMEOUT_MS, 1000),
    120_000
  )

  const result = await runGateCommand({
    command: target.command,
    args: target.args,
    cwd,
    shell: target.shell,
    timeoutMs
  })

  const combined = `${result.stdout || ""}\n${result.stderr || ""}`
  const crashes = CRASH_SIGNATURES.filter(({ pattern }) => pattern.test(combined)).map(({ label }) => label)

  const evidence = {
    target: target.describe,
    kind: target.kind,
    exitCode: result.code,
    timedOut: result.timedOut,
    crashSignatures: crashes
  }

  // 崩溃签名优先于退出码：一个进程可以打印 ERR_MODULE_NOT_FOUND 之后
  // 仍然以 0 退出（吞掉了自己的错误），那种情况正是这道门禁要抓的。
  if (crashes.length) {
    return {
      enabled: true,
      status: "fail",
      reason: `runtime crash signature: ${crashes.join(", ")}`,
      output: outputSnippet(result),
      evidence
    }
  }
  if (result.timedOut) {
    return {
      enabled: true,
      status: "fail",
      reason: `${target.describe} did not finish within ${timeoutMs}ms`,
      output: outputSnippet(result),
      evidence
    }
  }
  if (!result.ok) {
    return {
      enabled: true,
      status: "fail",
      reason: `${target.describe} exited with code ${result.code}`,
      output: outputSnippet(result),
      evidence
    }
  }

  return {
    enabled: true,
    status: "pass",
    reason: `${target.describe} ran clean`,
    evidence
  }
}
