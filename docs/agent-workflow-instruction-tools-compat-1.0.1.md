# Agent workflow, instruction following and tools compatibility review (1.0.1)

Mission M28. This review compares the kkcode agent workflow (kernel agent /
orchestration / tool / skill / MCP / plugin) against three public reference
implementations and turns every gap into either a fix landed in this branch or
a tracked follow-up.

Preview.2 completion: the previously deferred G10–G12 and remaining G4/G9
execution work are now implemented below. Original comparisons/inventory are
historical baselines, not a claim that preview.1 already shipped these fixes.
The current public contract is [tool discovery and skills](tool-discovery-and-skills.md).

## References and how they were compared

| Reference | What was examined | Evidence |
| --- | --- | --- |
| Kimi Code CLI (`MoonshotAI/kimi-code`, MIT) | Tool taxonomy and per-tool semantics (`docs/en/reference/tools.md`), repo layout of `packages/agent-core` (profiles, per-tool `*.md` descriptions, permission policies, plugin/marketplace, skill parser/registry) | GitHub repo, fetched 2026-09-22 |
| OpenAI Codex (`openai/codex`, Apache-2.0) | `codex-rs/core` GPT-5 system prompt (`gpt_5_codex_prompt.md`), tool handler layout (`core/src/tools/handlers/*`), deferred tool discovery (`tool_search`, BM25 over deferred tool metadata) | GitHub repo, fetched 2026-09-22 |
| ZCode (Z.ai / Zhipu) | Public product docs only. ZCode is a closed-source desktop ADE; no auditable open-source harness repository exists, so claims are limited to its published capability surface (goal mode, 20+ tools, confirmation gates) | https://zcode.z.ai/en/docs |

No third-party code was copied; the references were used for contrast only.

## kkcode inventory (as of this branch, base `main` @ 1.0.1-preview.0)

- **Builtin tools**: 42 (`list`, `sysinfo`, `read`, `write`, `edit`, `patch`,
  `multiedit`, `glob`, `grep`, `bash`, `task`, `task_group`,
  `background_output`, `background_cancel`, `task_list`, `task_parallel`,
  `task_get`, `task_stop`, `task_output`, `todowrite`, `question`, `skill`,
  `webfetch`, `http_request`, `websearch`, `codesearch`, `notebookedit`,
  `enter_plan`, `exit_plan`, `move`, `copy`, `remove`, `mkdir`, `archive`,
  `git_snapshot`, `git_restore`, `git_list_snapshots`, `git_apply_patch`,
  `git_info`, `git_status`, `git_delete_snapshot`, `git_cleanup`).
- **System prompt**: layered blocks (provider → agent → mode → tools →
  output strategy → assistant contract → mode contract → skills → subagents →
  project → language → memory → env → user), assembled in
  `src/kernel/session/system-prompt.mjs`.
- **Skills**: builtin `.mjs`, custom commands, `.md`, SKILL.md directories,
  plugin skills, MCP prompts — with Claude/Codex-compatible frontmatter parsing.
- **MCP**: stdio, HTTP, SSE, streamable-http and legacy-sse transports;
  per-server health, circuit breaking, prompts→skills conversion.
- **Plugins**: `plugin.json` manifests (kkcode / `.claude-plugin` /
  `.codex-plugin` layouts), skills/hooks/agents/MCP components, npm/git/local
  install with trust metadata.

## Gap list

Severity: P1 = hurts instruction following or breaks a promised compatibility
surface, P2 = drift/UX risk, P3 = follow-up.

### G1 (P1, fixed here) — the system prompt contradicts itself on large writes

Three different rules coexisted in one prompt:

- `build.txt` / `qwen.txt` / `beast.txt`: "include ALL content in a single
  `write` call. Do NOT split into multiple writes."
- `anthropic.txt`: "For large file creation (200+ lines): use `write` with
  mode=append to build incrementally."
- the always-on `output_strategy` block: "write no more than 200 lines per
  tool call; use append mode for subsequent chunks."

A model cannot satisfy all three; it picks one at random per session. Fixed by
one canonical rule (single `write` by default; chunk via `append` only when the
content is genuinely too large for one call) in `build.txt`, the provider
prompts, and the `output_strategy` block.

### G2 (P1, fixed here) — the same rule is repeated up to five times

"Never use `bash` to read/search/write files" appeared in `anthropic.txt`,
`qwen.txt`, `beast.txt`, `build.txt` and `bash.txt`. The git-commit protocol
appeared three times (`anthropic.txt`, `build.txt`, `bash.txt`). The
long-running-command rule appeared four times. Repetition dilutes attention
and every copy can drift — they already had (the foreground-blocking lists and
the escape hatch wording differed per copy). Fixed by keeping one canonical
copy per rule:

