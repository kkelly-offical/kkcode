# kkcode vs claudenext-private: agent / longagent / skills / plugin compatibility

## Scope

Grounded comparison for kkcode against the reconstructed `claudenext-private/` runtime, focused on:

- agent delegation and long-running execution
- prompt engineering
- skills ergonomics
- plugin / extension compatibility

Primary evidence came from:

- `src/session/system-prompt.mjs:136-227`
- `src/session/longagent-plan.mjs:282-348`
- `src/session/longagent-hybrid.mjs:441-530`
- `src/skill/registry.mjs:17-120,141-214`
- `src/agent/custom-agent-loader.mjs:18-145`
- `src/plugin/hook-bus.mjs:63-80`
- `README.md:250-260`
- `claudenext-private/src/tools/AgentTool/builtInAgents.ts:24-70`
- `claudenext-private/src/tools/AgentTool/prompt.ts:66-153`
- `claudenext-private/src/skills/bundledSkills.ts:15-90`
- `claudenext-private/src/skills/loadSkillsDir.ts:185-207`
- `claudenext-private/src/plugins/builtinPlugins.ts:1-120`
- `claudenext-private/src/utils/plugins/loadPluginAgents.ts:92-168`
- `claudenext-private/src/utils/plugins/loadPluginCommands.ts:684-838`
- `claudenext-private/src/utils/plugins/schemas.ts:268-340`
- `claudenext-private/src/services/tools/toolOrchestration.ts:19-116`

## Executive summary

kkcode should **keep** its stricter LongAgent planning discipline and explicit staged execution model, but it should **catch up** in three places where claudenext-private is materially ahead:

1. **Agent prompt engineering**: Claude has a much clearer delegation contract, especially around forked work, prompt-writing quality, and result-handling discipline.
2. **Skills as a first-class surface**: Claude supports a richer, more portable skill frontmatter/runtime contract, including fork/inline context, hooks, arguments, and packaged reference files.
3. **Plugin compatibility**: Claude has a real plugin manifest/runtime boundary; kkcode currently has hooks plus custom files, but not an equivalent plugin package format.

The recommended path for kkcode is **compatibility-first, not clone-first**: adopt the portable prompt/skill/plugin contracts that improve reuse, without giving up kkcode's simpler architecture or LongAgent-specific strengths.

## What kkcode is already stronger at

### 1. LongAgent planning is more explicit and more production-oriented

kkcode's LongAgent planner already forces a machine-readable stage plan, explicit file ownership, task-local acceptance criteria, and integration constraints (`src/session/longagent-plan.mjs:282-348`).

That is stronger than Claude's general agent system for large repo changes because kkcode already encodes:

- no overlapping file ownership
- stage dependency ordering
- self-contained task prompts
- machine-verifiable acceptance commands

### 2. LongAgent hybrid mode already has useful recovery rails

The hybrid blueprint flow requires structured `stage_plan_json`, retries blueprint parsing when the LLM drifts, freezes the plan, and validates stage/task/file counts before execution (`src/session/longagent-hybrid.mjs:441-523`).

That is worth preserving. Claude is stronger on agent ergonomics, but kkcode is stronger on explicit orchestration guardrails.

### 3. Prompt block caching is already pointed in the right direction

kkcode's system prompt builder separates provider, agent, mode, tools, skills, subagents, project context, memory, and env blocks for cache reuse (`src/session/system-prompt.mjs:136-227`).

This is already philosophically aligned with Claude's cache-conscious runtime. kkcode should extend this, not replace it.

## Where claudenext-private is ahead

### 1. Agent delegation prompts are much more teachable and safer

Claude's AgentTool prompt does more than list agents. It teaches:

- when to fork vs spawn a fresh specialist
- how to write a good delegation brief
- not to fabricate subagent results before completion
- not to pollute parent context by peeking at child transcripts

See `claudenext-private/src/tools/AgentTool/prompt.ts:76-153`.

