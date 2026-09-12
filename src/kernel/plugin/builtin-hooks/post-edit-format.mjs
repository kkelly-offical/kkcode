// Post-edit auto-format hook
// Runs prettier on JS/TS/CSS/JSON files after edit, if prettier is installed

import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { access, readFile } from "node:fs/promises"
import path from "node:path"

const execFile = promisify(execFileCb)

const FORMATTABLE = /\.(js|jsx|ts|tsx|css|scss|less|json|md|yaml|yml|html|vue|svelte)$/

async function fileExists(p) {
  try { await access(p); return true } catch { return false }
}

function prettierBin(root) {
  const binName = process.platform === "win32" ? "prettier.cmd" : "prettier"
  return path.join(root, "node_modules", ".bin", binName)
}

async function prettierInvocation(root) {
  const packageRoot = path.join(root, "node_modules", "prettier")
  try {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"))
    const bin = typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin?.prettier
    if (typeof bin === "string" && bin.trim()) {
      const entry = path.resolve(packageRoot, bin)
      const relative = path.relative(packageRoot, entry)
      const insidePackage = relative &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      if (insidePackage && await fileExists(entry)) {
        return { command: process.execPath, args: [entry] }
      }
    }
  } catch {
    // Fall back to the executable shim where direct execution is supported.
  }

  if (process.platform === "win32") return null
  const shim = prettierBin(root)
  return await fileExists(shim) ? { command: shim, args: [] } : null
}

export default {
  name: "post-edit-format",
  tool: {
    async after(payload) {
      const toolName = String(payload.toolName || payload.tool || "")
      const { args, cwd } = payload
      if (!["edit", "write", "multiedit"].includes(toolName)) return payload

      // Collect affected files
      const files = []
      if (args?.path) files.push(args.path)
      if (args?.changes) {
        for (const c of args.changes) {
          if (c.path) files.push(c.path)
        }
      }

      const formattable = files.filter(f => FORMATTABLE.test(f))
      if (formattable.length === 0) return payload

      const root = cwd || process.cwd()

      // Check if project-local prettier is available.
      const invocation = await prettierInvocation(root)
      if (!invocation) return payload

      for (const file of formattable) {
        const target = path.resolve(root, file)
        try {
          await execFile(invocation.command, [...invocation.args, "--write", target], {
            cwd: root,
            timeout: 10000
          })
        } catch {
          // Formatting failure is non-critical, silently skip
        }
      }

      return payload
    }
  }
}
