export const name = "review"
export const description = "Review code changes for bugs, security issues, and quality (usage: /review [file or path])"

export async function run(ctx) {
  const target = (ctx.args || "").trim()

  const scope = target
    ? `Focus on: ${target}`
    : `Review all uncommitted changes (git diff)`

  return `Perform a thorough code review.

${scope}

Steps:
1. Run \`git diff\` to see all uncommitted changes. If a specific file/path was given, use \`git diff -- <path>\`.
2. If no uncommitted changes, run \`git diff HEAD~1\` to review the last commit.
3. For each changed file, analyze:

   **Correctness**
   - Logic errors, off-by-one, null/undefined access
   - Missing error handling or edge cases
   - Race conditions or async issues

   **Security**
   - Injection vulnerabilities (SQL, XSS, command injection)
   - Hardcoded secrets or credentials
   - Unsafe deserialization or eval usage
   - Missing input validation at system boundaries

   **Quality**
   - Naming clarity and code readability
   - Unnecessary complexity or dead code
   - Missing or misleading comments
   - Consistent style with surrounding code

   **Performance**
   - N+1 queries or unnecessary loops
   - Missing memoization for expensive operations
   - Large allocations in hot paths

4. Output findings grouped by severity:
   - 🔴 Critical: bugs or security issues that must be fixed
   - 🟡 Warning: potential issues worth addressing
   - 🟢 Suggestion: improvements that are nice to have

5. For each finding, show the exact file and line, explain the issue, and suggest a fix.
6. End with a brief summary: total findings by severity, overall assessment.`
}
