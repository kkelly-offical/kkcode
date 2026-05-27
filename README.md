# kkcode

[![npm version](https://img.shields.io/npm/v/@kkelly-offical/kkcode?label=v0.2.6)](https://www.npmjs.com/package/@kkelly-offical/kkcode)
[![GitHub Release](https://img.shields.io/github/v/release/kkelly-offical/kkcode)](https://github.com/kkelly-offical/kkcode/releases)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-green)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**Terminal-first personal assistant with dedicated Coding Agent and LongAgent modes for governed execution and extensible local workflows.**

**终端优先、可治理、可扩展的个人助手，内置专门 Coding Agent 与 LongAgent 模式。**
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
- [Modes & LongAgent / 模式与 LongAgent](#modes-and-longagent)
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
- kkcode is a terminal-native personal assistant designed for local work, governed execution, coding, and multi-stage delivery.
- It keeps four public lanes — `assistant`, `plan`, `agent`/`code`, and `longagent` — under one CLI surface.
- It is optimized for **CLI-first** and **LongAgent-first** workflows rather than GUI-first or marketplace-first product patterns.

**中文**
- kkcode 是一个面向终端原生工作流的个人助手，强调本地事务、可治理执行、编码和多阶段交付。
- 它把四条公开执行航道 —— `assistant`、`plan`、`agent`/`code`、`longagent` —— 收敛在同一个 CLI 入口下。
- 它优先服务 **CLI-first**、**LongAgent-first** 的工程工作流，而不是 GUI 优先或 marketplace 优先的平台形态。

---

<a id="why-kkcode"></a>
## Why kkcode / 为什么选择 kkcode

**English**
- **CLI-first**: core workflows stay in the terminal.
- **LongAgent-first**: large tasks are planned, staged, and verified instead of improvised in one prompt.
- **Governed execution**: permissions, budgets, audit logs, and recovery are built in.
- **Local extensibility**: MCP, skills, commands, hooks, tools, and custom agents can all be mounted locally.

**中文**
- **CLI-first**：核心工作流都在终端内完成。
- **LongAgent-first**：复杂任务先规划、分阶段、带门禁，而不是靠单轮 prompt 硬顶。
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
| Assistant / 个人助手 | Supported | Default CLI lane for terminal-native personal work, explanation, and code understanding |
| Plan / 方案规划 | Supported | Planning without mutating the repo |
| Agent / 默认事务航道 | Supported | Local inspect/patch/verify loops |
| LongAgent / 长程编排 | Supported | Multi-stage execution, retries, gates, resumable flow |
| Permissions / 权限治理 | Supported | Policy + approvals + session cache |
| Background tasks / 后台任务 | Supported | Launch, inspect, wait, retry, cancel |
| MCP / 模型上下文协议 | Supported | Local MCP discovery and registry |
| Skills / Commands / Hooks | Supported | Local-first extensibility surface |
| Plugins / 插件包 | Preview | Local kkcode / Claude Code / Codex / OpenCode compatibility baseline |
| GUI / IDE / desktop automation | Not promised | README does not claim GUI-first product support |

For a deeper boundary matrix, see [CLI General Assistant Capability Matrix](docs/cli-general-assistant-capability-matrix.md).

---

<a id="modes-and-longagent"></a>
## Modes & LongAgent / 模式与 LongAgent

### Public lanes / 公开执行航道

| Mode | Purpose | Typical use |
| --- | --- | --- |
| `assistant` | default personal assistant | local files, logs, system checks, web lookup, Git/GitHub, notes, tasks |
| `plan` | specification / planning | producing an execution plan before mutations |
| `agent` / `code` / `coding` | dedicated coding execution | inspect + patch + verify small/medium coding tasks |
| `longagent` | staged orchestration | multi-file, multi-step, ownership-driven delivery |

**English**
- `assistant` is the default terminal personal-assistant lane.
- `agent` / `code` / `coding` is the dedicated coding lane.
- Only escalate to `longagent` when the task is clearly multi-stage or system-wide.
- Interrupted work can be resumed with the same session context.

**中文**
- `assistant` 是默认的终端个人助手航道。
- `agent` / `code` / `coding` 是专门编码航道。
- 只有在任务明显跨文件、跨阶段、影响面较大时，才建议升级到 `longagent`。
- 中断后的工作可以在同一会话中继续，不需要从零开始。
- **路由理由可见**：当 kkcode 自动建议模式变化时，会尽量解释为什么当前任务更适合留在 `assistant` / `agent` 或升级到 `longagent`。

### CLI 通用助手能力边界（0.1.13）

**公共模式契约**

- `assistant`：默认终端个人助手航道，承接本地文件、日志、系统信息、网页查询、Git/GitHub、笔记、任务整理、解释、答疑和分析。
- `plan`：**只产出规格，不执行文件变更**。
- `agent` / `code` / `coding`：专门编码航道，承接 inspect / patch / verify 小闭环事务。
- **只有出现明确重型证据时，才从 `assistant` 或 `agent` 升级到 `longagent`**。

**能力边界速览**
- 系统 / 运行时信息
- 本地目录 / 文件 / 日志检查
- 仓库 / 发布辅助
- 这**不代表** kkcode 已经承诺 GUI / 桌面自动化能力
- 默认先在 `assistant` 内处理普通终端事务；明确编码修改进入 `agent` / `code`，再判断是否需要升级

**Further reading / 延伸阅读**
- [0.1.13 Mode Lane Contract](docs/kkcode-0.1.13-mode-lane-contract.md)
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
- `permission.default_policy: ask | allow | deny`
- rule-based overrides by tool / mode / file pattern / command prefix

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

### Main CLI commands / 主要 CLI 子命令
- `chat`
- `session`
- `background`
- `agent`
- `longagent`
- `mcp`
- `skill`
- `config`
- `doctor`
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
- agent / longagent behavior
- usage and budget limits
- UI / theme settings
- MCP and extension loading

### Project structure / 项目结构
- `src/repl.mjs` — main REPL assembly surface
- `src/repl/` — extracted REPL seams
- `src/ui/` — REPL panels and render helpers
- `src/session/` — execution loop, memory, recovery, prompts
- `src/orchestration/` — background and longagent orchestration
- `src/skill/`, `src/plugin/`, `src/mcp/` — extension systems

**Useful docs / 推荐文档**
- [Example config](docs/config.example.yaml)
- [Multi-provider template](configs/config-multi-provider.yaml)
- [Gemini template](configs/config-gemini.yaml)
- [Kimi template](configs/config-kimi.yaml)
- [xAI template](configs/config-xai.yaml)
- [REPL roadmap](docs/repl-roadmap-0.1.27-0.1.36.md)

---

<a id="model-templates"></a>
## Model Templates / 模型模板

The `configs/` directory contains provider-ready templates for current OpenAI-compatible, Anthropic, DashScope, DeepSeek, GLM, Gemini, Kimi, xAI, and Ollama setups. The default examples prefer stable aliases where vendors publish them, and keep deprecated aliases only when they are still useful for migration.

`configs/` 目录包含 OpenAI-compatible、Anthropic、DashScope、DeepSeek、GLM、Gemini、Kimi、xAI 和 Ollama 的可用模板。默认示例优先使用厂商稳定别名；即将废弃的旧别名只保留为迁移兼容项。

| Provider | Default template model | Notes |
| --- | --- | --- |
| OpenAI | `gpt-5.5` | Latest high-capability API default, with `gpt-5.4` and `gpt-5.3-codex` listed for cost/coding lanes |
| Anthropic | `claude-sonnet-4-6` | Balanced default; `claude-opus-4-7` is listed for highest-complexity work |
| DashScope / Qwen | `qwen3.5-plus` | Balanced long-context default; `qwen3.5-flash` is listed for faster lower-cost work |
| DeepSeek | `deepseek-v4-flash` | Replaces old `deepseek-chat` / `deepseek-reasoner` aliases before their 2026-07-24 deprecation |
| Zhipu GLM | `glm-5.1` | New GLM default with `glm-5` and `glm-4.5` kept as fallback choices |
| Google Gemini | `gemini-3.5-flash` | Uses Gemini's OpenAI-compatible endpoint |
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

**Current release / 当前版本**: `v0.2.6`
**Latest releases / 最新发布**: [GitHub Releases](https://github.com/kkelly-offical/kkcode/releases)  
**Package / 包地址**: [npm](https://www.npmjs.com/package/@kkelly-offical/kkcode)

**English**
- `0.2.6` fixes a HIGH command-injection bug in the post-edit formatter, adds a regression test, refreshes provider templates for current model families, and expands README language coverage.
- `0.2.5` updates the YAML parser dependency to the latest stable release and clears the Dependabot advisory for deeply nested YAML collections.
- `0.2.4` separates skills into the `$` namespace while keeping legacy `/skill` compatibility, and establishes a production local compatibility baseline for kkcode, Claude Code, Codex, and OpenCode `SKILL.md` / plugin layouts.
- `0.2.3` is the stable assistant/subagent/context release: Assistant can explicitly delegate to one or many subagents, parallel lanes are observable, updater support is included, and context compaction keeps prior summaries plus recent evidence.
- `0.2.3-preview.2` validated the context compaction path.
- `0.2.3-preview.1` validated updater checks and the `kkcode update` command.
- `0.2.1` rebuilt kkcode around Assistant as the default general-purpose lane, with dedicated Agent and LongAgent modes for coding work.

**中文**
- `0.2.6` 修复 post-edit formatter 的 HIGH 命令注入漏洞，补充回归测试，按当前模型家族刷新 provider 模板，并扩展 README 多语言说明。
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
A: Use it when the task is clearly multi-stage, cross-file, or needs ownership/gates. Ordinary terminal assistance should stay in `assistant`; small coding inspect/patch/verify loops should stay in `agent` / `code`.

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
