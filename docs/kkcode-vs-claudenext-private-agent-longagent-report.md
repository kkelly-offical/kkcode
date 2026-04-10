# kkcode vs claudenext-private: agent / longagent / prompt / skills / plugin compatibility

Grounding context: `.omx/context/agent-longagent-prompt-skills-compat-20260411T000000Z.md`

## Executive summary

`kkcode` is already stronger where work benefits from **deterministic staged execution**: its LongAgent pipeline forces ambiguity resolution up front, enforces explicit file ownership, and pushes machine-verifiable acceptance into stage prompts. `claudenext-private` is stronger where work benefits from a **productized general-purpose agent runtime**: cheaper forked subagents, richer task/team tools, more advanced prompt-cache hygiene, and a much more complete skill/plugin contract.

### What kkcode should keep

1. **Keep LongAgent’s plan-first rigor**. The intake analyst + stage planner + ownership rules are a real advantage for multi-file implementation.
2. **Keep the lightweight local extensibility surface**. `.kkcode/skills`, `.kkcode/agents`, `.kkcode/hooks`, and `.mcp.json` auto-discovery are simpler than Claude’s stack and easier to reason about.
3. **Keep prompt block caching**. `kkcode` already has a good structured prompt assembly model and should evolve it rather than replacing it.

### What kkcode should adopt next

1. **Add a cheap forked-context agent lane** alongside LongAgent, not instead of it.
2. **Add Claude-style skill frontmatter compatibility** so higher-value skills port with less rewriting.
3. **Add a manifest-based plugin compatibility layer** that can load commands/skills/agents/hooks/MCP from a plugin directory.
4. **Tighten subagent prompting guidance** using Claude’s “don’t delegate understanding / write directive prompts / don’t peek” rules.

### What kkcode should not clone blindly

1. Claude’s full marketplace/plugin/install surface.
2. Claude’s much broader tool catalog and product flags.
3. Claude’s task/team runtime semantics where LongAgent’s stricter file-ownership model is already safer.

## Grounded comparison

### 1) Agent runtime and long-running execution

#### kkcode strengths

- `src/session/longagent-plan.mjs:178-266` runs an explicit intake dialogue that forces assumptions, contracts, quality constraints, and dependency order to be resolved before planning.
- `src/session/longagent-plan.mjs:282-340` generates a stage plan with hard file-assignment rules, self-contained task prompts, and machine-verifiable acceptance requirements.
- `src/orchestration/stage-scheduler.mjs:141-337` builds enriched per-task prompts, injects file ownership and sibling-task boundaries, and launches isolated worker processes.
- `src/orchestration/background-worker.mjs:60-126` executes delegated work in a separate worker process with its own context/tool registry and tracks completed vs remaining files.

#### kkcode gaps

- The dominant parallel path is **isolated implementation work**. It is optimized for scaffolded coding tasks, not for cheap open-ended research/status forks.
- `kkcode` does not expose a Claude-style “fork yourself with shared context” lane; its worker model assumes task packaging and isolation.
- There is no equivalent of Claude’s richer task/team/product runtime surface (`Task*`, `Team*`, `SendMessage`, cron/remote triggers in one shared registry).

#### claudenext-private strengths

- `claudenext-private/src/tools/AgentTool/prompt.ts:48-218` distinguishes between fresh subagents and **forked context-sharing agents**, with specific behavioral rules for when to fork, how to prompt, and how to avoid racing/polluting context.
- `claudenext-private/src/tools.ts:195-267` exposes a much broader runtime surface: agent/task/team/worktree/MCP/skill/search/todo tools all live in one shared tool pool.
- `claudenext-private/src/services/tools/toolOrchestration.ts:19-177` partitions tool calls into concurrency-safe batches and runs read-only tool batches concurrently.
- `claudenext-private/src/query.ts:97-113` and adjacent imports show a more mature main loop with compacting, tool summaries, token budgeting, retry/recovery, and attachment/memory side systems already wired into the runtime.

#### Recommendation

