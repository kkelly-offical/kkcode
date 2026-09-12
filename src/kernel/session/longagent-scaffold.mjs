import { processTurnLoop } from "./loop.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { stat } from "node:fs/promises"
import path from "node:path"

function buildScaffoldPrompt(objective, stagePlan) {
  const tasksByFile = new Map()
  const taskSpecs = []

  for (const stage of stagePlan.stages || []) {
    for (const task of stage.tasks || []) {
      for (const file of task.plannedFiles || []) {
        tasksByFile.set(file, { taskId: task.taskId, stageId: stage.stageId, prompt: task.prompt, acceptance: task.acceptance })
      }
      taskSpecs.push({ taskId: task.taskId, stageId: stage.stageId, prompt: task.prompt, plannedFiles: task.plannedFiles, acceptance: task.acceptance })
    }
  }

  const fileList = [...tasksByFile.keys()].sort()
  if (!fileList.length) return null

  const fileContext = fileList.map((f) => {
    const t = tasksByFile.get(f)
    return `- ${f}  (task: ${t.taskId}, stage: ${t.stageId})`
  })

  return [
    "You are the ARCHITECT agent for a production-grade parallel coding pipeline.",
    "Your job: create ALL project files as detailed scaffolds that guide independent sub-agents to produce compatible, integrable code.",
    "",
    "CRITICAL CONTEXT: Each sub-agent works in ISOLATION. It can only see:",
    "- The scaffold file you create (with your inline comments)",
    "- Its task prompt and file ownership list",
    "- Files created by PREVIOUS stages (not the current stage)",
    "Your scaffold is the sub-agent's PRIMARY source of truth. Ambiguous or incomplete scaffolds cause integration failures.",
    "",
    "## Objective",
    objective,
    "",
    "## Files to create:",
    ...fileContext,
    "",
    "## Task plan (each task assigned to an independent sub-agent):",
    JSON.stringify(taskSpecs, null, 2),
    "",
    "## Scaffold Specification (follow EXACTLY)",
    "",
    "Create EVERY file listed above using the `write` tool. Each file MUST contain:",
    "",
    "### 1. File Header Block",
    "```",
    "// FILE: <relative path>",
    "// PURPOSE: <one-sentence description of this file's responsibility>",
    "// DEPENDS ON: <list of files this imports from, with what symbols>",
    "// USED BY: <list of files that import from this>",
    "// OWNER: task <taskId> | stage <stageId>",
    "```",
    "",
    "### 2. Complete Import Statements",
    "- Write ALL import/require statements with CORRECT relative paths",
    "- Include the exact symbol names being imported: `import { foo, bar } from './module.mjs'`",
    "- This is the dependency contract — sub-agents rely on these paths being accurate",
    "- If importing from a file owned by a DIFFERENT task in the same stage, add a comment: `// CROSS-TASK: implemented by <taskId>`",
    "",
    "### 3. Exported API Surface",
    "- Declare ALL exports with full signatures (function name, parameters with types, return type)",
    "- For each export, add a one-line JSDoc/docstring describing its contract",
    "- This is the integration contract — other files depend on these exact signatures",
    "",
    "### 4. Implementation Blueprint (THE CORE)",
    "For every function, class, method, handler, route:",
    "- Write the complete signature/declaration",
    "- Inside the body, write NUMBERED STEP comments describing:",
    "  1. Input validation: what to check, what errors to throw for invalid input",
    "  2. Core algorithm: step-by-step logic flow with concrete details",
    "  3. Data transformations: input shape → processing → output shape",
    "  4. Error handling: what to catch, what to throw, what to log",
    "  5. Side effects: DB writes, API calls, event emissions, file I/O",
    "  6. Return value: exact shape and type of the return value",
    "",
    "### 5. Strict Prohibitions",
    "- Do NOT write actual implementation code — only signatures + comment blueprints",
    "- Do NOT write vague placeholders like `// TODO` or `pass` without detailed steps",
    "- Do NOT skip any file — every file in the list MUST be created",
    "- Do NOT invent files not in the plan — only create files listed above",
    "- Do NOT use generic comments like 'handle errors' — specify WHICH errors and HOW",
    "",
    "### Language-specific patterns",
    "",
    "**JavaScript/TypeScript:**",
    "```js",
    "// FILE: src/auth/jwt.mjs",
    "// PURPOSE: JWT token generation and verification",
    "// DEPENDS ON: src/config/env.mjs (reads JWT_SECRET)",
    "// USED BY: src/middleware/auth.mjs, src/routes/login.mjs",
    "// TASK: s1_auth | STAGE: s1",
    "",
    "import { getEnv } from '../config/env.mjs'",
    "",
    "export function generateToken(userId, role) {",
    "  // 1. Read JWT_SECRET from getEnv('JWT_SECRET')",
    "  // 2. Build payload: { sub: userId, role, iat: now, exp: now + 24h }",
    "  // 3. Sign with HS256 algorithm using jsonwebtoken.sign()",
    "  // 4. Return the signed token string",
    "  // ERROR: throw if JWT_SECRET is missing",
    "}",
    "```",
    "",
    "**Python:**",
    "```python",
    "# FILE: app/services/user_service.py",
    "# PURPOSE: User CRUD operations",
    "# DEPENDS ON: app/models/user.py, app/db/session.py",
    "# USED BY: app/routes/users.py",
    "# TASK: s1_users | STAGE: s1",
    "",
    "from app.models.user import User",
    "from app.db.session import get_db",
    "",
    "async def create_user(email: str, password: str) -> User:",
    "    # 1. Validate email format with regex",
    "    # 2. Check if email already exists in DB → raise DuplicateError",
    "    # 3. Hash password with bcrypt (12 rounds)",
    "    # 4. Insert new User record into DB",
    "    # 5. Return the created User object (without password hash)",
    "    pass",
    "```",
    "",
    "**React/Vue components:**",
    "```jsx",
    "// FILE: src/components/UserList.tsx",
    "// PURPOSE: Paginated user list with search and sort",
    "// DEPENDS ON: src/api/users.ts, src/components/Pagination.tsx",
    "// USED BY: src/pages/AdminDashboard.tsx",
    "// TASK: s2_ui | STAGE: s2",
    "",
    "// PROPS: { pageSize?: number, onSelect: (user) => void }",
    "// STATE: users[], loading, error, searchQuery, sortField, currentPage",
    "// EFFECTS:",
    "//   - On mount + searchQuery/sortField/page change → fetch users from API",
    "//   - Debounce search input by 300ms",
    "// RENDER:",
    "//   - Search input at top",
    "//   - Table with columns: name, email, role, created_at (all sortable)",
    "//   - Loading skeleton while fetching",
    "//   - Error banner with retry button",
    "//   - Pagination component at bottom",
    "// STYLE:",
    "//   - Use project's CSS framework (Tailwind/CSS vars) — read config first",
    "//   - Hover states on table rows, focus ring on search input",
    "//   - Consistent spacing from project's design tokens",
    "```",
    "",
    "## Tool Usage Rules",
    "- USE `write` to create each file — this is your PRIMARY and MAIN tool",
    "- USE `read` ONLY to check existing project files (package.json, tsconfig.json, existing modules) for conventions and patterns",
    "- Do NOT use `edit`, `bash`, `grep`, or `glob` — you are creating new scaffolds, not modifying existing code",
    "- Create files in dependency order: shared types/interfaces first, then modules that import them",
    "",
    "## Quality Checklist (verify before completing)",
    "- [ ] Every file in the list has been created",
    "- [ ] All import paths are correct relative paths",
    "- [ ] All exported function signatures include parameter names and types",
    "- [ ] Every function body has numbered step comments (not just '// implement')",
    "- [ ] Cross-task dependencies are marked with `// CROSS-TASK: implemented by <taskId>`",
    "- [ ] File headers include DEPENDS ON and USED BY sections",
    "",
    "## Completion",
    "When ALL files are created and the checklist is satisfied, say [SCAFFOLD_COMPLETE].",
    "",
    "Start now. Create files in dependency order (shared types first, then consumers)."
  ].join("\n")
}

