import { processTurnLoop } from "./loop.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

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
    "You are the ARCHITECT agent. Your job is to create ALL project files with detailed inline comments that guide parallel implementation agents.",
    "",
    "## Objective",
    objective,
    "",
    "## Files to create:",
    ...fileContext,
    "",
    "## Task plan (each task will be assigned to an independent sub-agent):",
    JSON.stringify(taskSpecs, null, 2),
    "",
    "## What to write in each file",
    "",
    "You must create EVERY file listed above using the `write` tool. Each file should contain:",
    "",
    "### 1. File header comment",
    "- Purpose of this file in one sentence",
    "- Which other files it depends on (imports from)",
    "- Which other files depend on it (imported by)",
    "- Which task/stage owns this file",
    "",
    "### 2. Import statements",
    "- Write ALL import/require statements with correct paths to other project files",
    "- This makes the dependency graph explicit for sub-agents",
    "",
    "### 3. Inline implementation comments (THIS IS THE CORE)",
    "For every function, class, component, route, handler, etc.:",
    "- Write the signature/declaration (function name, params, return type)",
    "- Inside the body, write DETAILED comments describing:",
    "  - The algorithm / logic flow step by step",
    "  - Input validation and edge cases to handle",
    "  - Error handling strategy (what to catch, what to throw)",
    "  - Data transformations and their expected shapes",
    "  - Integration points (API calls, DB queries, event emissions)",
    "  - Performance considerations if any",
    "",
    "### 4. What NOT to do",
    "- Do NOT write actual business logic / implementation code",
    "- Do NOT write placeholder `pass` or `// TODO` without detail",
    "- Do NOT skip files — every file must be created",
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
    "## Tool usage",
    "- USE `write` to create each file — this is your primary tool",
    "- USE `read` ONLY if you need to check an existing file that is NOT in the file list (e.g. package.json, existing config)",
    "- Do NOT use `edit`, `bash`, `grep`, or `glob` — you are creating new files, not modifying existing ones",
    "",
    "## Completion",
    "When ALL files are created, say [SCAFFOLD_COMPLETE].",
    "",
    "Start now. Create files one by one."
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
  toolContext = {}
}) {
  const prompt = buildScaffoldPrompt(objective, stagePlan)
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

  return {
    scaffolded: true,
    fileCount: createdFiles.length,
    files: createdFiles,
    usage: out.usage,
    toolEvents: out.toolEvents,
    errors: []
  }
}