`kkcode` should **keep LongAgent for code execution** but add a second lane for **cheap forked-context agent work**:
- research/audit/status forks,
- lightweight second opinions,
- sidecar verification tasks,
- progress notification without forcing LongAgent scaffolding.

This should reuse the existing background-worker infrastructure instead of replacing LongAgent.

### 2) Prompt engineering and cache discipline

#### kkcode strengths

- `src/session/system-prompt.mjs:121-233` already builds prompt blocks by layer (provider / agent / mode / tools / skills / subagents / project / language / memory / env / user instructions).
- `src/session/system-prompt.mjs:136-163` caches the assembled block set by a hashed signature and refreshes only the environment block when possible.
- `src/session/system-prompt.mjs:192-202` adds an explicit “large output strategy”, which is a practical reliability optimization.

#### kkcode gaps

- Custom subagent listing is static text inside the system prompt (`src/session/system-prompt.mjs:211-228`), so agent-catalog churn still risks cache invalidation.
- LongAgent’s planning prompts are strong for implementation, but there is no parallel Claude-style guidance for:
  - fork vs fresh-agent choice,
  - how to brief subagents concisely but sufficiently,
  - avoiding fabricated mid-flight progress claims,
  - prompt-writing discipline for delegated work.

#### claudenext-private strengths

- `claudenext-private/src/tools/AgentTool/prompt.ts:48-64` explicitly moves the dynamic agent list into attachment/system-reminder messages to reduce tool-schema cache busts.
- `claudenext-private/src/tools/AgentTool/prompt.ts:80-112` provides high-value delegation rules: when to fork, when not to peek, when not to race, and how to write directive-style prompts.
- `claudenext-private/src/tools.ts:192-194` explicitly treats tool ordering as a cache-stability concern.

#### Recommendation

Low-risk catch-up for `kkcode`:
1. Add a **delegation guidance block** for subagents/forks modeled on Claude’s prompt rules.
2. Move dynamic custom-agent listings out of the always-stable prompt prefix where possible.
3. Preserve kkcode’s current block-cache design; it is already a good base.

### 3) Skills

#### kkcode strengths

- `src/skill/registry.mjs:365-440` loads skills from built-ins, custom commands, global/project/custom skill dirs, and MCP prompts.
- `src/skill/registry.mjs:294-324` supports directory-format `SKILL.md` skills with auxiliary files.
- `src/skill/registry.mjs:241-265` allows controlled command substitution in skill templates while guarding via an allowlist.
- The format is simple and hackable: `.md`, `.mjs`, or `SKILL.md` directories.

#### kkcode gaps

Compared with Claude’s loader, kkcode’s skill frontmatter is much thinner:
- no first-class `when_to_use`, `paths`, `hooks`, `agent`, `effort`, `shell`, or `context=fork` contract,
- no scoped path matching like Claude skills,
- no strong compatibility story for Claude-style slash-command packs,
- no richer prompt-time metadata budgeting/deduping beyond name+description.

#### claudenext-private strengths

- `claudenext-private/src/skills/loadSkillsDir.ts:67-94` supports multiple skill sources (`skills`, `plugin`, `managed`, `bundled`, `mcp`).
- `claudenext-private/src/skills/loadSkillsDir.ts:132-178` parses hooks and path scoping from frontmatter.
- `claudenext-private/src/skills/loadSkillsDir.ts:185-260` parses richer frontmatter: description, allowed tools, argument hints, when-to-use, version, model, effort, disable-model-invocation, user-invocable, hooks, execution context, and agent binding.
- `claudenext-private/src/tools/SkillTool/prompt.ts` keeps prompt-time skill listing discovery-oriented and pushes full content loading to invocation time.

#### Recommendation

Highest-ROI compatibility move: extend kkcode’s `SKILL.md` frontmatter parser to accept Claude-like fields without breaking current skills:
- `when_to_use`
- `allowed-tools`
- `paths`
- `hooks`
- `agent`
- `effort`
- `context: fork`
- `disable-model-invocation`
- `model: inherit`

This gives kkcode a practical **skill portability layer** without needing Claude’s entire runtime.

### 4) Plugin / extension compatibility

#### kkcode today

