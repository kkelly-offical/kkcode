/**
 * Ultra 阶段提示词与阶段完成标记。
 *
 * 0.3.x 这些函数住在 longagent-4stage.mjs 里，但 hybrid 实现同样依赖它们。
 * 0.4.0 删除 4stage 实现后，这里成为阶段措辞的唯一来源。
 */

export const ULTRA_STAGES = {
  PREVIEW: "preview",
  BLUEPRINT: "blueprint",
  CODING: "coding",
  DEBUGGING: "debugging"
}

export function detectStageComplete(text, stage) {
  const str = String(text || "")
  const markers = {
    [ULTRA_STAGES.PREVIEW]: /\[STAGE 1\/4: PREVIEW(?:ING AGENT)? - COMPLETE\]/,
    [ULTRA_STAGES.BLUEPRINT]: /\[STAGE 2\/4: BLUEPRINT(?:\s+AGENT)? - COMPLETE\]/,
    [ULTRA_STAGES.CODING]: /\[STAGE 3\/4: CODING(?:\s+AGENT)? - COMPLETE\]/,
    [ULTRA_STAGES.DEBUGGING]: /\[STAGE 4\/4: DEBUGGING(?:\s+AGENT)? - COMPLETE\]/
  }
  return markers[stage] ? markers[stage].test(str) : false
}