function buildTddScaffoldPrompt(objective, stagePlan) {
  const taskSpecs = []
  const allFiles = new Set()
  for (const stage of stagePlan.stages || []) {
    for (const task of stage.tasks || []) {
      taskSpecs.push({ taskId: task.taskId, stageId: stage.stageId, prompt: task.prompt, plannedFiles: task.plannedFiles, acceptance: task.acceptance })
      for (const f of task.plannedFiles || []) allFiles.add(f)
    }
  }
  if (!allFiles.size) return null

  return [
    "You are the TDD ARCHITECT agent for a production-grade parallel coding pipeline.",
    "Your job: create TEST FILES FIRST to define the contract, then implementation scaffolds with inline blueprints.",
    "",
    "## Objective",
    objective,
    "",
    "## Task plan:",
    JSON.stringify(taskSpecs, null, 2),
    "",
    "## TDD Workflow (strict order)",
    "",
    "For EACH planned source file, create TWO files in this order:",
    "",
    "### Step 1: Test File",
    "- Create the test file BEFORE the implementation file",
    "- Write concrete test cases derived from the task's acceptance criteria",
    "- Each test must have: descriptive name, setup, action, assertion",
    "- Cover: happy path, error cases, edge cases (null/empty/invalid input), boundary conditions",
    "- Tests should be runnable but FAIL (because implementation is a stub)",
    "- Import the source module using the correct relative path",
    "",
    "### Step 2: Implementation Scaffold",
    "- Create the source file with full signatures + numbered step comments (same as normal scaffold)",
    "- Functions should have minimal stub bodies (throw or return placeholder) so tests can import them",
    "",
    "## Test File Naming Convention",
    "- JS/TS: `<name>.test.mjs` or `<name>.spec.ts` (match project convention)",
    "- Python: `test_<name>.py` in same directory or `tests/` directory",
    "- Check existing test files in the project to match the convention",
    "",
    "## Completion",
    "When ALL files (tests + stubs) are created, say [SCAFFOLD_COMPLETE].",
    "",
    "Start now. Create test files first, then implementation stubs."
  ].join("\n")
}

