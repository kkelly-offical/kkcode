export const name = "debug"
export const description = "Diagnose and fix a bug or error (usage: /debug <error description or message>)"

export async function run(ctx) {
  const issue = (ctx.args || "").trim()

  if (!issue) {
    return `Please describe the bug or paste the error message.

Usage:
  /debug TypeError: Cannot read properties of undefined
  /debug the login page shows a blank screen after submit
  /debug test suite fails on CI but passes locally`
  }

  return `Debug this issue: ${issue}

Follow this systematic approach:

1. **Reproduce**
   - Identify the minimal steps or command to trigger the issue.
   - If an error message was given, search the codebase for the source: \`grep -r "<key phrase>" src/\`
   - If a test fails, run it in isolation to confirm.

2. **Locate root cause**
   - Trace the execution path from the error location backward.
   - Read the relevant source files to understand the logic.
   - Check recent changes: \`git log --oneline -10\` and \`git diff HEAD~3\` for potential regressions.
   - Add diagnostic logging or assertions if the cause isn't obvious.

3. **Fix**
   - Apply the minimal change that addresses the root cause.
   - Do NOT refactor surrounding code or fix unrelated issues.
   - Preserve existing behavior for all other code paths.

4. **Verify**
   - Run the reproduction steps again to confirm the fix.
   - Run related tests if they exist.
   - Check for regressions in adjacent functionality.

5. **Output**
   - State the root cause in one sentence.
   - Show the exact change made (file, line, before/after).
   - List verification steps performed.`
}