kkcode currently exposes subagents and custom agents, but its runtime prompt surface is much thinner by comparison (`src/session/system-prompt.mjs:211-227`, `src/tool/task-tool.mjs:1-25`, `src/agent/agent.mjs:1-224`).

**Implication:** kkcode's orchestration runtime is strong, but the coordinator prompt is leaving quality on the table.

### 2. Claude's skill contract is richer and more portable

kkcode supports project/global skills, markdown frontmatter, programmable `.mjs` skills, and `SKILL.md` directories (`src/skill/registry.mjs:49-92,141-214`).

But Claude's skill system is broader:

- bundled skills can package extracted reference files and establish a stable base directory (`claudenext-private/src/skills/bundledSkills.ts:15-90`)
- shared frontmatter parsing supports `when_to_use`, arguments, execution context, hooks, effort, shell, and model fields (`claudenext-private/src/skills/loadSkillsDir.ts:185-207`)
- plugin-provided skills support direct `SKILL.md` directories and nested namespacing (`claudenext-private/src/utils/plugins/loadPluginCommands.ts:684-838`)

kkcode has the basics, but not yet the richer portability layer.

### 3. Claude has a real plugin platform; kkcode currently has hooks plus custom file loaders

Claude has:

- built-in plugins that can ship skills, hooks, and MCP servers (`claudenext-private/src/plugins/builtinPlugins.ts:1-120`)
- a typed `plugin.json` manifest schema (`claudenext-private/src/utils/plugins/schemas.ts:268-340`)
- plugin-scoped agent loading with explicit trust boundaries (`claudenext-private/src/utils/plugins/loadPluginAgents.ts:92-168`)
- marketplace / installation / enable-disable flows across scopes (`claudenext-private/src/services/plugins/pluginOperations.ts`, `PluginInstallationManager.ts`)

kkcode does **not** currently have an equivalent packaged plugin manifest/runtime. In practice it has:

- custom skills under `.kkcode/skills/`
- custom agents under `.kkcode/agents/`
- hook loading from `~/.kkcode/hooks` and `.kkcode/hooks` (`src/plugin/hook-bus.mjs:63-80`)

This means kkcode is currently closer to a **customization filesystem** than to a **plugin platform**.

### 4. kkcode's extension docs currently overstate plugin support

The README says `插件/Hook | .kkcode/plugins/ | Hook 事件脚本` (`README.md:252-259`), but the actual hook loader reads `.kkcode/hooks`, not `.kkcode/plugins/` (`src/plugin/hook-bus.mjs:63-80`).

That mismatch is small but important:

- it makes current extensibility harder to understand
- it blocks future compatibility work because the public contract is already fuzzy
- it increases migration cost later

## Compatibility recommendations for kkcode

### P0 — fix the public extension contract first

Before adding new compatibility layers, kkcode should make its current contract unambiguous.

Recommended moves:

1. Align docs with implementation: either document `.kkcode/hooks/` as the real path, or add `.kkcode/plugins/` loading if that is the intended public API.
2. Split the extension story into explicit surfaces:
   - skills
   - agents
   - hooks
   - tools
   - future plugins
3. Stop using “plugin” as a loose synonym for “hook/customization file”.

This is the cheapest high-leverage fix.

### P1 — upgrade kkcode's delegation prompt, not just its agent list

Borrow Claude's prompt-engineering ideas, not its branding.

Recommended additions to kkcode's agent/task prompting:

- when to delegate vs stay local
- when to fork inherited-context work vs when to spawn a clean specialist
- prompt-writing rules for self-contained delegation
- explicit prohibition on guessing unfinished child results
- explicit guidance on progress-check behavior for background work

This can be implemented entirely as prompt/runtime policy, without architecture churn.

### P1 — add a Claude-style skill frontmatter compatibility layer

kkcode should accept more Claude-style skill metadata, even if some fields are initially no-ops.

Minimum worthwhile additions:

- `when_to_use`
- `argument-hint`
- `arguments`
- `context: inline|fork`
- `agent`
- `effort`
- `hooks`
- `shell`
- `paths`

