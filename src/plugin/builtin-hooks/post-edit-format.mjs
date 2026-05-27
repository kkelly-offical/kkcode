// Post-edit auto-format hook
// Runs prettier on JS/TS/CSS/JSON files after edit, if prettier is installed

import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { access } from "node:fs/promises"
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
      const pkgPath = prettierBin(root)
      if (!(await fileExists(pkgPath))) return payload

      for (const file of formattable) {
        const target = path.resolve(root, file)
        try {
          await execFile(pkgPath, ["--write", target], {
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