- tool-selection and shell rules live in `bash.txt` (loaded in every mode,
  next to the tool they govern);
- provider prompts keep only provider-specific guidance (identity, tone,
  security posture, environment notes) plus the always-on verification rule;
- `build.txt` keeps workflow-level rules (read-before-edit, planning, task
  management, anti-patterns).

### G3 (P1, fixed here) — plugin `agents` component is parsed but never loaded

`plugin.json` accepts `agents` / `components.agents`
(`src/kernel/plugin/manifest-loader.mjs:195`) and normalizes them into
`plugin.agents` dirs, but no loader ever consumed them —
`custom-agent-loader.mjs` only read `~/.kkcode/agents` and
`.kkcode/agents`. A portable Claude/Codex plugin shipping agents silently
shipped nothing. Fixed: `CustomAgentRegistry.initialize` now loads agent
definitions from plugin agent directories (markdown frontmatter agents) and
clamps each plugin agent's permission to the plugin manifest's declared
`capabilities.allowedAgentPermissions` (previously parsed, never enforced).

### G4 (P1, fixed here) — skill frontmatter flags parsed but not enforced

- `disable-model-invocation: true` hid a skill from the system prompt listing
  but the `skill` tool would still execute it if the model guessed the name
  (Kimi Code rejects these at the tool boundary). Fixed: the `skill` tool now
  refuses `disable-model-invocation` skills with a clear message.
- `user-invocable: false`: completed in preview.2 at the registry, REPL,
  headless and remote command paths; omitted from user completion.
- `allowed-tools`: completed in preview.2 as intersecting per-turn tool
  restrictions, checked both in advertising and before execution and inherited
  by foreground/background delegates. Ordinary permissions still apply. This
  is not an OS sandbox for trusted arbitrary JavaScript plugin code.

### G5 (P1, fixed here) — MCP tool ids are not provider-safe and can collide

`normalizeTool` built ids as `mcp_${serverName}_${tool.name}` with no
sanitization (`src/kernel/mcp/registry.mjs`). Server names containing dots,
spaces or CJK characters produced tool ids rejected by provider APIs (OpenAI
and Anthropic both require `^[a-zA-Z0-9_-]{1,64}$`), and
`mcp_a_b` (server `a`, tool `b`) collided with `mcp_a_b` (server `a_b`,
tool …). Fixed: ids are sanitized to the provider-safe alphabet, truncated to
64 chars with a stable hash suffix, and collisions after sanitization get a
deterministic counter plus a registry diagnostic.

### G6 (P2, fixed here) — the `# Available Tools` block is one flat list

42 builtin tools plus MCP tools were rendered in registration order. Kimi Code
publishes a grouped taxonomy (File / Shell / Web / Plan / State /
Collaboration / Background / Cron) and Codex keeps the base surface minimal.
Fixed: the tools block now renders under stable group headers (File, Search,
Shell & system, Web, Planning & state, Delegation & background, Git, Notebook,
Skills, MCP), unknown tools fall into an explicit trailing group, and a test
pins both the grouping and full coverage.

### G7 (P2, fixed here) — duplicate background/task tools with misleading docs

`background_output`, `task_get` and `task_output` returned byte-identical
payloads; `background_cancel` and `task_stop` are the same operation. Their
descriptions also claimed they "only work on tasks launched via `task`",
which was never true (`bash` `run_in_background` lands in the same manager).
Removing tools from the registered surface would break the shipped tool
contract for 1.0.1, so instead: descriptions now state the alias relationship
and the canonical name (`task_output` / `task_stop`), and the prompt grouping
keeps the families together. Preview.2 additionally consolidates the default
model-visible surface while retaining registered legacy aliases (G12).

### G8 (P2, fixed here) — inconsistent parameter naming inside one schema

`grep` mixed camelCase (`maxCount`, `ignoreCase`) with snake_case
(`output_mode`, `head_limit`) in the same input schema. Mixed conventions make
models guess wrong on adjacent tools. Fixed: the schema advertises snake_case
(`max_count`, `ignore_case`); the legacy camelCase keys are still accepted as
silent aliases so existing prompts and saved sessions do not regress.

### G9 (P2, completed in preview.2) — compact task schema

The `task` schema mixes brief fields, routing fields, budgeting fields and
lifecycle fields. Kimi Code's `Agent` tool ships 7. Fully slimming it breaks
existing structured-brief consumers, so preview.2 keeps the legacy flat schema
callable but advertises seven common fields plus a typed `brief` object. Brief
values are normalized before delegation; explicit flat fields take precedence.

