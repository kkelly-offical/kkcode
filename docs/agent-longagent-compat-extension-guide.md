# kkcode Agent / LongAgent Compatibility Extension Guide

This guide documents the public-facing extension contract for the approved compatibility catch-up work. It is intentionally compatibility-first: keep LongAgent as the structured implementation lane, and add narrower delegation + packaging improvements around it.

## 1. Keep the product split explicit

`kkcode` now has two different but complementary execution shapes:

1. **LongAgent** — the default lane for structured multi-file implementation with explicit stage plans, file ownership, retries, and gates.
2. **Delegated `task` work** — the lighter-weight lane for bounded sidecar work such as research, audits, focused refactors, or background verification.

Do **not** treat the delegated task lane as a replacement for LongAgent. If a job needs file ownership planning, stage gating, or coordinated retries, prefer LongAgent.

## 2. Extension surfaces and what they are for

Use the smallest extension surface that matches the job.

| Surface | Intended location | Use for | Notes |
| --- | --- | --- | --- |
| Command templates | `.kkcode/commands/` | reusable Markdown command templates | User-facing slash command helpers |
| Skills | `.kkcode/skills/` | reusable prompts, programmable helpers, `SKILL.md` directories | Supports `.md`, `.mjs`, and directory-format `SKILL.md` |
| Custom agents | `.kkcode/agents/` | specialized delegated agents | YAML, YML, MJS, or Markdown frontmatter files |
| Dynamic tools | `.kkcode/tools/` | local tool extensions | Loaded independently from skills and agents |
| Hooks | `.kkcode/hooks/` | chat/tool/session event hooks | Runtime hook bus currently resolves hooks from this path |
| MCP config | `.mcp.json` plus configured registries | external MCP servers/prompts/tools | Separate from plugin packaging |
| Plugin package (MVP) | `.kkcode-plugin/plugin.json` or `.kkcode/plugins/<name>/plugin.json` | bundle skills/agents/hooks/MCP fragments under one package boundary | Manifest should compose existing loaders, not replace them |

### Important contract note

Historically, some docs and UI strings referred to `.kkcode/plugins/` as the hook path. The runtime hook loader resolves `.kkcode/hooks/`. Release notes and user-facing docs should present **hooks** and **plugin packages** as different concepts:

- `.kkcode/hooks/` → hook scripts
- `.kkcode/plugins/<name>/plugin.json` (or `.kkcode-plugin/plugin.json`) → manifest-defined package boundary

## 3. Delegation contract for the `task` tool

The compatibility work should make delegation rules explicit instead of leaving them implicit in examples.

### Stay local when

- the next step is tightly coupled to the current reasoning thread
- the task is a small direct edit or a single file operation
- you need immediate blocking work for the next action
- the work would spend more time on handoff than execution

### Delegate with a fresh agent when

- the work is self-contained
- you want isolation from the current conversation state
- the task is implementation-heavy, long-running, or noisy
- you want a specialist subagent prompt

### Delegate with forked context when

- the work is a sidecar research/audit/verification lane
- inherited context materially reduces briefing overhead
- the result should inform the parent session, not replace it
- LongAgent would be too heavy for the subtask

### Run in background when

- the result is not required for the immediate next step
- the task is long-running or log-heavy
- you have a concrete follow-up plan for checking status/result later

### Non-negotiable delegation rules

- Do not delegate simple `read`, `write`, `edit`, `glob`, or one-shot shell work.
- Do not fabricate a delegated result before the subagent finishes.
- Do not “peek” and then guess the unfinished outcome.
- Do not delegate understanding that the parent agent must own.
- Do not launch parallel delegated work that races on the same files without explicit isolation.
- When background work is launched, report how to retrieve status/result deterministically.

## 4. Skill compatibility contract

`kkcode` already supports plain Markdown skills, programmable `.mjs` skills, and directory-format `SKILL.md` skills. Compatibility work should extend this surface carefully.

### Support levels

Use three buckets when documenting frontmatter fields:

1. **Enforced** — affects runtime behavior and is covered by tests.
2. **Accepted but ignored** — parsed for compatibility but intentionally not acted on in v1.
3. **Rejected** — fails clearly because acting on it would imply unsupported runtime semantics.

