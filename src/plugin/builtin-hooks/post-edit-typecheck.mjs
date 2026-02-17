// Post-edit TypeScript type check hook
// Runs `tsc --noEmit` after editing .ts/.tsx files to catch type errors early

import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { access } from "node:fs/promises"
import path from "node:path"

const exec = promisify(execCb)

async function fileExists(p) {
  try { await access(p); return true } catch { return false }
}

export default {
  name: "post-edit-typecheck",
  tool: {
    async after(payload) {
      const { toolName, args, result, cwd } = payload
      if (!["edit", "write", "multiedit"].includes(toolName)) return payload

      // Determine affected files
      const files = []
      if (args?.path) files.push(args.path)
      if (args?.changes) {
        for (const c of args.changes) {
          if (c.path) files.push(c.path)
        }
      }

      // Only check if at least one TS/TSX file was edited
      const tsFiles = files.filter(f => /\.tsx?$/.test(f))
      if (tsFiles.length === 0) return payload

      // Verify tsconfig.json exists in project
      const tsconfigPath = path.join(cwd || process.cwd(), "tsconfig.json")
      if (!(await fileExists(tsconfigPath))) return payload

      try {
        await exec("npx tsc --noEmit --pretty 2>&1", {
          cwd: cwd || process.cwd(),
          timeout: 15000
        })
        // No errors — silently pass through
      } catch (error) {
        const output = (error.stdout || error.stderr || "").trim()
        if (output) {
          // Append type check warnings to tool result
          const warning = `\n⚠ TypeScript type check found issues:\n${output.slice(0, 2000)}`
          if (typeof result === "string") {
            payload.result = result + warning
          } else if (result && typeof result === "object") {
            payload.result = { ...result, output: (result.output || "") + warning }
          }
        }
      }

      return payload
    }
  }
}
