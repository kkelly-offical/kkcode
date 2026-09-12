// Console.log warning hook
// Warns when console.log is present in edited production files

import { readFile } from "node:fs/promises"
import path from "node:path"

const PRODUCTION_FILE = /\.(js|jsx|ts|tsx|mjs|cjs)$/
const IGNORE_PATH = /(test|spec|__tests__|__mocks__|\.test\.|\.spec\.|\.config\.)/i

export default {
  name: "console-warn",
  tool: {
    async after(payload) {
      const { toolName, args, result, cwd } = payload
      if (!["edit", "write"].includes(toolName)) return payload

      const file = args?.path
      if (!file) return payload
      if (!PRODUCTION_FILE.test(file)) return payload
      if (IGNORE_PATH.test(file)) return payload

      const target = path.resolve(cwd || process.cwd(), file)
      try {
        const content = await readFile(target, "utf8")
        const matches = content.match(/console\.(log|debug|info)\(/g)
        if (matches && matches.length > 0) {
          const warning = `\n⚠ Found ${matches.length} console.log/debug/info call(s) in ${file}. Consider removing before production.`
          if (typeof result === "string") {
            payload.result = result + warning
          } else if (result && typeof result === "object") {
            payload.result = { ...result, output: (result.output || "") + warning }
          }
        }
      } catch {
        // File not readable, skip
      }

      return payload
    }
  }
}