### G10 (completed in preview.2) — deferred tool discovery

Codex exposes `tool_search` (BM25 over deferred MCP tool metadata) so large
MCP inventories do not inflate every request. KK Code now provides its own
metadata-only BM25 search, defers catalogs of 24+ eligible MCP tools by default,
and activates up to 64 schemas within one turn. Search never executes or
authorizes tools, and respects agent/skill restrictions. Full SDK inventory and
an explicit eager-mode switch remain available.

### G11 (completed in preview.2) — root-to-cwd instructions

`instruction-loader.mjs` walks from the nearest Git root to cwd, including
worktree markers. Nested repositories are boundaries; non-Git folders remain
cwd-only. Deeper rules have scoped precedence, aliases are deduplicated,
escaping symlinks and oversize instruction files fail explicitly.

### G12 (completed in preview.2) — compatible tool surface consolidation

Exact duplicates (`background_output` ≡ `task_output`, `background_cancel` ≡
`task_stop`, `task_get` ≡ `task_output`) are hidden from default model advertising
when the canonical tool is available. `edit` now accepts exact replacements,
line ranges or atomic changes through the original implementations. Registered
names and old schemas remain callable; `tool.legacy_aliases: true` restores the
old advertising. No alias removal or major/minor bump is implied.

## What did NOT change (compatibility promises kept)

- Headless JSONL schema: untouched.
- JSON Schema draft-07 / 2019-09 / 2020-12 validation semantics: untouched;
  `tool-schema-compatibility-acceptance.test.mjs` still passes unmodified.
- MCP stdio / Streamable HTTP transports: untouched; name sanitization only
  changes the model-facing tool id, never the wire protocol.
- Tool names registered in 1.0.0: none removed; G7/G8 changes are additive
  (aliases) or documentation-only.

## Verification anchors

- `test/tool-surface-contract.test.mjs` — full builtin surface still present.
- `test/tool-discoverability.test.mjs` — prompt-file coverage per tool.
- `test/tool-prompt-groups.test.mjs` (new) — grouping coverage and order.
- `test/tool-schema-naming.test.mjs` (new) — snake_case advertising +
  camelCase aliases.
- `test/agent-prompt-consistency.test.mjs` (new) — each cross-cutting rule
  (large writes, tool selection, git protocol) exists in exactly one canonical
  prompt file; provider prompts stay provider-scoped.
- `test/mcp-tool-naming.test.mjs` (new) — sanitization, truncation, collision
  suffixing.
- `test/skill-model-invocation.test.mjs` (new) —
  `disable-model-invocation` enforcement at the `skill` tool;
  `allowed-tools` now labeled as an enforced turn restriction in diagnostics.
- `test/tool-discovery-deferred.test.mjs`, `test/kernel-discovery-policy.test.mjs`:
  discovery, actual next-request schemas, alias compatibility and skill execution gates.
- `test/instruction-hierarchy.test.mjs`, `test/skill-tool-policy.test.mjs`:
  hierarchy, boundary checks, portable patterns and restriction intersections.
- `test/plugin-agents.test.mjs` (new) — plugin agent loading +
  `allowedAgentPermissions` clamp + inventory-time execution ban.
- `test/system-prompt.test.mjs` (existing) — block assembly, single
  mode-contract injection.

## Addendum: mid-mission requirements folded into this branch

Two requirements were added to M28 while the review was underway; both landed
inside the same file scope:

- **Model catalog auto-discovery provenance** (`test/provider-model-catalog-origin.test.mjs`):
  `discoverModelsForProvider` already auto-discovered via `/models` with
  network → cache → config fallback; every returned model entry now also
  carries `origin: "auto"` (network/cache) or `origin: "manual"` (config
  fallback) so callers can distinguish the two without interpreting the
  top-level `source`. Manual fallback keeps its `stale`/`warning` markers.
- **Concurrent-session prompt isolation** (`test/kernel-system-prompt-cache.test.mjs`):
  the module-level system-prompt block cache keyed on
  mode/model/cwd/agent/tools/skills/userInstructions but NOT on
  `projectContext` or the auto-memory content — two concurrent sessions in the
  same cwd could serve each other stale memory/project blocks. Both now
  participate in the cache key; identical-input cache hits are unchanged.
  (Same-session concurrent turns were already rejected and cross-kernel
  cwd/provider/event isolation already covered by
  `test/kernel-concurrent-turns.test.mjs`.)
