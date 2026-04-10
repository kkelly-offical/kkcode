# kkcode vs claudenext-private: agent / longagent / prompt / skills / plugin compatibility

Date: 2026-04-11
Grounded snapshot: `.omx/context/agent-longagent-prompt-skills-compat-20260411T000000Z.md`

## Executive summary

kkcode should **keep** its deterministic LongAgent pipeline, explicit stage planning, checkpoint/resume path, and simple extension loading. Those are real differentiators, not weaknesses.

kkcode should **catch up** in three places where claudenext-private is materially ahead:

1. **Agent ergonomics** — Claude's agent tool has much stronger fork/background/resume/worktree guidance and runtime support.
2. **Prompt engineering for delegation** — Claude encodes concrete “when to fork / when not to delegate / how to brief agents” rules directly in prompts and tool surfaces.
3. **Plugin/skill compatibility** — Claude has a real manifest-driven plugin system (`.claude-plugin/plugin.json`) that bundles commands, agents, skills, MCP, LSP, settings, and marketplace installation. kkcode currently has only directory loaders plus hook scripts.

The best next move for kkcode is **not** to clone Claude's full product surface. The best move is to add a **thin Claude-compatible compatibility layer** on top of kkcode's simpler architecture:

- Claude-style agent/fork prompt rules for `task`
- richer skill frontmatter
- manifest-based plugin import/export
- worktree/background execution for delegated agents

## Keep vs adopt

### Keep from kkcode

- **Deterministic LongAgent orchestration** with explicit stages, task ownership, gates, and recovery (`src/session/longagent-hybrid.mjs`, `src/session/longagent-plan.mjs`, `src/orchestration/longagent-manager.mjs`)
- **Checkpoint-heavy long-run execution** (`src/session/checkpoint.mjs`, `src/session/longagent*.mjs`)
- **Prompt block caching** and lightweight provider routing (`src/session/system-prompt.mjs`, `src/session/loop.mjs`)
- **Simple extension loading** from project/global folders for tools, skills, and agents (`src/tool/registry.mjs`, `src/skill/registry.mjs`, `src/agent/custom-agent-loader.mjs`)
- **MCP prompt → skill bridging**, which is already a useful portability primitive (`src/skill/registry.mjs`)

### Adopt from claudenext-private

- **Fork-vs-fresh-agent semantics** and background/resume ergonomics (`claudenext-private/src/tools/AgentTool/prompt.ts`, `.../runAgent.ts`)
- **Worktree-isolated subagents** and more explicit agent execution modes (`claudenext-private/src/tools/AgentTool/prompt.ts`, `.../loadAgentsDir.ts`)
- **Read-only tool concurrency** and streaming execution (`claudenext-private/src/services/tools/toolOrchestration.ts`, `.../StreamingToolExecutor.ts`)
- **Richer skill frontmatter**: hooks, paths, effort, shell, bound agent, conditional activation (`claudenext-private/src/skills/loadSkillsDir.ts`)
- **Manifest-driven plugins** with agents/skills/commands/MCP/LSP/settings/userConfig/dependencies (`claudenext-private/src/utils/plugins/schemas.ts`, `.../pluginLoader.ts`, `.../services/plugins/pluginOperations.ts`)

## Detailed comparison

### 1) Agent orchestration and long-running execution

#### kkcode strengths

- kkcode has a real long-run orchestrator, not just subagent spawning.
- `runHybridLongAgent()` includes intake, preview, blueprint, scaffold, coding, debugging, validation, gates, and git merge phases (`src/session/longagent-hybrid.mjs`).
- Stage plans are normalized and validated with file-ownership checks before execution (`src/session/longagent-plan.mjs`).
- LongAgent state is durable and lock-protected (`src/orchestration/longagent-manager.mjs`).
- Checkpoint + resume support is first-class (`src/session/checkpoint.mjs`, `src/session/longagent-hybrid.mjs`).

#### claudenext-private strengths

- Claude's agent runtime is better at **lightweight delegation** than kkcode's current `task` surface.
- The agent prompt explicitly teaches:
  - when to fork
  - when not to delegate
  - how to write delegation prompts
  - how to run background agents without polling
  - when to use worktree isolation
  (`claudenext-private/src/tools/AgentTool/prompt.ts`)
