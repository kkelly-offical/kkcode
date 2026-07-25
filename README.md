# kkcode

[![npm version](https://img.shields.io/npm/v/@kkelly-offical/kkcode?label=npm)](https://www.npmjs.com/package/@kkelly-offical/kkcode)
[![GitHub Release](https://img.shields.io/github/v/release/kkelly-offical/kkcode)](https://github.com/kkelly-offical/kkcode/releases)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-green)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**Terminal-first coding agent with a five-mode cycle, governed approvals, and staged Ultra delivery.**

**终端优先、可治理、可扩展的编码智能体：五档模式循环、可治理审批、Ultra 分阶段交付。**
kkcode 把问答、规划、事务型修改、多阶段长任务编排放在同一个 CLI 工作台里，并且把权限、预算、审计、后台任务、MCP、技能与插件一起纳入统一执行面。

**日本語**: ターミナル中心の個人アシスタント。安全な権限管理、Coding Agent、LongAgent、ローカル拡張を同じ CLI にまとめます。  
**한국어**: 터미널 우선 개인 비서로, 권한 관리와 Coding Agent, LongAgent, 로컬 확장을 하나의 CLI에서 다룹니다。  
**Español**: asistente personal centrado en terminal para ejecución gobernada, agentes de código, LongAgent y extensiones locales.

---

<a id="table-of-contents"></a>
## Table of Contents / 目录

- [Overview / 概览](#overview)
- [Why kkcode / 为什么选择 kkcode](#why-kkcode)
- [Installation / 安装](#installation)
- [Quick Start / 快速开始](#quick-start)
- [Capability Snapshot / 能力总览](#capability-snapshot)
- [Modes & Ultra / 模式与 Ultra](#modes-and-longagent)
- [Safety & Permissions / 权限与安全](#safety-and-permissions)
- [Delegation & Subagents / 委派与子智能体](#delegation-and-subagents)
- [Integrations / 集成](#integrations)
- [Extensions / 扩展机制](#extensions)
- [TUI & CLI Reference / TUI 与命令参考](#tui-and-cli-reference)
- [Configuration & Project Layout / 配置与项目结构](#configuration-and-project-layout)
- [Model Templates / 模型模板](#model-templates)
- [Release Status / 发布状态](#release-status)
- [Compatibility, Limits & Roadmap / 兼容性、边界与路线图](#compatibility-limits-and-roadmap)
- [FAQ / 常见问题](#faq)
- [Contributing / 贡献](#contributing)
- [License / 许可证](#license)
- [Further Reading / 延伸阅读](#further-reading)

---

<a id="overview"></a>
## Overview / 概览

**English**
- kkcode is a terminal-native unified Assistant designed for local work, governed execution, coding, planning, and multi-stage delivery.
- Everyday work stays in `agent`; `Shift+Tab` cycles Plan, Agent, Agent · Auto, Ultra and YOLO, while `/plan` and `/ultra` remain explicit entry points.
- It is optimized for **CLI-first** and **Ultra-first** workflows rather than GUI-first or marketplace-first product patterns.

**中文**
- kkcode 是一个面向终端原生工作流的统一 Assistant，强调本地事务、可治理执行、编码、规划和多阶段交付。
- 日常工作统一进入 `agent`；`Shift+Tab` 循环 Plan、Agent、Agent · Auto、Ultra、YOLO，`/plan` 与 `/ultra` 仍是显式入口。
- 它优先服务 **CLI-first**、**Ultra-first** 的工程工作流，而不是 GUI 优先或 marketplace 优先的平台形态。

---

<a id="why-kkcode"></a>
## Why kkcode / 为什么选择 kkcode

**English**
- **CLI-first**: core workflows stay in the terminal.
- **Ultra-first**: large tasks are planned, staged, and verified instead of improvised in one prompt.
- **Governed execution**: permissions, budgets, audit logs, and recovery are built in.
- **Local extensibility**: MCP, skills, commands, hooks, tools, and custom agents can all be mounted locally.

**中文**
- **CLI-first**：核心工作流都在终端内完成。
- **Ultra-first**：复杂任务先规划、分阶段、带门禁，而不是靠单轮 prompt 硬顶。
- **可治理执行**：权限、预算、审计、恢复、后台任务都是内建能力。
- **本地可扩展**：MCP、skills、commands、hooks、tools、custom agents 都能本地挂载。

---

<a id="installation"></a>
## Installation / 安装

**Requirements / 环境要求**
- Node.js `>=22`
- npm or pnpm
- A modern terminal on Windows, macOS, or Linux

**Install from npm / 通过 npm 安装**
```bash
npm install -g @kkelly-offical/kkcode
kkcode
```

**Run from source / 从源码运行**
```bash
git clone https://github.com/kkelly-offical/kkcode.git
cd kkcode
npm install
npm run start
```

**Useful links / 常用链接**
- [npm package](https://www.npmjs.com/package/@kkelly-offical/kkcode)
- [GitHub Releases](https://github.com/kkelly-offical/kkcode/releases)
- [Example config](docs/config.example.yaml)

---

<a id="quick-start"></a>
## Quick Start / 快速开始

**1. Launch / 启动**
```bash
kkcode
```

**2. Initialize project config / 初始化项目配置**
```bash
kkcode init -y
```

**3. Verify the install / 验证安装**
```bash
kkcode --help
kkcode doctor
```

**First-run behavior / 首次启动行为**
- On first launch, kkcode runs onboarding and records your preferences.
- Use `/profile` to inspect or update personal preferences.
- Use `/like` to rerun onboarding.

**Configuration search order / 配置查找顺序**
- User-level: `~/.kkcode/config.yaml`
- Project-level: `./kkcode.config.yaml` or `./.kkcode/config.yaml`

---

<a id="capability-snapshot"></a>
## Capability Snapshot / 能力总览

| Area / 能力面 | Status / 状态 | Notes / 说明 |
| --- | --- | --- |
| Agent / 统一助手 | Supported | Default CLI lane for Q&A, code edits, reviews, tests, and local automation |
| Plan / 方案规划 | Supported | Read-only planning workflow that saves a plan file, then switches mode to build it |
| Mode cycle / 模式循环 | Supported | `Shift+Tab` cycles Plan · Agent · Agent·Auto · Ultra · YOLO |
| Ultra / 长程编排 | Supported | Multi-stage execution, retries, gates, resumable flow |
| Permissions / 权限治理 | Supported | `readonly` / `manual` / `accept-edits` / `yolo` levels plus persistent Always Allow |
| Ghost text / 输入预测 | Supported | Inline next-phrase prediction when `models.fast` is configured |
| Background tasks / 后台任务 | Supported | Launch, inspect, wait, retry, cancel |
| MCP / 模型上下文协议 | Supported | Local MCP discovery and registry |
| Skills / Commands / Hooks | Supported | Local-first extensibility surface |
| Plugins / 插件包 | Preview | Local kkcode / Claude Code / Codex / OpenCode compatibility baseline |
| GUI / IDE / desktop automation | Not promised | README does not claim GUI-first product support |

For a deeper boundary matrix, see [CLI General Assistant Capability Matrix](docs/cli-general-assistant-capability-matrix.md).

---

<a id="modes-and-longagent"></a>
## Modes & Ultra / 模式与 Ultra

### The mode cycle / 模式循环

Press `Shift+Tab` to walk the five public modes. `/mode` opens a picker,
`/mode <id>` switches directly.

按 `Shift+Tab` 循环五个公开模式；`/mode` 打开选择面板，`/mode <id>` 直接切换。

| Mode | Lane | Approval | Purpose |
| --- | --- | --- | --- |
| ⏸ `plan` | plan | readonly | read-only planning; never mutates files |
| ● `agent` | assistant | manual | **default** — edits are confirmed before they land |
| ▶ `agent-auto` | assistant | accept-edits | edits and subagents run unattended; risky shell still asks |
| ⚡ `ultra` | longagent | accept-edits | staged multi-file delivery with gates, checkpoints and resume |
| ☠ `yolo` | assistant | yolo | every approval prompt is skipped |

**English**
- Every mode is a **(lane, approval) pair**: the lane decides how work is orchestrated, the approval level decides what runs without asking. The three `assistant`-lane modes differ only in approval.
- `agent` is the default unified lane for questions, coding, review, tests, and automation.
- Use `/ultra` explicitly when the task is clearly multi-stage or system-wide.
- Interrupted work can be resumed with the same session context.

**中文**
- 每个模式都是 **(航道, 审批档) 二元组**：航道决定如何编排，审批档决定什么可以免询问执行。三个 `assistant` 航道的模式只有审批档不同。
- `agent` 是默认统一入口，承接问答、编码、审查、测试和自动化。
- 任务明显跨文件、跨阶段、影响面较大时，显式使用 `/ultra`。
- 中断后的工作可以在同一会话中继续，不需要从零开始。
- **路由理由可见**：当 kkcode 建议使用 `ultra` 时，会解释为什么当前任务更适合重型工作流。

### Compatibility / 兼容旧写法

0.3.x spellings keep working and map automatically, printing a one-time
deprecation notice. Removal is planned for 0.5.0.

0.3.x 的写法继续可用并自动映射，首次使用时打印一次性弃用提示，计划在 0.5.0 移除。

| 0.3.x | 0.4.0 |
| --- | --- |
| `/longagent` | `/ultra` |
| `assistant` / `agent` / `code` / `coding` | `agent` |
| `permission.level: review` / `auto` | `manual` |
| `permission.level: edit` / `full-auto` | `accept-edits` |
| `permission.mode` / `permission.default_policy` | `permission.level` |

Lane identifiers (`assistant` / `plan` / `longagent`) are unchanged, so
sessions, hooks and `permission.rules[].modes[]` keep working.

航道标识（`assistant` / `plan` / `longagent`）保持不变，会话、hooks 与
`permission.rules[].modes[]` 都不受影响。

### CLI 统一 Assistant 能力边界（0.3.0）

**公共模式契约**

- `agent`：默认统一助手，承接问答、本地检查、编码修改、测试验证、审查、网页查询、Git/GitHub、笔记和任务整理。0.3.x 的 `assistant` 归一到这里。
- `/plan`：**只读编写开发计划**，保存计划文件后提供 Build / Ultra Build / compact 执行选择，选定后**真正切换模式并开始执行**。
- `assistant` / `agent` / `code` / `coding`：兼容别名，内部归一为 `agent` 模式（`assistant` 航道）。
- `/ultra`：显式重型开发模式，用于跨文件、多阶段、需要恢复和验收的任务。

**能力边界速览**
- 系统 / 运行时信息
- 本地目录 / 文件 / 日志检查
- 仓库 / 发布辅助
- 这**不代表** kkcode 已经承诺 GUI / 桌面自动化能力
- 默认先在 `assistant` 内处理普通终端事务和编码小闭环；只有明确重型任务才提示 `/ultra`

**Further reading / 延伸阅读**
- [0.4.0 Mode & Approval Contract](docs/kkcode-0.4.0-mode-contract.md)
- [0.1.13 Mode Lane Contract](docs/kkcode-0.1.13-mode-lane-contract.md)（历史归档）
- [Agent Mode Tolerance Contract](docs/kkcode-0.1.12-agent-mode-tolerance-contract.md)

---

<a id="safety-and-permissions"></a>
## Safety & Permissions / 权限与安全

**English**
- kkcode uses a policy-driven permission model with optional approvals.
- Session-scoped grants can reduce repeated prompts while preserving boundaries.
- Budget and usage controls are designed to keep long-running sessions governable.

**中文**
- kkcode 使用策略驱动的权限模型，并可叠加交互式审批。
- 会话级授权缓存可减少重复确认，同时保持边界清晰。
- 预算与用量控制让长会话、长任务仍然处于可治理状态。

**Policy examples / 策略示例**
- `permission.level: readonly | manual | accept-edits | yolo`
- switching mode rewrites the level; `/permission cycle` walks it independently
- rule-based overrides by tool / mode / file pattern / command prefix / workspace
- `permission.mode` and `permission.default_policy` are legacy fields that now map onto `permission.level`

**Always Allow / 持久授权**

The approval prompt offers `Allow Once`, `Allow Session`, `Always Allow` and
`Deny`. **Always Allow** writes a rule into the **user** config with a
`workspace` field scoping it to the current project, so the grant survives a
restart without leaking into other repositories or into your git history.
Manage them with `/permission list` and `/permission forget <n|all>`.

审批弹窗提供 `Allow Once` / `Allow Session` / `Always Allow` / `Deny` 四项。
**Always Allow** 会把规则写入**用户级**配置并带上 `workspace` 限定，重启后依然
有效，同时不会泄漏到其他仓库或用户的 git 历史。可用 `/permission list` 查看、
`/permission forget <n|all>` 撤销。

---

<a id="delegation-and-subagents"></a>
## Delegation & Subagents / 委派与子智能体

**English**
- kkcode supports bounded delegation through the `task` surface.
- Assistant mode may call subagents directly when the user explicitly asks for one or more agents.
- Use `task_group` to launch multiple parallel background subagents as one observable group.
- Use `kkcode agent list --json` to inspect built-in, custom, and configured subagent roles.
- Use `fresh_agent` for isolated implementation work.
- Use `fork_context` for read-only sidecar work such as research or verification.
- Do not outsource core understanding when the main thread must synthesize the result.

**中文**
- kkcode 通过 `task` 能力支持有边界的委派。
- 当用户显式要求一个或多个智能体工作时，Assistant 模式可以直接调用子智能体。
- 使用 `task_group` 可以把多个后台子智能体作为同一个并行组启动和观察。
- 使用 `kkcode agent list --json` 查看内置、自定义和配置覆盖后的子智能体角色。
- `fresh_agent` 适合隔离实现任务。
- `fork_context` 适合研究、审计、验证这类只读 sidecar 任务。
- 如果主线程必须综合判断，就不要把理解工作本身外包出去。

**Background task contract / 后台任务契约**
- 通过 `background_output` 查看后台任务输出
- 通过 `kkcode background parallel` 查看并行子智能体分组和 lane 状态
- 通过 `background_cancel` 取消后台任务
- 终态固定为 `completed` / `cancelled` / `error` / `interrupted`

**Further reading / 延伸阅读**
- [Task Delegation Contract Matrix](docs/task-delegation-contract-matrix.md)
- [Agent / LongAgent Extension Guide](docs/agent-longagent-compat-extension-guide.md)

---

<a id="integrations"></a>
## Integrations / 集成

### MCP
- Discover local MCP definitions and mount tools into the runtime.
- Inspect registered MCP servers from the CLI.
- Use MCP as part of the same governed tool surface.

### GitHub
- Authenticate, inspect repositories, and run GitHub-related flows from the terminal.
- Repository helpers live under `src/github/`.

### Git automation
- Local git-aware helpers support safe status, patch, and snapshot workflows.
- See [GIT_AUTO_USAGE.md](docs/GIT_AUTO_USAGE.md).

---

<a id="extensions"></a>
## Extensions / 扩展机制

**Local-first extension surface / 本地优先扩展面**
- commands
- skills
- agents
- tools
- hooks
- plugin manifests

**Directory conventions / 目录约定**
- `.kkcode/commands/`
- `.kkcode/skills/`
- `.kkcode/agents/`
- `.kkcode/tools/`
- `.kkcode/plugins/`
- `.kkcode/hooks/`
- `.kkcode-plugin/plugin.json`

**English**
- kkcode’s extension story is local-first and explicit.
- Plugins are currently an MVP surface, not a marketplace platform promise.

**中文**
- kkcode 的扩展机制是本地优先、显式可控的。
- 当前插件能力是 MVP，不代表已经承诺 marketplace 平台形态。

**Further reading / 延伸阅读**
- [ClaudeNext Agent / LongAgent Skills Compatibility](docs/claudenext-agent-longagent-skills-compat.md)
- [Agent / LongAgent Extension Guide](docs/agent-longagent-compat-extension-guide.md)

---

<a id="tui-and-cli-reference"></a>
## TUI & CLI Reference / TUI 与命令参考

### Common TUI slash commands / 常用 TUI slash 命令
- `/help` — show help
- `/status` — show runtime and operator status
- `/commands` — inspect command / skill / capability surface
- `/reload` — reload commands, skills, and agents
- `/new`, `/resume`, `/history` — session lifecycle
- `/provider`, `/model` — provider/model switching
- `/permission` — permission policy management
- `/create-skill`, `/create-agent` — generate local extensions
- `$<skill> [args]` — invoke a registered skill; `/` remains for built-in slash commands

**Interrupt semantics / 中断语义**
- `Esc` 可用于**中断当前 turn**、退出部分选择态或拒绝当前交互式请求，具体行为取决于当前上下文。

### v0.3.3 terminal interaction / 终端交互

- Drag in the transcript to select and request a clipboard copy; use the wheel
  to scroll, click the composer to place the real terminal cursor, and click a
  collapsed Thinking/tool block to inspect its details.
- 在对话区拖动即可选择并请求复制文字；滚轮可浏览历史，点击输入框会移动真实终端
  光标，为中文输入法候选窗提供实际输入锚点；点击折叠的 Thinking/工具日志可展开详情。
- Completed reasoning becomes a collapsed `Thinking · Ns` row. While it is
  running, an animated indicator and elapsed time remain visible.
- Mode, model, provider, permission, reconnect, and clipboard notices use
  transient bottom toasts instead of permanently occupying the transcript.
- Assistant output renders terminal-safe Markdown. Tool activity is muted gray;
  code mutations expose bounded red/green `-`/`+` diffs on demand.
- `Ctrl+T` toggles the latest Thinking details, `Ctrl+E` toggles the latest
  expandable block, and `Ctrl+Y` toggles automatic copy-on-select. On Unix,
  `Ctrl+Z` restores terminal state before suspending and redraws after `fg`.

If a terminal reserves mouse reporting differently, hold its native selection
modifier (commonly Shift), or set `ui.terminal.mouse: never` to return native
selection and copying of the visible frame to the terminal. In that mode the
wheel no longer controls KK Code's transcript; use `Ctrl+Up` / `Ctrl+Down` and
`Ctrl+Home` / `Ctrl+End` to browse the application history. See the
[0.3.3 terminal experience guide](docs/terminal-experience-0.3.3.md) for the
Windows, macOS, Linux, SSH/tmux, clipboard, and fallback matrix.

Automated protocol and layout tests cannot validate a GUI terminal's actual
mouse reporting, clipboard permissions, or IME candidate-window placement.
`v0.3.3` ships these terminal paths with automated coverage and documented
fallbacks. Behavior can still vary across Windows Terminal + PowerShell,
macOS Terminal/iTerm2, and Linux Wayland/X11 environments; please report mouse,
clipboard, or IME regressions with the terminal emulator, shell, and multiplexer
details.

### Main CLI commands / 主要 CLI 子命令
- `chat`
- `session`
- `background`
- `agent`
- `ultra`
- `mcp`
- `skill`
- `config`
- `doctor`
- `model`
- `usage`
- `review`
- `audit`

Run `kkcode --help` or `kkcode <command> --help` for the full surface.

---

<a id="configuration-and-project-layout"></a>
## Configuration & Project Layout / 配置与项目结构

### Key config themes / 关键配置主题
- provider/model selection
- permission and trust policy
- mode, approval and Ultra behavior
- usage and budget limits
- UI / theme settings
- MCP and extension loading

### Dynamic models and unified gateway / 动态模型与统一网关

`v0.3.3` reads the model catalog from the Base URL you configure. OpenAI-compatible
and Anthropic-compatible services can share one gateway entry:

```yaml
provider:
  default: company-gateway
  company-gateway:
    type: gateway
    protocol: openai # or anthropic
    base_url: https://gateway.example.com
    endpoints:
      openai: /v1
      anthropic: /anthropic/v1
      models: /v1/models
    api_key_env: KK_GATEWAY_API_KEY
    default_model: model-id-from-the-catalog
    discovery:
      enabled: true
      cache_ttl_ms: 900000
```

```bash
kkcode model list --provider company-gateway --refresh
kkcode model test --provider company-gateway --model model-id
kkcode model test --provider company-gateway --model model-id --probe
```

The last command is the only one above that performs a potentially billable
inference request. Catalog redirects and pagination must remain on the configured
origin. Discovery failures are explicit; KK Code may report a stale cache, but
does not silently substitute a built-in model list. Project-controlled provider
URLs and credential settings are blocked until the workspace is trusted.
Credential-bearing connections require HTTPS; authentication-free local HTTP
gateways remain available for development. See
[Gateway and model discovery](docs/gateway-model-discovery.md) and
[`configs/config-gateway.yaml`](configs/config-gateway.yaml).

### Audit and branch review / 审计与分支审查

```bash
kkcode audit verify
kkcode audit list --provider company-gateway --since 2h
kkcode review branch --base origin/main --include-working-tree
kkcode review gate
kkcode review waive <finding-id> --reason "accepted risk"
kkcode review branch --pr 123 --publish
```

Audit records form a rotating SHA-256 chain and keep prompts/model output out of
the log body. Branch review combines deterministic checks with structured model
findings; stale, incomplete, critical, and high-severity reports fail closed.
One review trace correlates its model calls, permission decision, PR publication,
waiver, and gate result. Candidate credentials are redacted before a diff is sent
to the review model.

### Project structure / 项目结构
- `src/repl.mjs` — main REPL assembly surface
- `src/repl/` — extracted REPL seams
- `src/ui/` — REPL panels and render helpers
- `src/session/` — execution loop, memory, recovery, prompts
- `src/orchestration/` — background and Ultra orchestration
- `src/skill/`, `src/plugin/`, `src/mcp/` — extension systems

**Useful docs / 推荐文档**
- [Example config](docs/config.example.yaml)
- [Multi-provider template](configs/config-multi-provider.yaml)
- [Gemini template](configs/config-gemini.yaml)
- [Kimi template](configs/config-kimi.yaml)
- [Kimi Code template](configs/config-kimi-code.yaml)
- [xAI template](configs/config-xai.yaml)
- [REPL roadmap](docs/repl-roadmap-0.1.27-0.1.36.md)

---

<a id="model-templates"></a>
## Model Templates / 模型模板

The `configs/` directory contains provider-ready templates for current OpenAI-compatible, Anthropic, DashScope, DeepSeek, GLM, Gemini, Kimi Code, Moonshot Kimi, xAI, and Ollama setups. The default examples prefer stable aliases where vendors publish them, and keep deprecated aliases only when they are still useful for migration.

`configs/` 目录包含 OpenAI-compatible、Anthropic、DashScope、DeepSeek、GLM、Gemini、Kimi Code、Moonshot Kimi、xAI 和 Ollama 的可用模板。默认示例优先使用厂商稳定别名；即将废弃的旧别名只保留为迁移兼容项。

| Provider | Default template model | Notes |
| --- | --- | --- |
| OpenAI | `gpt-5.5` | Latest high-capability API default, with `gpt-5.4` and `gpt-5.3-codex` listed for cost/coding lanes |
| Anthropic | `claude-sonnet-4-6` | Balanced default; `claude-opus-4-7` is listed for highest-complexity work |
| DashScope / Qwen | `qwen3.5-plus` | Balanced long-context default; `qwen3.5-flash` is listed for faster lower-cost work |
| DeepSeek | `deepseek-v4-flash` | Replaces old `deepseek-chat` / `deepseek-reasoner` aliases before their 2026-07-24 deprecation |
| Zhipu GLM | `glm-5.1` | New GLM default with `glm-5` and `glm-4.5` kept as fallback choices |
| Google Gemini | `gemini-3.5-flash` | Uses Gemini's OpenAI-compatible endpoint |
| Kimi Code | `k3` | Uses the dedicated Coding API and `KIMI_CODE_API_KEY`; also includes Kimi for Coding variants |
| Moonshot Kimi | `kimi-k2.6` | Current Kimi model for coding/agent work; old K2 aliases are avoided |
| xAI Grok | `grok-4.3` | xAI's current general chat default |

**日本語**: 最新テンプレートは安定版エイリアスを優先し、移行中の旧モデル名は互換用途としてのみ残しています。  
**한국어**: 최신 템플릿은 안정 별칭을 우선 사용하고, 이전 모델명은 마이그레이션 호환용으로만 유지합니다.  
**Español**: las plantillas priorizan alias estables y conservan nombres antiguos solo para migración.

Reviewed source pages on 2026-05-27: [OpenAI models](https://developers.openai.com/api/docs/models/all), [Claude models](https://platform.claude.com/docs/en/about-claude/models/overview), [Alibaba Cloud Model Studio models](https://www.alibabacloud.com/help/en/model-studio/models), [DeepSeek API](https://api-docs.deepseek.com/), [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [Kimi model list](https://platform.kimi.ai/docs/models), and [xAI models](https://docs.x.ai/developers/models).

---

<a id="updates"></a>
## Updates / 更新

KKCode checks npm dist-tags in the background on startup and caches the result under `~/.kkcode/update-state.json`. By default it only prints a notice; it does not modify your global install unless you explicitly run the updater.

```bash
kkcode update --check
kkcode update --install --channel latest
kkcode update --install --channel preview
```

Config:

```yaml
update:
  enabled: true
  notify_on_startup: true
  auto_install: false
  channel: "latest"
  check_interval_hours: 12
```

<a id="release-status"></a>
## Release Status / 发布状态

**Current stable version / 当前稳定版本**: `v0.4.1`

`v0.4.1` is the current stable npm and GitHub release. The `main` branch remains
the development line for subsequent fixes.

`v0.4.1` 是当前 npm 与 GitHub 正式稳定版本，`main` 分支继续承载后续修复与开发。

Use the Kimi Code preset without placing credentials in YAML:

```bash
export KIMI_CODE_API_KEY="..."
cp configs/config-kimi-code.yaml kkcode.config.yaml
kkcode doctor --http
kkcode chat "review this repository" --output-format text
```

`--output-format` supports `text`, `json`, `stream-json`, and the interactive-compatible
`legacy` format. In non-interactive use, progress goes to stderr and the final answer
goes to stdout. `doctor --http` shows the effective `KK-Code/<version>` request identity
with authorization values redacted.

**Latest releases / 最新发布**: [GitHub Releases](https://github.com/kkelly-offical/kkcode/releases)  
**Package / 包地址**: [npm](https://www.npmjs.com/package/@kkelly-offical/kkcode)

**English**
- `0.4.0` collapses the mode vocabulary into a five-mode `Shift+Tab` cycle
  (Plan / Agent / Agent · Auto / Ultra / YOLO), folds six permission levels into
  four, makes Always Allow persist across restarts, keeps one Ultra
  orchestration, adds a `models.fast` channel with inline ghost text, and
  scrolls the transcript while dragging a selection.
- `0.3.3` rebuilds terminal interaction around native cursor placement, mouse
  selection/scroll/click handling, transient toasts, Markdown transcripts,
  collapsible Thinking/tool details, red/green diffs, and five post-failure
  provider reconnects without replaying an active stream.
- `0.3.2` discovers models from user-configured OpenAI/Anthropic-compatible endpoints, adds unified gateway routing, traceable audit records, and AI-assisted branch/PR review.
- `0.3.1` gives every outbound request a consistent `KK-Code/0.3.1` identity, adds the Kimi Code Coding API preset, and improves terminal, tool, and orchestration reliability.
- `0.2.5` updates the YAML parser dependency to the latest stable release and clears the Dependabot advisory for deeply nested YAML collections.
- `0.2.4` separates skills into the `$` namespace while keeping legacy `/skill` compatibility, and establishes a production local compatibility baseline for kkcode, Claude Code, Codex, and OpenCode `SKILL.md` / plugin layouts.
- `0.2.3` is the stable assistant/subagent/context release: Assistant can explicitly delegate to one or many subagents, parallel lanes are observable, updater support is included, and context compaction keeps prior summaries plus recent evidence.
- `0.2.3-preview.2` validated the context compaction path.
- `0.2.3-preview.1` validated updater checks and the `kkcode update` command.
- `0.2.1` rebuilt kkcode around Assistant as the default general-purpose lane, with dedicated Agent and LongAgent modes for coding work.

**中文**
- `0.4.0` 将模式词汇收敛为 `Shift+Tab` 五档循环（Plan / Agent / Agent · Auto /
  Ultra / YOLO），权限六级合并为四级，Always Allow 授权重启后依然有效，
  Ultra 只保留一套编排，新增 `models.fast` 通道与输入框 ghost text，
  拖选文字时支持边选边滚。
- `0.3.3` 重构终端交互：真实光标与输入法定位、鼠标拖选/滚轮/点击、瞬时 Toast、
  Markdown 对话、可折叠 Thinking/工具详情、红绿 Diff，以及首次失败后的最多 5 次
  模型重连；流式内容一旦开始就绝不重放请求。
- `0.3.2` 从用户配置的 OpenAI/Anthropic 兼容端点动态发现模型，并加入统一 Gateway 路由、可追踪审计和 AI 分支/PR 审查。
- `0.3.1` 为所有出站请求统一添加 `KK-Code/0.3.1` 身份，加入 Kimi Code Coding API 预设，并提升终端、工具与编排的可靠性。
- `0.2.5` 将 YAML 解析器依赖更新到最新稳定版本，并清除深层嵌套 YAML collection 相关的 Dependabot 告警。
- `0.2.4` 将 Skill 分离到 `$` 命名空间，同时保留旧版 `/skill` 兼容，并建立 kkcode / Claude Code / Codex / OpenCode 的本地 `SKILL.md` 与插件布局生产兼容基线。
- `0.2.3` 是稳定版 Assistant / 子智能体 / 上下文版本：Assistant 可以显式委派一个或多个子智能体，并行 lane 可观察，包含更新器能力，上下文压缩会保留旧摘要和近期证据。
- `0.2.3-preview.2` 验证了上下文压缩路径。
- `0.2.3-preview.1` 验证了更新检查和 `kkcode update` 命令。
- `0.2.1` 将 kkcode 重构为以 Assistant 为默认入口的通用个人助手，同时保留专门面向代码工作的 Agent 和 LongAgent 模式。

---

<a id="compatibility-limits-and-roadmap"></a>
## Compatibility, Limits & Roadmap / 兼容性、边界与路线图

**What this README does claim / 本 README 明确声明的能力**
- terminal-native coding workflows
- governed execution and permissions
- staged LongAgent orchestration
- MCP and local extension surfaces
- local plugin and `SKILL.md` compatibility for kkcode, Claude Code, Codex, and OpenCode layouts
- session/background/task visibility

**What this README does not promise / 本 README 不承诺的能力**
- GUI-first product workflows
- IDE-native UX parity
- desktop automation platform behavior
- marketplace-style plugin ecosystem
- remote plugin marketplace install/update flows

**Roadmap references / 路线图参考**
- [REPL roadmap 0.1.27 → 0.1.36](docs/repl-roadmap-0.1.27-0.1.36.md)
- [Plugin and Skill Compatibility 0.2.4](docs/plugin-skill-compat-0.2.4.md)
- [kkcode vs claudenext compatibility notes](docs/kkcode-vs-claudenext-private-agent-longagent-compat.md)
- [kkcode vs claudenext report](docs/kkcode-vs-claudenext-private-agent-longagent-report.md)

---

<a id="faq"></a>
## FAQ / 常见问题

**Q: When should I use `longagent`? / 什么时候该用 `longagent`？**  
A: Use it when the task is clearly multi-stage, cross-file, or needs ownership/gates. Ordinary terminal assistance and small coding inspect/patch/verify loops stay in the unified `assistant`.

**Q: Can kkcode work with multiple providers? / kkcode 支持多模型厂商吗？**  
A: Yes. Provider switching is built into config and the REPL command surface.

**Q: Can I extend kkcode locally? / 可以本地扩展吗？**  
A: Yes. Commands, skills, hooks, tools, agents, and plugin manifests all have local-first support.

**Q: Does kkcode promise GUI or IDE parity? / 是否承诺 GUI 或 IDE 对等体验？**  
A: No. This release line is CLI-first and does not overclaim GUI-first capability.

---

<a id="contributing"></a>
## Contributing / 贡献

**English**
- Keep changes small, testable, and reviewable.
- Run validation before pushing:
  - `npm run lint`
  - `npm run typecheck`
  - `node ./scripts/run-node-tests.mjs`
  - `npm run release:verify`

**中文**
- 贡献尽量保持小步、可验证、可审阅。
- 推送前建议至少运行：
  - `npm run lint`
  - `npm run typecheck`
  - `node ./scripts/run-node-tests.mjs`
  - `npm run release:verify`

欢迎中英双语 issue / PR。

---

<a id="license"></a>
## License / 许可证

kkcode is licensed under **GPL-3.0**.  
See [LICENSE](LICENSE) for the full text.

---

<a id="further-reading"></a>
## Further Reading / 延伸阅读

- [CLI General Assistant Capability Matrix](docs/cli-general-assistant-capability-matrix.md)
- [0.1.13 Mode Lane Contract](docs/kkcode-0.1.13-mode-lane-contract.md)
- [Task Delegation Contract Matrix](docs/task-delegation-contract-matrix.md)
- [Agent / LongAgent Extension Guide](docs/agent-longagent-compat-extension-guide.md)
- [Plugin and Skill Compatibility 0.2.4](docs/plugin-skill-compat-0.2.4.md)
- [ClaudeNext Agent / LongAgent Skills Compatibility](docs/claudenext-agent-longagent-skills-compat.md)
- [REPL roadmap 0.1.27 → 0.1.36](docs/repl-roadmap-0.1.27-0.1.36.md)
- [Git automation usage](docs/GIT_AUTO_USAGE.md)
- [Edit diagnostics feedback contract](docs/edit-diagnostics-feedback-contract.md)