### Recommended v1 mapping

| Field | v1 support level | Notes |
| --- | --- | --- |
| `name` | Enforced | Canonical command/skill name |
| `description` | Enforced | User-facing description |
| `model` | Enforced | Optional model override |
| `allowed-tools` | Enforced | Existing safe mapping |
| `user-invocable` | Enforced | Existing safe mapping |
| `disable-model-invocation` | Enforced | Existing safe mapping |
| `context-fork` | Enforced | Existing safe mapping |
| `when_to_use` | Enforced or accepted-but-ignored | Safe to surface in prompt/help text |
| `arguments` / `argument-hint` | Accepted-but-ignored unless wired into execution UX | Useful for compatibility metadata |
| `agent` / `subagent_type` binding | Accepted-but-ignored or lightly enforced | Only if it maps to current task routing safely |
| `effort` | Accepted-but-ignored | Do not promise runtime scheduling guarantees unless implemented |
| `shell` blocks | Rejected unless sandbox and policy semantics are explicit | Too easy to imply unsupported execution power |
| hook registration from skill frontmatter | Rejected for MVP | Keep hooks as an explicit separate extension surface |

### Skill root contract

If a skill is loaded from a directory with `SKILL.md`, that directory is the skill root.

- Auxiliary files should resolve relative to that root.
- `$FILE{...}` references must stay inside the skill root.
- Imported compatibility skills should not rely on implicit cwd-relative asset lookup.

## 5. Plugin manifest MVP

The plugin manifest MVP should create a package boundary without importing marketplace-scale complexity.

### Goals

- Bundle skills, agents, hooks, and optional MCP fragments under one directory.
- Reuse existing loaders internally.
- Prevent silent capability expansion.
- Keep loose-file loading working for non-plugin users.

### Suggested directory shapes

```text
.kkcode-plugin/
  plugin.json
  skills/
  agents/
  hooks/
  mcp/
  assets/
```

or

```text
.kkcode/plugins/<name>/
  plugin.json
  skills/
  agents/
  hooks/
  mcp/
  assets/
```

### Suggested manifest MVP

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "skillsDir": "skills",
  "agentsDir": "agents",
  "hooksDir": "hooks",
  "mcpConfig": "mcp/servers.json",
  "capabilities": {
    "skills": true,
    "agents": true,
    "hooks": true,
    "mcp": true
  }
}
```

### Security and precedence boundaries

- Manifest-declared directories should be the only plugin-loaded extension roots for that package.
- Plugin agents should not silently widen permissions beyond the manifest boundary.
- Duplicate names should have deterministic precedence or fail loudly.
- Plugin packages should compose with loose project/global extensions; they should not shadow them unpredictably.

## 6. Migration notes

For existing local setups, prefer the following migration story:

- If you currently keep hook scripts under `.kkcode/hooks/`, no migration is needed.
- If you documented or taught `.kkcode/plugins/` as a hook path, update that guidance: hooks belong in `.kkcode/hooks/`.
- If you want package-style composition, introduce `plugin.json` under `.kkcode-plugin/` or `.kkcode/plugins/<name>/` and keep hook files inside the package's declared `hooks/` directory.
- Avoid mixing loose hook scripts and manifest package semantics under the same undocumented path layout.

This should be presented as a terminology cleanup plus a forward-compatible package boundary, not as a breaking rewrite.

## 7. Release checklist for this compatibility slice

Before calling the compatibility work complete, confirm:

- docs say `.kkcode/hooks/` for hooks and reserve `.kkcode/plugins/` for package-style plugins
- task/delegation docs explain stay-local vs fresh-agent vs forked-context vs background rules
- skill docs say which imported frontmatter fields are enforced vs ignored vs rejected
- plugin docs describe the MVP as **local package support**, not a marketplace system
- LongAgent docs still describe it as the preferred lane for structured multi-file implementation

## 8. What should remain out of scope for this release

- marketplace install/update flows
- remote plugin distribution
- a Claude-style unified team/task runtime rewrite
- implicit privilege escalation for plugin-provided agents
- undocumented frontmatter fields that appear to work accidentally
