import { spawnSync } from "node:child_process"

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g

function runClipboardCommand(command, args, text, spawn = spawnSync) {
  try {
    const result = spawn(command, args, {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 1500,
      windowsHide: true
    })
    return !result?.error && Number(result?.status ?? 0) === 0
  } catch {
    return false
  }
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
export function copyTerminalText(text, {
  output = process.stdout,
  platform = process.platform,
  env = process.env,
  spawn = spawnSync
} = {}) {
  const value = String(text || "")
  if (!value) {
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

  const candidates = platform === "win32"
    ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$input | Set-Clipboard"]]]
    : platform === "darwin"
      ? [["pbcopy", []]]
      : env.WAYLAND_DISPLAY
        ? [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]]
        : [["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]], ["wl-copy", []]]

  for (const [command, args] of candidates) {
    if (runClipboardCommand(command, args, value, spawn)) {
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