`kkcode` has extension points, but not a mature plugin packaging/runtime contract:
- `src/plugin/hook-bus.mjs` is a lightweight hook loader for built-in/user/project hook files.
- `src/mcp/registry.mjs:71-94` already auto-discovers MCP config from `.mcp.json`, `.mcp/config.json`, `.kkcode/mcp.json`, and a global config, which is a good compatibility anchor.
- There is no manifest-based plugin loader that unifies commands, skills, agents, hooks, MCP, and output styles under one package boundary.

#### claudenext-private strengths

- `claudenext-private/src/utils/plugins/pluginLoader.ts:1-33` defines a real plugin packaging model with manifest, commands, agents, and hooks.
- `claudenext-private/src/types/plugin.ts:48-77` shows the loaded-plugin contract: commands, agents, skills, hooks, output styles, MCP servers, LSP servers, settings.
- `claudenext-private/src/types/plugin.ts:79-120` and beyond also show typed error surfaces for plugin failures.
- `claudenext-private/src/utils/plugins/pluginLoader.ts:123-220` implements versioned cache paths and seed-cache probing, indicating a real install/update lifecycle.

#### Recommendation

Do **not** clone Claude’s marketplace/runtime wholesale. Instead add a minimal kkcode plugin compatibility layer:

**Suggested phase-1 manifest**
- `plugin.json` or `.codex-plugin/plugin.json`
- components:
  - `commands/`
  - `skills/`
  - `agents/`
  - `hooks/`
  - optional `mcpServers`
- local-directory install only at first
- no marketplace, no remote fetch, no auto-update in v1

This is enough to:
- import a meaningful subset of Claude-style plugins locally,
- unify kkcode’s current scattered extension surfaces,
- keep the implementation small and auditable.

## Recommended catch-up roadmap

### P0 — prompt/runtime catch-up (low risk, high return)

1. Add **forked-context subagent mode** to the background worker path.
2. Add Claude-style delegation guidance:
   - when to fork,
   - when to use fresh context,
   - how to write prompts,
   - do-not-peek / do-not-race rules.
3. Keep LongAgent unchanged for staged coding.

### P1 — skills compatibility layer

1. Extend `SKILL.md` frontmatter parsing for Claude-compatible fields.
2. Add optional path scoping and execution-context support.
3. Keep current `.md`/`.mjs`/`SKILL.md` skill formats working as-is.

### P2 — plugin compatibility layer

1. Introduce manifest-based plugin directories.
2. Load commands/skills/agents/hooks/MCP from a package boundary.
3. Map existing `.kkcode/hooks` and `.kkcode/agents` to the new loader internally where practical.

### P3 — optional productization

1. Add tool-pool prompt cache stabilization for dynamic agent/plugin catalogs.
2. Add output-style / richer hook plugin points if real use cases emerge.
3. Consider task/team UX only after the simpler fork lane proves useful.

## Key risks

### 1) Replacing LongAgent with Claude-style swarm behavior would be a regression

`kkcode`’s strongest differentiator is that LongAgent turns multi-file coding into a constrained staged pipeline. Claude’s agent runtime is more flexible, but also less opinionated. Replacing LongAgent would throw away a real advantage.

### 2) Copying Claude’s plugin marketplace is too expensive

Claude’s plugin surface is tied to product infrastructure: marketplaces, policy, cache/versioning, settings integration, built-in plugins, and richer error/reporting flows. `kkcode` should copy the **package contract**, not the whole distribution/runtime ecosystem.

### 3) Forked-context agents need explicit transcript discipline

If kkcode adds forked subagents, it also needs Claude’s discipline rules:
- don’t read fork transcripts unless asked,
- don’t fabricate results before completion,
- prompt with directives, not re-explained background.

Without those rules, the runtime gets noisier without becoming more reliable.

## Bottom line

Best next move: **preserve kkcode’s LongAgent architecture, but add Claude-style cheap forked agents plus richer skill/plugin compatibility.**

That yields the highest-value catch-up:
- better prompt portability,
- better long-running agent ergonomics,
- a much more reusable extension format,
- without sacrificing kkcode’s stronger deterministic execution model.