Why this matters:

- it lowers migration friction for imported skills
- it gives kkcode a cleaner long-term skill schema
- it improves automatic routing and prompt portability

This is likely the highest ROI compatibility change.

### P1 — support packaged skill assets

Claude's bundled skills can ship reference files and expose a stable base directory (`claudenext-private/src/skills/bundledSkills.ts:29-72`). kkcode should add a lighter-weight version for local skills/plugins.

Suggested kkcode contract:

- if a skill lives in a directory with `SKILL.md`, expose that directory as the skill root
- optionally inject a stable “base directory for this skill” hint into the prompt
- keep path-boundary checks strict

This would immediately improve advanced prompt-based workflows.

### P2 — introduce a local plugin manifest MVP

kkcode does not need Claude's full marketplace model yet. But it does need a package boundary.

Recommended MVP:

- add `.kkcode-plugin/plugin.json` or `.kkcode/plugins/<name>/plugin.json`
- allow a plugin to declare:
  - metadata
  - skills paths
  - agents paths
  - hooks
  - optional MCP server definitions
- load only local/project plugins at first
- do **not** start with marketplaces, auto-update, or remote trust chains

This gets kkcode to a real plugin format without importing Claude's full operational weight.

### P2 — keep plugin trust boundaries explicit

Claude intentionally refuses some agent-level privilege escalation inside third-party plugin agents (`claudenext-private/src/utils/plugins/loadPluginAgents.ts:153-168`). kkcode should copy this idea if it adds plugin manifests.

Recommended rule:

- manifest-level capabilities may exist, but plugin-bundled agent files should not silently expand permissions beyond the manifest boundary

That is a good security property and worth preserving from day one.

### P3 — make tool concurrency capability-based, not just read-only-based

kkcode currently parallelizes read-only tool calls and serializes writes (`src/session/loop.mjs:803-845`). Claude's runtime goes one step further by batching tools using per-tool `isConcurrencySafe(...)` checks and applying context modifiers after concurrent completion (`claudenext-private/src/services/tools/toolOrchestration.ts:19-116`).

kkcode does not urgently need this, but it is a real optimization opportunity for:

- safe mixed tool batches
- lower orchestration latency
- future plugin/tool extensibility

## What kkcode should not blindly copy

### 1. Do not import Claude's full marketplace machinery yet

Claude's marketplace/plugin installation stack is powerful, but it brings:

- trust and policy complexity
- cache/update complexity
- more user-facing state
- more failure modes

kkcode should earn this complexity only after the local plugin manifest stabilizes.

### 2. Do not weaken LongAgent's file-ownership rules

Claude's generic agent model is more flexible, but kkcode's strict stage/file planning is one of its real differentiators. That should stay.

### 3. Do not turn every extension surface into a plugin prematurely

Skills, hooks, agents, and tools should stay independently usable. The plugin manifest should compose them, not replace them.

## Proposed catch-up order

1. **Docs/runtime cleanup**
   - fix `.kkcode/plugins` vs `.kkcode/hooks`
   - document current extension surfaces precisely
2. **Prompt catch-up**
   - strengthen subagent/fork/delegation guidance
   - add better result-handling discipline
3. **Skill compatibility**
   - accept richer frontmatter
   - support skill directories as stable asset roots
4. **Plugin manifest MVP**
   - local-only package format for skills/agents/hooks/MCP
5. **Runtime optimizations**
   - capability-based concurrency
   - only then evaluate broader plugin lifecycle features

## Bottom line

kkcode should keep its LongAgent execution model and its stricter planning rails. The best catch-up moves are not “be more like Claude” in general; they are:

- **adopt Claude's stronger delegation prompt patterns**
- **adopt Claude's richer skill contract**
- **add a real plugin/package boundary**
- **clean up the current extension docs before expanding them**

That path improves interoperability and product polish without sacrificing kkcode's core advantage in staged, high-discipline long-running execution.