- `runAgent.ts` carries more operational support for:
  - inherited vs fresh context
  - cache-safe forks
  - agent-specific MCP servers
  - resumable sidechains
  - worktree/remote isolation
  (`claudenext-private/src/tools/AgentTool/runAgent.ts`)

#### Gap for kkcode

kkcode's LongAgent is stronger for structured multi-stage delivery, but its **single delegated-task UX** is weaker. `task` only exposes prompt/description/subagent/background/session/planned_files and leaves most delegation quality to the model (`src/tool/task-tool.mjs`). There is no Claude-level built-in fork discipline, worktree isolation, or cache-preserving delegation contract.

#### Recommendation

Add a **Claude-style “delegation contract”** to kkcode's `task` prompt/tool surface before changing architecture:

- distinguish `fork_context` vs `fresh_agent`
- support `isolation: worktree`
- support `run_in_background` with completion notification semantics
- add prompt rules for “don't peek / don't predict results / don't delegate understanding”

This is a high-value, moderate-risk catch-up item.

### 2) Prompt engineering

#### kkcode today

- kkcode has a solid block-based system prompt builder with cacheable sections for provider, agent, mode, tools, skills, subagents, project context, memory, and env (`src/session/system-prompt.mjs`).
- The OpenAI/Anthropic session prompts are serviceable and tool-disciplined (`src/session/prompt/beast.txt`, `src/session/prompt/anthropic.txt`).
- LongAgent has a dedicated orchestration prompt with plan, task ownership, acceptance criteria, and gate expectations (`src/agent/prompt/longagent.txt`).

#### claudenext-private advantage

Claude pushes more of its product behavior into prompts that are tightly coupled to runtime semantics:

- dynamic agent listing is moved out of the tool description when needed to preserve prompt cache stability (`claudenext-private/src/tools/AgentTool/prompt.ts`)
- delegation prompt examples are much more concrete than kkcode's current agent/task framing
- the main prompt stack is much more explicitly sectioned for cache boundaries and dynamic vs static content (`claudenext-private/src/constants/prompts.ts`)

#### Gap for kkcode

kkcode has the **prompt-block infrastructure**, but not enough **delegation-specific heuristics** encoded in prompts. The infrastructure is there; the operating instructions are thinner.

#### Recommendation

Upgrade prompt content before changing runtime code:

1. teach kkcode when to stay local vs delegate
2. teach how to brief subagents with full context vs directive-only fork prompts
3. teach how to use background tasks safely
4. teach when not to use delegation at all
5. separate stable agent catalog content from dynamic runtime state to reduce cache churn

This is a low-risk, high-ROI catch-up item.

### 3) Skills

#### kkcode today

kkcode skill loading is flexible but intentionally simple:

- `.md` template skills
- `.mjs` programmable skills
- directory-format `SKILL.md`
- optional dynamic context injection guarded by a command allowlist
- MCP prompts exposed as skills
(`src/skill/registry.mjs`)

This is a good base and already maps well to kkcode's terminal-first workflow.

#### claudenext-private advantage

Claude's skill system has much richer frontmatter and activation semantics (`claudenext-private/src/skills/loadSkillsDir.ts`):

- `allowed-tools`
- `user-invocable`
- `disable-model-invocation`
- `model`
- `effort`
- `hooks`
- `paths` for conditional activation
- `agent` binding
- `shell`
- `context: fork`
- versioned metadata and better validation/dedup behavior

#### Gap for kkcode

kkcode's skill frontmatter currently only covers a smaller subset: name/description/basic tool gating/model/context fork, without conditional path activation, hooks, effort, shell blocks, or agent binding.

#### Recommendation

Add a **compatibility superset** to kkcode skill metadata, while keeping current simple skills working:

Priority order:

1. `paths`
2. `agent`
3. `effort`
4. `hooks`
5. `shell`
6. optional `version`

This would make Claude-style skills much easier to port without breaking kkcode's simpler format.

### 4) Plugins / extension format compatibility

#### kkcode today

kkcode currently has extension directories, not a full plugin product:

- dynamic tools from `.kkcode/tools` and `.kkcode/plugins` (`src/tool/registry.mjs`)
- hook scripts from builtin/global/project hook directories (`src/plugin/hook-bus.mjs`)
- custom agents from global/project agent directories (`src/agent/custom-agent-loader.mjs`)
- skills from global/project skill directories (`src/skill/registry.mjs`)

