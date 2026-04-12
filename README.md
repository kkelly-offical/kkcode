# kkcode

[![npm version](https://img.shields.io/npm/v/@kkelly-offical/kkcode?label=v0.2.0)](https://www.npmjs.com/package/@kkelly-offical/kkcode)
[![GitHub Release](https://img.shields.io/github/v/release/kkelly-offical/kkcode)](https://github.com/kkelly-offical/kkcode/releases)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-green)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**Terminal-first AI coding agent for governed execution, LongAgent orchestration, and extensible local workflows.**

**终端优先、可治理、可扩展的 AI Coding Agent。**  
kkcode 把问答、规划、事务型修改、多阶段长任务编排放在同一个 CLI 工作台里，并且把权限、预算、审计、后台任务、MCP、技能与插件一起纳入统一执行面。

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
- kkcode is a terminal-native AI coding agent designed for local development, governed execution, and multi-stage delivery.
- It keeps four public lanes — `ask`, `plan`, `agent`, and `longagent` — under one CLI surface.
- It is optimized for **CLI-first** and **LongAgent-first** workflows rather than GUI-first or marketplace-first product patterns.

**中文**
- kkcode 是一个面向终端原生工作流的 AI Coding Agent，强调本地开发、可治理执行和多阶段交付。
- 它把四条公开执行航道 —— `ask`、`plan`、`agent`、`longagent` —— 收敛在同一个 CLI 入口下。
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
| Ask / 问答分析 | Supported | Read-only explanation and code understanding |
| Plan / 方案规划 | Supported | Planning without mutating the repo |
| Agent / 默认事务航道 | Supported | Local inspect/patch/verify loops |
| LongAgent / 长程编排 | Supported | Multi-stage execution, retries, gates, resumable flow |
| Permissions / 权限治理 | Supported | Policy + approvals + session cache |
| Background tasks / 后台任务 | Supported | Launch, inspect, wait, retry, cancel |
| MCP / 模型上下文协议 | Supported | Local MCP discovery and registry |
| Skills / Commands / Hooks | Supported | Local-first extensibility surface |
| Plugins / 插件包 | MVP | Local plugin manifests and component toggles |
| GUI / IDE / desktop automation | Not promised | README does not claim GUI-first product support |

For a deeper boundary matrix, see [CLI General Assistant Capability Matrix](docs/cli-general-assistant-capability-matrix.md).

---

<a id="modes-and-longagent"></a>
## Modes & LongAgent / 模式与 LongAgent

### Public lanes / 公开执行航道

| Mode | Purpose | Typical use |
| --- | --- | --- |
| `ask` | explanation / analysis | understanding code, errors, design questions |
| `plan` | specification / planning | producing an execution plan before mutations |
| `agent` | bounded local execution | inspect + patch + verify small/medium tasks |
| `longagent` | staged orchestration | multi-file, multi-step, ownership-driven delivery |

**English**
- `agent` is the default bounded execution lane.
- Only escalate to `longagent` when the task is clearly multi-stage or system-wide.
- Interrupted work can be resumed with the same session context.

**中文**
- `agent` 是默认的有界本地执行航道。
- 只有在任务明显跨文件、跨阶段、影响面较大时，才建议升级到 `longagent`。
- 中断后的工作可以在同一会话中继续，不需要从零开始。
- **路由理由可见**：当 kkcode 自动建议模式变化时，会尽量解释为什么当前任务更适合留在 `agent` 或升级到 `longagent`。

### CLI 通用助手能力边界（0.1.13）

**公共模式契约**

- `ask`：只做解释、答疑、分析。
- `plan`：**只产出规格，不执行文件变更**。
- `agent`：**默认有界本地执行航道**，优先承接 inspect / patch / verify 小闭环事务。
- **只有出现明确重型证据时，才从 `agent` 升级到 `longagent`**。

**能力边界速览**
- 系统 / 运行时信息
- 本地目录 / 文件 / 日志检查
- 仓库 / 发布辅助
- 这**不代表** kkcode 已经承诺 GUI / 桌面自动化能力
- 默认先在 `agent` 内把局部 inspect / patch / verify 做完，再判断是否需要升级

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
- Use `fresh_agent` for isolated implementation work.
- Use `fork_context` for read-only sidecar work such as research or verification.
- Do not outsource core understanding when the main thread must synthesize the result.

**中文**
- kkcode 通过 `task` 能力支持有边界的委派。
- `fresh_agent` 适合隔离实现任务。
- `fork_context` 适合研究、审计、验证这类只读 sidecar 任务。
- 如果主线程必须综合判断，就不要把理解工作本身外包出去。

**Background task contract / 后台任务契约**
- 通过 `background_output` 查看后台任务输出
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
- [REPL roadmap](docs/repl-roadmap-0.1.27-0.1.36.md)

---

<a id="release-status"></a>
## Release Status / 发布状态

**Current stable / 当前稳定版本**: `v0.2.0`  
**Latest releases / 最新发布**: [GitHub Releases](https://github.com/kkelly-offical/kkcode/releases)  
**Package / 包地址**: [npm](https://www.npmjs.com/package/@kkelly-offical/kkcode)

**English**
- `0.2.0` is the first formal release line after the staged REPL refactor from `0.1.27` to `0.1.36`.
- The release train now includes explicit verification rails and GitHub release automation.

**中文**
- `0.2.0` 是 `0.1.27` 到 `0.1.36` 这轮 REPL 分阶段重构后的首个正式版本线。
- 这条发布线已经具备显式验证护栏和 GitHub Release 自动发布能力。

---

<a id="compatibility-limits-and-roadmap"></a>
## Compatibility, Limits & Roadmap / 兼容性、边界与路线图

**What this README does claim / 本 README 明确声明的能力**
- terminal-native coding workflows
- governed execution and permissions
- staged LongAgent orchestration
- MCP and local extension surfaces
- session/background/task visibility

**What this README does not promise / 本 README 不承诺的能力**
- GUI-first product workflows
- IDE-native UX parity
- desktop automation platform behavior
- marketplace-style plugin ecosystem

**Roadmap references / 路线图参考**
- [REPL roadmap 0.1.27 → 0.1.36](docs/repl-roadmap-0.1.27-0.1.36.md)
- [kkcode vs claudenext compatibility notes](docs/kkcode-vs-claudenext-private-agent-longagent-compat.md)
- [kkcode vs claudenext report](docs/kkcode-vs-claudenext-private-agent-longagent-report.md)

---

<a id="faq"></a>
## FAQ / 常见问题

**Q: When should I use `longagent`? / 什么时候该用 `longagent`？**  
A: Use it when the task is clearly multi-stage, cross-file, or needs ownership/gates. Small inspect/patch/verify loops should stay in `agent`.

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
- [ClaudeNext Agent / LongAgent Skills Compatibility](docs/claudenext-agent-longagent-skills-compat.md)
- [REPL roadmap 0.1.27 → 0.1.36](docs/repl-roadmap-0.1.27-0.1.36.md)
- [Git automation usage](docs/GIT_AUTO_USAGE.md)
- [Edit diagnostics feedback contract](docs/edit-diagnostics-feedback-contract.md)
