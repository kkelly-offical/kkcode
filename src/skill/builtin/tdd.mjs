export const name = "tdd"
export const description = "Start TDD workflow: scaffold → test → implement → refactor (usage: /tdd <feature description>)"

export async function run(ctx) {
  const feature = (ctx.args || "").trim()

  if (!feature) {
    return `Please describe the feature to develop with TDD.

Usage: /tdd <feature description>

Examples:
  /tdd add a user registration endpoint with email validation
  /tdd implement a caching layer for API responses
  /tdd create a file upload component with drag-and-drop`
  }

  return `Execute Test-Driven Development for the following feature:

**Feature**: ${feature}

Follow this strict TDD cycle:

## Step 1: SCAFFOLD — Define interfaces
- Analyze the feature requirements
- Identify the public API: function signatures, types, interfaces
- Create empty implementation files with stub exports
- Verify the project compiles with stubs

## Step 2: RED — Write failing tests FIRST
- Write tests that exercise the expected behavior
- Cover: happy path, edge cases, error conditions, boundary values
- Run tests to confirm they FAIL (this is critical — you must see red)
- Use the project's existing test framework (detect from package.json, pyproject.toml, go.mod, etc.)

## Step 3: GREEN — Minimum code to pass
- Implement the SIMPLEST code that makes ALL tests pass
- Do NOT optimize or add features beyond what tests require
- Run tests after each implementation step

## Step 4: REFACTOR — Improve while green
- Extract helpers, improve naming, reduce duplication
- Run tests AFTER EVERY refactoring step — they must stay green
- If a test breaks, undo the last change

## Coverage Target: 80%+
Run coverage after completion: \`npx jest --coverage\`, \`pytest --cov\`, \`go test -cover\`, etc.

## Report after each cycle:
1. Tests written (count and names)
2. Tests passing/failing
3. Coverage percentage
4. Decisions made during implementation`
}