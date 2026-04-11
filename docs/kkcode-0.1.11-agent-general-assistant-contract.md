# kkcode 0.1.11 Agent / CLI General Assistant Contract

This document records the **shipped public contract** for the 0.1.11 slice approved in:

- `.omx/plans/prd-kkcode-0.1.11-agent-general-assistant.md`
- `.omx/plans/test-spec-kkcode-0.1.11-agent-general-assistant.md`
- `docs/cli-general-assistant-capability-matrix.md`

It is intentionally release-facing rather than aspirational: it describes what users and extenders can rely on now, and it makes the out-of-scope edges explicit.

## 1. Scope of the 0.1.11 slice

The committed 0.1.11 slice covers five areas:

1. **Routing + agent-mode tolerance foundation**
2. **Interruption compliance core**
3. **Delegation contract minimum slice** tightly coupled to routing/interruption
4. **CLI general assistant capability boundary**
5. **Compatibility/docs updates** required for the shipped behavior

Hard boundaries for this slice:

- CLI-first only
- keep LongAgent as the structured multi-file implementation lane
- no IDE-first workflow
- no marketplace / remote bridge / platform rewrite
- no GUI/desktop automation promise

## 2. Release matrix

| Area | Shipped user-facing contract | Current boundary |
| --- | --- | --- |
| Routing | `ask` / `plan` / `agent` / `longagent` routing remains explicit and reasoned; TUI shows why an automatic switch happened | Not a learned router; still heuristic/rule-driven |
| Interruption | `Esc` / busy `Ctrl+C` interrupts the current turn without killing the session; users can continue with a new message | No remote/team-wide interrupt fabric promised in this slice |
| Background work | Background delegated tasks resolve to deterministic terminal states: `completed`, `cancelled`, `error`, `interrupted` | Background status is task-centric, not a full remote runtime |
| Delegation | `fresh_agent` default, `fork_context` for sidecar context inheritance, `background_output` / `background_cancel` for deterministic follow-up | Delegated work is not a LongAgent replacement |
| Compatibility | Hooks and plugin packages are documented as different surfaces; skill frontmatter support levels are explicit | No marketplace/update/install platform in v1 |

## 3. Routing contract

`kkcode` should feel more tolerant in everyday CLI use without weakening LongAgent.

### Public routing rules

- **Short question / explanation request** → prefer `ask`
- **Small direct action** (single fix / run / edit / check) → prefer `agent`
- **Complex multi-file / system-level work** → prefer `longagent`
- **Short planning/design request** → `plan`

### Transparency contract

When TUI auto-switches modes, it prints the routing reason instead of silently changing behavior. Typical reason tags include:

- `short_question`
- `question_with_explain_intent`
- `simple_action_task`
- `multi_file_or_system_task`
- `long_complex_prompt`

### What this does **not** mean

- It does **not** promise a learned scoring router yet.
- It does **not** make LongAgent optional for structured multi-file delivery.
- It does **not** mean long prompts automatically become LongAgent if the task is still lightweight.

## 4. Interruption compliance core

The 0.1.11 contract is about making interruption predictable in the CLI.

### Foreground turn behavior

- `Esc` interrupts the current turn
- busy `Ctrl+C` behaves the same way
- the session stays alive
- the user can immediately enter a new message or command

### LongAgent behavior

- interrupting LongAgent pauses the active run rather than pretending it completed
- after interruption, the user can add requirements and re-enter planning
- this slice preserves LongAgent as the heavyweight path; it does not downgrade it into a generic delegated task runner

### Background task terminal states

| State | Meaning |
| --- | --- |
| `completed` | worker finished and saved a terminal result |
| `cancelled` | user/system cancellation was acknowledged |
| `error` | task failed with a non-interrupt error |
| `interrupted` | worker timed out, exited unexpectedly, became orphaned, or was aborted mid-run |

The important public guarantee is **deterministic status**, not “watch logs and guess”.

## 5. Delegation contract minimum slice

The `task` tool remains a bounded delegation surface.

### Use the four execution shapes explicitly

1. **Stay local** — direct read/edit/run work the parent can do immediately
2. **`fresh_agent`** — the default for self-contained delegated work
3. **`fork_context`** — inherit the parent transcript only when it materially reduces briefing overhead for sidecar research/audit/verification
4. **Background delegated work** — use only when the result is not needed for the immediate next action

### Non-negotiable delegation rules

- do not delegate one-shot file operations
- do not fabricate child completion
- do not peek at unfinished background/forked work and summarize it as done
- do not delegate understanding the parent must own
- do not race overlapping delegated edits on the same files

### Result retrieval contract

If background work is launched, the deterministic follow-up path is:

- `background_output` → inspect status / logs / result
- `background_cancel` → cancel a running task

This is the minimum shipped contract for “delegation ergonomics” in 0.1.11.

## 6. Compatibility matrix

### Hooks vs plugin packages

These are separate concepts:

- `.kkcode/hooks/` → hook scripts
- `.kkcode-plugin/plugin.json` or `.kkcode/plugins/<name>/plugin.json` → package-style plugin manifest boundary

Do not document `.kkcode/plugins/` as the loose hook path.

### Skill frontmatter support levels

The 0.1.11 docs use three support buckets:

1. **Enforced**
2. **Accepted but ignored**
3. **Rejected**

This matters because compatibility should not imply unsupported runtime guarantees.

## 7. CLI general assistant capability boundary

The 0.1.11 public contract explicitly treats kkcode as a **terminal-native general assistant**, not just a code mutator.

Users can rely on these terminal-first capability lanes:

- coding and patching
- local filesystem / config / log inspection
- shell execution
- repo / release assistance
- web lookup / fetch
- bounded delegated sidecar work

The authoritative release-facing matrix is documented in:

- `docs/cli-general-assistant-capability-matrix.md`

This boundary matters because it expands “what kkcode is for” without implying GUI automation, IDE integration, or remote platform surfaces.

## 8. Explicit non-goals

The following are still out of scope for this release slice:

- IDE integration
- GUI / desktop automation promises
- marketplace install/update flows
- remote bridge/platform rewrites
- weakening LongAgent ownership/stage discipline

## 9. Release-ready checklist

Treat this slice as documented correctly only when all of the following stay true:

- routing remains explainable in the TUI
- interruption leaves the session recoverable
- background delegated work has deterministic terminal states
- `fork_context` is positioned as a sidecar lane, not a LongAgent substitute
- docs keep hooks and plugin packages distinct
- docs keep the CLI general assistant boundary explicit and non-GUI
- compatibility notes do not promise GUI/platform features that are not shipped
