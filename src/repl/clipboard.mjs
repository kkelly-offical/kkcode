import { spawn as spawnProcess } from "node:child_process"

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g
const WINDOWS_CLIPBOARD_SCRIPT = [
  "$encoded=[Console]::In.ReadToEnd()",
  "$bytes=[Convert]::FromBase64String($encoded)",
  "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($bytes))"
].join(";")

export function runClipboardCommand(command, args, text, {
  spawn = spawnProcess,
  timeoutMs = 1500,
  signal
} = {}) {
  return new Promise((resolve) => {
    let child
    let timer = null
    let settled = false
    let onAbort = null

    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener?.("abort", onAbort)
      resolve(Boolean(ok))
    }
    const abort = () => {
      if (settled) return
      // Settle first so a synchronous close emitted while shutting down stdin
      // cannot turn an aborted clipboard request into a reported success.
      finish(false)
      try {
        if (typeof child?.stdin?.destroy === "function") child.stdin.destroy()
        else child?.stdin?.end?.()
      } catch {}
      try {
        child?.kill?.()
      } catch {}
    }

    if (signal?.aborted) {
      finish(false)
      return
    }

    try {
      child = spawn(command, args, {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true
      })
    } catch {
      finish(false)
      return
    }

    if (!child || typeof child.once !== "function" || !child.stdin) {
      abort()
      return
    }

    child.once("error", abort)
    child.once("close", (code, signal) => {
      // A missing exit code (for example, termination by a signal) must never
      // be mistaken for a successful clipboard write.
      finish(code === 0 && signal == null)
    })
    child.stdin.once?.("error", abort)

    onAbort = abort
    signal?.addEventListener?.("abort", onAbort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }

    timer = setTimeout(abort, Math.max(1, Number(timeoutMs) || 1500))
    timer.unref?.()

    try {
      child.stdin.end(String(text || ""), "utf8")
    } catch {
      abort()
    }
  })
}

export function osc52Sequence(text) {
  const encoded = Buffer.from(String(text || ""), "utf8").toString("base64")
  return `\x1b]52;c;${encoded}\x07`
}

export function copyableFrameLine(frameLines, row, {
  logStartRow = 0,
  logEndRow = 0,
  showScrollbar = false
} = {}) {
  if (!Array.isArray(frameLines) || row < 0 || row >= frameLines.length) return ""
  let plain = String(frameLines[row] || "").replace(ANSI_RE, "")
  const screenRow = row + 1
  if (showScrollbar && screenRow >= logStartRow && screenRow <= logEndRow) {
    plain = plain.replace(/\s[│┃]\s*$/, "")
  }
  return plain.trimEnd()
}

/**
 * Copies selected text using OSC 52 plus a local platform clipboard fallback.
 * OSC 52 reaches the user's terminal over SSH/tmux; native commands cover
 * terminals that intentionally disable OSC 52.
 */
export async function copyTerminalText(text, {
  output = process.stdout,
  platform = process.platform,
  env = process.env,
  spawn = spawnProcess,
  timeoutMs = 1500,
  signal
} = {}) {
  const value = String(text || "")
  if (!value || signal?.aborted) {
    return {
      ok: false,
      confirmed: false,
      requested: false,
      method: null
    }
  }

  let oscRequested = false
  try {
    output?.write?.(osc52Sequence(value))
    // OSC 52 has no acknowledgement channel. A successful write only means
    // that the request reached the terminal, not that clipboard access was
    // granted by the emulator.
    oscRequested = true
  } catch {}

  // On a remote shell, local clipboard binaries refer to the remote machine;
  // OSC 52 is the only useful transport to the user's terminal.
  if (env.SSH_CONNECTION || env.SSH_TTY) {
    return {
      ok: false,
      confirmed: false,
      requested: oscRequested,
      method: oscRequested ? "osc52" : null
    }
  }

  const windowsInput = Buffer.from(value, "utf8").toString("base64")
  const candidates = platform === "win32"
    ? [
        ["pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CLIPBOARD_SCRIPT], windowsInput],
        ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CLIPBOARD_SCRIPT], windowsInput]
      ]
    : platform === "darwin"
      ? [["pbcopy", [], value]]
      : env.WAYLAND_DISPLAY
        ? [
            ["wl-copy", [], value],
            ["xclip", ["-selection", "clipboard"], value],
            ["xsel", ["--clipboard", "--input"], value]
          ]
        : [
            ["xclip", ["-selection", "clipboard"], value],
            ["xsel", ["--clipboard", "--input"], value],
            ["wl-copy", [], value]
          ]

  for (const [command, args, input] of candidates) {
    if (signal?.aborted) break
    const copied = await runClipboardCommand(command, args, input, {
      spawn,
      timeoutMs,
      signal
    })
    if (copied && !signal?.aborted) {
      return {
        ok: true,
        confirmed: true,
        requested: oscRequested,
        method: command
      }
    }
  }
  return {
    ok: false,
    confirmed: false,
    requested: oscRequested,
    method: oscRequested ? "osc52" : null
  }
}