export async function runScaffoldPhase({
  objective,
  stagePlan,
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  agent = null,
  signal = null,
  toolContext = {},
  tddMode = false
}) {
  const prompt = tddMode
    ? buildTddScaffoldPrompt(objective, stagePlan)
    : buildScaffoldPrompt(objective, stagePlan)
  if (!prompt) {
    return { scaffolded: false, fileCount: 0, files: [], errors: [] }
  }

  const out = await processTurnLoop({
    prompt,
    mode: "agent",
    model,
    providerType,
    sessionId,
    configState,
    baseUrl,
    apiKeyEnv,
    agent,
    signal,
    allowQuestion: false,
    toolContext
  })

  // Extract files created from tool events
  const createdFiles = (out.toolEvents || [])
    .filter((e) => e.name === "write" && e.status === "completed")
    .map((e) => e.args?.path)
    .filter(Boolean)

  // Verify files actually exist on disk
  const verified = []
  const missing = []
  for (const file of createdFiles) {
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file)
    try {
      await stat(abs)
      verified.push(file)
    } catch {
      missing.push(file)
    }
  }

  return {
    scaffolded: true,
    fileCount: verified.length,
    files: verified,
    missingFiles: missing,
    usage: out.usage,
    toolEvents: out.toolEvents,
    errors: missing.length > 0
      ? [`${missing.length} file(s) reported created but not found on disk: ${missing.slice(0, 5).join(", ")}`]
      : []
  }
}