export function detectReturnToCoding(text) {
  return /\[RETURN TO STAGE 3/.test(String(text || ""))
}

export function buildStageWrapper(stage, context, userPrompt, warningMsg = null) {
  const stageInfo = {
    [ULTRA_STAGES.PREVIEW]: { num: "1/4", name: "PREVIEW", focus: "Explore project, understand requirements, extract key information", readonly: true },
    [ULTRA_STAGES.BLUEPRINT]: { num: "2/4", name: "BLUEPRINT", focus: "Detailed planning, architecture design, function definitions", readonly: true },
    [ULTRA_STAGES.CODING]: { num: "3/4", name: "CODING", focus: "Implement code strictly according to blueprint", readonly: false },
    [ULTRA_STAGES.DEBUGGING]: { num: "4/4", name: "DEBUGGING", focus: "Verify implementation, test, debug, validate completion", readonly: false }
  }
  const info = stageInfo[stage]
  const parts = [
    `=== LONGAGENT STAGE ${info.num}: ${info.name} ===`,
    "",
    `# STAGE OBJECTIVE: ${info.focus}`,
    "",
    `IMPORTANT: You are in STAGE ${info.num} of the four-stage LongAgent workflow.`,
    ""
  ]

  if (info.readonly) {
    parts.push(
      "## PERMISSION CONSTRAINTS",
      "YOU ARE IN READ-ONLY MODE FOR THIS STAGE.",
      "- You MAY use: read, glob, grep, list, bash, question, todowrite",
      "- You MUST NOT use: write, edit, patch, or any file modification tools",
      ""
    )
  }

  parts.push("## YOUR TASKS FOR THIS STAGE:")
  if (stage === ULTRA_STAGES.PREVIEW) {
    parts.push(
      "### 1. Project Structure Discovery",
      "- Use glob to map the FULL directory tree (src/, test/, config/, scripts/, etc.)",
      "- Identify the build system (package.json scripts, Makefile, Cargo.toml, etc.)",
      "- Identify the test framework and test file naming convention",
      "- Read the entry point(s) and trace the module dependency graph",
      "",
      "### 2. Technology Stack Audit",
      "- Read package.json / requirements.txt / go.mod to catalog ALL dependencies",
      "- Identify the runtime version constraints (engines, python_requires, etc.)",
      "- Note the code style: ESM vs CJS, TypeScript vs JS, async patterns, error handling conventions",
      "- Check for existing linter/formatter config (.eslintrc, .prettierrc, pyproject.toml)",
      "",
      "### 3. Requirement Decomposition",
      "- Break the user objective into discrete, testable sub-requirements",
      "- For each sub-requirement, identify which existing modules are affected",
      "- Flag any ambiguities or missing information that could cause parallel agents to conflict",
      "- Identify external API contracts, data schemas, or protocols involved",
      "",
      "### 4. Reuse & Risk Assessment",
      "- List existing utilities, helpers, and abstractions that MUST be reused (do NOT reinvent)",
      "- Identify files that are heavily imported — changes to these have high blast radius",
      "- Note any existing tests that cover the affected modules (these must not regress)",
      "- Flag potential conflicts: concurrent file access, circular dependencies, breaking API changes",
      "",
      "### 5. Output Format",
      "Produce a structured findings report with these sections:",
      "- **Tech Stack**: runtime, framework, key dependencies, build tool",
      "- **Affected Modules**: list of files/directories that will be touched",
      "- **Reusable Assets**: existing code to leverage",
      "- **Risks**: potential issues, breaking changes, high-blast-radius files",
      "- **Sub-requirements**: numbered list of discrete tasks derived from the objective"
    )
  } else if (stage === ULTRA_STAGES.BLUEPRINT) {
    parts.push(
      "### 1. Architecture Design",
      "- Define the module boundaries: which new files to create, which existing files to modify",
      "- For each new module: purpose, public API (exported functions/classes with signatures), internal structure",
      "- For each modified module: what changes, what stays, backward compatibility impact",
      "- Draw the dependency graph: A imports B, B imports C — ensure no circular dependencies",
      "",
      "### 2. Interface Contracts",
      "- Define ALL function signatures with parameter types and return types",
      "- Define data structures / schemas (object shapes, DB schemas, API request/response formats)",
      "- Specify error types: what errors can each function throw, how callers should handle them",
      "- Define event contracts if using pub/sub or EventEmitter patterns",
      "",
      "### 3. File Ownership & Parallelization Plan",
      "- Assign every file to exactly ONE task (no file may appear in multiple tasks)",
      "- Files that import each other MUST be in the same task",
      "- A module and its test file MUST be in the same task",
      "- Each task should own 2-8 files. Split or merge if outside this range",
      "- Order tasks into stages: infrastructure → core logic → integration → validation",
      "",
      "### 4. Acceptance Criteria",
      "- Every task MUST have machine-verifiable acceptance criteria",
      "- Valid: 'node --check src/foo.mjs passes', 'npm test -- --grep auth passes', 'function X is exported from Y'",
      "- Invalid: 'code is clean', 'implementation is correct', 'works as expected'",
      "- The FINAL task must include: 'all modified files parse without errors AND project builds AND tests pass'",
      "",
      "### 5. Edge Cases & Error Handling Strategy",
      "- List edge cases for each major function (null input, empty arrays, concurrent access, network failure)",
      "- Define the error propagation strategy: throw vs return error vs log-and-continue",
      "- Specify retry/fallback behavior for external dependencies",
      "- Define resource cleanup requirements (file handles, timers, connections)"
    )
  } else if (stage === ULTRA_STAGES.CODING) {
    parts.push(
      "### 1. Implementation Discipline",
      "- Follow the blueprint from Stage 2 EXACTLY — do not deviate from the agreed architecture",
      "- Read existing files BEFORE modifying them — never edit blind",
      "- When modifying a function, grep for all callers to ensure you update call sites",
      "- When adding imports, verify the target module exists and exports the symbol",
      "",
      "### 2. Code Quality Standards",
      "- Match the project's existing code style (indentation, naming, async patterns, error handling)",
      "- Add error handling at system boundaries (user input, external APIs, file I/O, network calls)",
      "- Do NOT add unnecessary abstractions, wrappers, or 'just in case' code",
      "- Do NOT add comments that restate the code — only comment non-obvious logic",
      "- Ensure all resources are properly cleaned up (timers cleared, listeners removed, handles closed)",
      "",
      "### 3. Testing Requirements",
      "- If the blueprint includes test files, implement them with concrete assertions (not placeholder TODOs)",
      "- Tests must cover: happy path, error cases, edge cases, boundary conditions",
      "- Run `node --check` (or equivalent) on every file you create or modify",
      "- If a test framework exists, run the relevant test suite to verify no regressions",
      "",
      "### 4. Integration Verification",
      "- After implementing, verify imports resolve correctly across all modified files",
      "- Check that exported APIs match the signatures defined in the blueprint",
      "- If modifying shared modules, verify all downstream consumers still work",
      "",
      "### 5. Progress Reporting",
      "- After completing each logical unit, briefly state what was done and what remains",
      "- If you encounter a blocker not covered by the blueprint, document it clearly",
      "- If you discover the blueprint has an error, fix it and note the deviation"
    )
  } else if (stage === ULTRA_STAGES.DEBUGGING) {
    parts.push(
      "### 1. Systematic Verification Protocol",
      "- Run syntax checks on ALL modified/created files (node --check, python -m py_compile, etc.)",
      "- Run the full test suite — not just new tests, ALL tests to catch regressions",
      "- If build system exists (npm run build, make, cargo build), run it and verify success",
      "- Check for TypeScript type errors if tsconfig.json exists (npx tsc --noEmit)",
      "",
      "### 2. Functional Validation",
      "- Trace through each sub-requirement from the blueprint and verify it is implemented",
      "- For each public API: verify the function exists, has correct signature, handles edge cases",
      "- Test error paths: pass invalid input, simulate failures, verify error messages are helpful",
      "- Verify resource cleanup: no timer leaks, no unclosed handles, no dangling event listeners",
      "",
      "### 3. Integration Testing",
      "- Verify cross-module imports resolve correctly",
      "- If the implementation involves multiple stages, verify the data flow end-to-end",
      "- Check for race conditions in async code (concurrent access, Promise.all error handling)",
      "- Verify backward compatibility: existing callers of modified APIs still work",
      "",
      "### 4. Issue Resolution",
      "- For each failing test: read the error, identify root cause, fix it, re-run to confirm",
      "- Do NOT suppress errors or skip tests — fix the underlying issue",
      "- If a fix requires architectural changes, output [RETURN TO STAGE 3: CODING] with details",
      "- Track all issues found and their resolutions",
      "",
      "### 5. Completion Report",
      "When ALL checks pass, provide:",
      "- **Summary**: what was implemented (1-3 sentences)",
      "- **Files changed**: list of created/modified files",
      "- **How to verify**: exact commands to run (build, test, lint)",
      "- **Usage**: how to use the new feature (API examples, CLI commands, config)",
      "- **Known limitations**: anything not covered or deferred"
    )
  }

  parts.push("", "## STAGE COMPLETION", `When you have completed this stage, end your response with:`, "```", `[STAGE ${info.num}: ${info.name} - COMPLETE]`, "```")

  if (context.preview && stage !== ULTRA_STAGES.PREVIEW) {
    parts.push("", "=== PREVIEW STAGE CONTEXT ===", context.preview)
  }
  if (context.blueprint && (stage === ULTRA_STAGES.CODING || stage === ULTRA_STAGES.DEBUGGING)) {
    parts.push("", "=== BLUEPRINT STAGE CONTEXT ===", context.blueprint)
  }
  if (context.coding && stage === ULTRA_STAGES.DEBUGGING) {
    parts.push("", "=== CODING STAGE OUTPUT ===", context.coding)
  }

  if (warningMsg) {
    parts.push("", "=== WARNING ===", warningMsg, "")
  }

  parts.push("", "=== USER OBJECTIVE ===", userPrompt)
  return parts.join("\n")
}
