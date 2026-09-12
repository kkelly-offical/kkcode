import { spawn } from "node:child_process"

/**
 * 门禁与判据共用的命令执行原语。
 *
 * 从 usability-gates.mjs 抽出来的理由是循环依赖：0.7.0 的 smoke 门禁既要用
 * 这个执行器，又要被 runUsabilityGates 调用。ESM 的函数提升让循环 import
 * 恰好能跑，但那是巧合而非设计 —— 谁在里面加一个模块级 const 就会炸，
 * 而炸的现场（undefined is not a function）离原因很远。
 */

/**
 * 门禁命令默认超时，沿用抽出前的 15 分钟。
 * `npm test` 在大仓库里几分钟是常态，调小会把慢测试误判成挂死。
 */
export const DEFAULT_GATE_TIMEOUT_MS = 15 * 60 * 1000

export function outputSnippet(result) {
  const lines = `${result.stdout || ""}\n${result.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.slice(-12).join(" | ")
}

/**
 * 受控地跑一条命令：shell:false、windowsHide、超时 kill、stdout/stderr 收集。
 * goal-verifier 的 command 类判据复用它（改名导出为 runGateCommand），
 * 不要在别处再写一个裸 spawn。
 */
export async function runGateCommand({ command, args, cwd, shell = false, timeoutMs = DEFAULT_GATE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let done = false
    let stdout = ""
    let stderr = ""
    let timedOut = false

    let child
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell,
        stdio: ["ignore", "pipe", "pipe"]
      })
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: String(error?.message || error),
        timedOut: false
      })
      return
    }

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
