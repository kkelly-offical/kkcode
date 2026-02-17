// Extract patterns hook
// Before compaction, analyzes the conversation for repeatable patterns and saves as instincts

import { addInstinct } from "../../session/instinct-manager.mjs"

// Patterns we look for in tool usage sequences
const PATTERN_SIGNALS = [
  { regex: /always run.*test/i, pattern: "Always run tests after code changes", category: "workflow" },
  { regex: /npm audit|pip audit|cargo audit/i, pattern: "Run dependency audit after adding packages", category: "security" },
  { regex: /git add.*&&.*git commit/i, pattern: "Stage specific files rather than using git add -A", category: "workflow" },
  { regex: /\.test\.(ts|js|tsx|jsx)|_test\.go|test_.*\.py/i, pattern: "Co-locate test files with implementation", category: "testing" },
  { regex: /prettier|eslint --fix|black |ruff /i, pattern: "Format code after editing", category: "coding" },
  { regex: /tsconfig|tsc --noEmit/i, pattern: "Verify TypeScript types after changes", category: "coding" }
]

export default {
  name: "extract-patterns",
  session: {
    async compacting(payload) {
      const { messages, cwd } = payload
      if (!messages || !Array.isArray(messages) || !cwd) return payload

      // Scan assistant messages for pattern signals
      const textContent = messages
        .filter((m) => m.role === "assistant")
        .map((m) => {
          if (typeof m.content === "string") return m.content
          if (Array.isArray(m.content)) {
            return m.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join(" ")
          }
          return ""
        })
        .join("\n")

      for (const signal of PATTERN_SIGNALS) {
        if (signal.regex.test(textContent)) {
          try {
            await addInstinct(cwd, signal.pattern, signal.category)
          } catch {
            // Non-critical — skip on failure
          }
        }
      }

      // Look for user-confirmed patterns ("always do X", "never do Y", "remember to Z")
      const userText = messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")

      const alwaysMatch = userText.match(/(?:always|每次都要|总是)\s+(.{10,80})/gi)
      if (alwaysMatch) {
        for (const match of alwaysMatch.slice(0, 3)) {
          try {
            await addInstinct(cwd, match.trim(), "workflow")
          } catch { /* skip */ }
        }
      }

      const neverMatch = userText.match(/(?:never|不要|禁止)\s+(.{10,80})/gi)
      if (neverMatch) {
        for (const match of neverMatch.slice(0, 3)) {
          try {
            await addInstinct(cwd, match.trim(), "workflow")
          } catch { /* skip */ }
        }
      }

      return payload
    }
  }
}