This is simple and easy to reason about, but it is not a manifest-driven ecosystem.

#### claudenext-private advantage

Claude has a real plugin contract:

- `.claude-plugin/plugin.json` manifest
- plugin CLI: validate/list/install/uninstall/enable/disable/update (`claudenext-private/src/main.tsx`, `src/services/plugins/pluginOperations.ts`)
- versioned plugin installs and marketplace support
- plugin-provided commands, agents, skills, output styles, MCP servers, LSP servers, settings, userConfig, channels, and dependencies
(`claudenext-private/src/utils/plugins/schemas.ts`, `src/utils/plugins/pluginLoader.ts`, `src/types/plugin.ts`)

This is far ahead of kkcode in compatibility and distribution.

#### Gap for kkcode

There is no kkcode manifest equivalent to `.claude-plugin/plugin.json`, and no marketplace/install/update flow. That means Claude plugins are not portable into kkcode without hand conversion.

#### Recommendation

Do **not** build marketplaces first.

Instead, add a **manifest import layer** first:

##### Phase 1: local manifest compatibility

Support reading either of:

- `.claude-plugin/plugin.json`
- `.kkcode-plugin/plugin.json`

and map them into kkcode internals:

- `commands` → kkcode custom commands / skills
- `agents` → kkcode custom agents
- `skills` → kkcode skills
- `mcpServers` → kkcode MCP config fragments
- `hooks` → kkcode hook bus registration

##### Phase 2: packaging/export

Allow kkcode to emit a compatible plugin manifest for local portability.

##### Phase 3: optional install UX

Only after local compatibility works, consider `kkcode plugin validate` and `kkcode plugin import`.

That sequence preserves kkcode's simplicity while unlocking real ecosystem reuse.

## Highest-value catch-up moves for kkcode

### P0 — prompt/runtime catch-up

1. **Upgrade `task` / subagent prompting with Claude-style delegation rules**
2. **Add fork-context vs fresh-agent semantics**
3. **Add worktree isolation for delegated agents**
4. **Add background task completion semantics instead of ad hoc backgrounding**

### P1 — compatibility layer

5. **Extend skill frontmatter to support Claude-like metadata**
6. **Add local `.claude-plugin/plugin.json` import support**
7. **Map plugin manifest components into existing kkcode loaders**

### P2 — ecosystem/product catch-up

8. **Add plugin validation/import CLI**
9. **Add plugin-scoped MCP/hook policy controls**
10. **Consider versioned plugin installs only after local portability works**

## What kkcode should explicitly not copy yet

- Claude's full marketplace/install/update product surface
- Claude's large startup/product analytics/prefetch stack
- remote/background/team product surfaces that depend on a much larger runtime contract

These are expensive to clone and not necessary for the current catch-up goal.

## Risks

### If kkcode copies Claude too literally

- LongAgent's current clarity could get diluted by too many agent modes.
- A full plugin product would add lots of operational surface before portability is proven.
- More runtime complexity could make kkcode less predictable in terminal-first workflows.

### If kkcode does nothing

- Claude-style prompts/skills/plugins will remain hard to port.
- kkcode will keep its long-run strength but lag on day-to-day delegation ergonomics.
- plugin ecosystem compatibility will stay mostly manual.

## Recommended implementation order

1. **Prompt-only catch-up**
   - improve `task` tool instructions
   - improve agent/delegation prompts
   - preserve existing runtime

2. **Thin runtime upgrades**
   - add fork-context/fresh-agent distinction
   - add worktree isolation
   - add better background completion behavior

3. **Skill metadata superset**
   - accept Claude-like frontmatter fields where they map cleanly

4. **Plugin manifest compatibility layer**
   - local import first
   - validation CLI next
   - installation UX later

## Bottom line

kkcode already has the harder-to-build long-run execution core. claudenext-private is ahead mainly in **delegation ergonomics, prompt discipline, and manifest-driven compatibility surfaces**.

So kkcode's next move should be: **keep the LongAgent engine, import Claude's delegation prompt/runtime lessons, and add a thin compatibility layer for skills/plugins instead of cloning Claude's full product stack.**
