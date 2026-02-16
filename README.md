# kkcode

![Node](https://img.shields.io/badge/Node.js-%3E%3D22-green)
![License](https://img.shields.io/badge/License-MIT-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

面向团队协作的终端 AI Coding CLI：兼顾 **可执行**（工具链+子任务）、**可治理**（权限/审计/预算）、**可长跑**（LongAgent 阶段并行编排）。

> 与 Claude Code、OpenCode、Codex CLI 的对比为"能力形态"对照——三者均为业界成熟的 AI Coding CLI，各有侧重。kkcode 聚焦团队治理与长程编排，对比仅为差异化说明，具体产品细节请以各自官方版本为准。

## 目录

- [1. 你能用 kkcode 做什么](#1-你能用-kkcode-做什么)
- [2. 安装与启动](#2-安装与启动)
- [3. 模式系统](#3-模式系统)
- [4. LongAgent（核心能力）](#4-longagent核心能力)
- [5. 权限系统](#5-权限系统permission)
- [6. 工具与扩展](#6-工具与扩展)
- [7. 会话、审计、预算](#7-会话审计预算)
- [8. REPL/TUI 交互](#8-repltui-交互)
- [9. 配置示例](#9-配置示例最小)
- [10. 与主流 Coding CLI 对比](#10-kkcode-与主流-coding-cli-对比)
- [11. 何时选 kkcode](#11-何时选-kkcode)
- [12. 常见问题](#12-常见问题)
- [13. 联系方式](#13-联系方式)
- [14. License](#14-license)

---

## 1. 你能用 kkcode 做什么

- 单轮快速编码：`agent` 模式直接读写代码并执行工具。
- 多轮规划与执行：`plan -> agent` 或直接 `longagent`。
- 大任务并行拆解：LongAgent 支持阶段计划、同阶段并发、阶段栅栏推进。
- 风险治理：权限询问、审查队列、预算门禁、审计日志。
- 团队定制：自定义 commands/skills/agents/tools/plugins/MCP。

---

## 2. 安装与启动

### 环境

- Node.js `>=22`
- npm / pnpm
- 建议终端：Windows Terminal、iTerm2、现代 Linux terminal

### 安装

```bash
cd kkcode
npm install
npm run start
```

或全局方式（本地开发常用）：

```bash
npm link
kkcode
```

### 初始化

```bash
kkcode init -y
```

支持配置文件候选（自动按优先级查找）：

- 用户级：`~/.kkcode/config.yaml|yml|json`、`~/.kkcode/kkcode.config.yaml|yml|json`
- 项目级：`./kkcode.config.yaml|yml|json`、`./.kkcode/config.yaml|yml|json`

---

## 3. 模式系统

| 模式 | 目标 | 工具权限 | 典型场景 |
|---|---|---|---|
| `ask` | 问答/解释 | 只读优先 | 理解代码、解释报错 |
| `plan` | 方案拆解 | 只读优先 | 先出执行计划 |
| `agent` | 单轮执行 | 全工具 | 快速改代码+运行命令 |
| `longagent` | 长程编排 | 全工具+调度 | 跨文件/多阶段任务 |

---

## 4. LongAgent（核心能力）

LongAgent 当前支持“意图识别 + 阶段并行 + 门禁闭环”。

### 4.1 主流程

1. **意图识别**：若目标非可执行编码任务，直接阻断并提示补充。
2. **Intake**：多轮澄清并生成摘要。
3. **Plan Frozen**：冻结阶段计划（StagePlan）。
4. **Stage Barrier**：同阶段任务并发执行，全部终态后再推进。
5. **Recovery**：失败任务重试并优先续写 remaining files。
6. **Usability Gates**：build/test/review/health/budget 全量校验。
7. **完成判定**：门禁通过 + 完成标记。

### 4.2 并行与一致性

- 同阶段并发由调度器控制（`max_concurrency`）。
- 子任务由后台 worker 承载，主会话等待 barrier。
- 写入工具支持 file lock，避免同文件并发破坏。
- 前端会同步显示 LongAgent 阶段状态与文件变动摘要。

### 4.3 前端显示策略

- LongAgent 模式下优先展示：`phase/stage/gate`。
- 同步展示变更文件与行数：`+added / -removed`。
- 降低中间噪音（避免内部 planner/intake 输出污染对话区）。

---

## 5. 权限系统（Permission）

kkcode 采用 **策略 + 交互审批 + 会话缓存授权** 的组合模型。

### 5.1 策略项

- `permission.default_policy`: `ask|allow|deny`
- `permission.non_tty_default`: `allow_once|deny`
- `permission.rules[]`: 按工具/模式/风险匹配细粒度规则

### 5.2 REPL 命令

- `/permission show`
- `/permission ask`
- `/permission allow`
- `/permission deny`
- `/permission non-tty allow_once`
- `/permission non-tty deny`
- `/permission session-clear`

### 5.3 TUI 审批交互

当工具触发权限询问时，TUI 内联展示审批面板（不会打乱界面布局）：

- `1` allow once
- `2` allow session
- `3` deny
- `Enter` default action
- `Esc` deny

---

## 6. 工具与扩展

### 6.1 内置工具（含写入治理）

核心工具覆盖 read/list/glob/grep/write/edit/bash/task/todowrite/question/webfetch/background_output/background_cancel。

写入相关特性：

- `write`：原子写
- `edit`：事务替换 + 回滚
- 外部修改检测与读前编辑约束
- file lock 串行化冲突写

### 6.2 MCP 服务器

kkcode 支持三种 MCP 传输协议，可通过配置文件或项目级 `.mcp.json` 接入：

| 传输 | 适用场景 | 配置关键字段 |
|------|----------|-------------|
| `stdio` | 本地子进程（默认） | `command`, `args`, `framing` |
| `sse` | 远程 Streamable HTTP | `url`, `headers` |
| `http` | 简单 REST 风格 | `url`, `headers` |

```yaml
# 配置示例（config.yaml）
mcp:
  auto_discover: true
  servers:
    my-server:
      command: node
      args: [path/to/server.mjs]
      framing: auto              # auto | content-length | newline
      health_check_method: auto  # auto | ping | tools_list
    remote-server:
      transport: sse
      url: https://mcp.example.com/sse
      headers:
        Authorization: "Bearer xxx"
```

自动发现：kkcode 会自动合并 `.mcp.json`、`.mcp/config.json`、`.kkcode/mcp.json`、`~/.kkcode/mcp.json` 中的 MCP 配置。

故障排查：

```bash
kkcode mcp test          # 查看所有服务器健康状态
kkcode mcp test --json   # JSON 格式（含 transport/reason/error）
kkcode mcp tools         # 列出可用 MCP 工具
kkcode doctor --json     # 完整诊断（含 MCP 健康摘要）
```

### 6.3 其他扩展机制

- `.kkcode/commands/`：模板命令
- `.kkcode/skills/`：可编程技能（`/create-skill` 自动生成）
- `.kkcode/agents/`：子智能体（`/create-agent` 自动生成）
- `.kkcode/tools/`：自定义工具
- `.kkcode/plugins/`：插件/hook

---

## 7. 会话、审计、预算

- 会话分片：`~/.kkcode/sessions/*.json` + `index.json`
- 背景任务：`~/.kkcode/tasks/`
- 事件日志：`~/.kkcode/events.log`
- 审计日志：`~/.kkcode/audit-log.json`
- 三层 usage：turn / session / global
- budget 策略：`warn|block`

常用命令：

```bash
kkcode doctor --json
kkcode session list
kkcode session fsck
kkcode session gc
kkcode usage show
kkcode background list
kkcode background retry --id <taskId>
kkcode longagent status
kkcode longagent plan --session <id>
```

---

## 8. REPL/TUI 交互

### Slash 命令（常用）

`/help /status /history /new /resume /mode /provider /model /permission /commands /reload /clear /exit`

### 快捷键（TUI）

- `Enter` 发送
- `Shift+Enter` / `Ctrl+J` 换行
- `Tab` 模式轮换
- `Ctrl+V` 粘贴剪贴板图片
- `PgUp/PgDn` 历史滚动
- `Esc` 清空输入
- `Ctrl+L` 清空活动区
- `Ctrl+C` 退出

---

## 9. 配置示例（最小）

```yaml
provider:
  default: openai
  openai:
    type: openai
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    default_model: gpt-5.3-codex
  anthropic:
    type: anthropic
    base_url: https://api.anthropic.com/v1
    api_key_env: ANTHROPIC_API_KEY
    default_model: claude-opus-4-6

agent:
  default_mode: agent
  max_steps: 8
  longagent:
    parallel:
      enabled: true
      max_concurrency: 3
      task_timeout_ms: 600000
      task_max_retries: 2

permission:
  default_policy: ask
  non_tty_default: deny

usage:
  budget:
    strategy: warn
```

> 📖 完整配置参考（含 `~/.kkcode/` 目录结构、每个文件的格式与样例、MCP 配置、规则/Skill/Agent 编写指南）请查阅 **[notice.md](notice.md)**。

---

## 10. kkcode 与主流 Coding CLI 对比

> 说明：以下对比聚焦「能力形态」，不代表任何厂商的完整商业规格。Claude Code、OpenCode、Codex CLI 均为业界成熟的 AI Coding CLI，各有强项，均可能随版本迭代更新。

### 10.1 核心能力对比

| 维度 | kkcode | Claude Code | OpenCode | Codex CLI |
|---|---|---|---|---|
| 本地 CLI 交互 | ✅ TUI 面板 + REPL 双模式 | ✅ 终端 + IDE + Web 多端 | ✅ 终端 + IDE + 桌面应用 | ✅ 终端 TUI + exec 脚本化 |
| 多模式切换 | ✅ 四模式 ask/plan/agent/longagent，Tab 一键轮换 | ✅ Skills + 模型/参数切换 | ✅ Plan / Build 双模式，Tab 切换 | ✅ Full Access / Read-only / Auto 三档 + Slash 命令 |
| Long-running Agent 编排 | ✅ 阶段计划 → 并行委派 → barrier 同步 → 门禁闭环 | ✅ Subagents 隔离并行 + Agent Teams 多会话协作 | ✅ 并行 Agent 会话，同项目多实例 | ✅ Plan-Review-Validate 闭环 + exec 长任务 |
| 变更文件行数摘要 | ✅ 内置统计，每次 write/edit 自动汇报 +added / -removed | ✅ Diff 展示 + Checkpoints 回滚 | ⚠️ 有 diff，无内置行数统计 | ✅ Transcript 记录变更，支持 /diff |
| 本地可编程扩展 | ✅ skills / tools / plugins / agents 四层扩展 | ✅ Skills / Hooks / MCP / Plugins，生态成熟 | ✅ 自定义 commands / tools / agents | ✅ Slash 命令 + MCP（stdio/HTTP）|
| MCP 深度接入 | ✅ 三种传输（stdio/sse/http）+ 自动发现 + 健康检查 | ✅ stdio/sse，MCP 生态成熟 | ✅ stdio/sse，配置灵活 | ✅ stdio + streaming HTTP |

### 10.2 工程治理对比

| 维度 | kkcode | Claude Code | OpenCode | Codex CLI |
|---|---|---|---|---|
| 权限策略 | ✅ 三级策略 ask/allow/deny + 细粒度 rules 按工具/模式/命令前缀匹配 | ✅ 支持 ask/allow/deny，可按工具配置 | ⚠️ 支持权限控制，粒度较粗 | ✅ Full Access / Read-only / Auto 三档，可按范围配置 |
| 会话级授权缓存 | ✅ 审批一次后同会话内同类操作自动放行 | ✅ 会话内缓存已授权操作 | ⚠️ 依模式而定 | ⚠️ 依 approval 模式而定 |
| 审计日志 | ✅ 独立 audit-log.json + events.log 双日志 | ⚠️ 有事件记录，无独立审计日志文件 | ❌ 无专用审计日志 | ❌ 无审计日志 |
| 预算门禁 | ✅ warn/block 两种策略，turn/session/global 三层 usage 追踪 | ⚠️ 有 token 用量显示，无自动阻断门禁 | ⚠️ 有用量统计，无门禁策略 | ⚠️ 有用量统计，无门禁策略 |
| 会话 fsck/gc 维护 | ✅ 内置 `session fsck` 一致性检查 + `session gc` 过期清理 | ❌ 无此功能 | ⚠️ 有基础会话管理，无 fsck/gc | ❌ 无此功能 |
| 后台任务生命周期管理 | ✅ worker 池 + 状态追踪 + 超时 + 重试 + cancel | ⚠️ Subagents 可后台执行，返回摘要 | ⚠️ 有子任务管理，无完整 worker 池 | ⚠️ exec 可脚本化，无 worker 池 |

### 10.3 编排能力对比

| 维度 | kkcode | Claude Code | OpenCode | Codex CLI |
|---|---|---|---|---|
| 阶段计划冻结 | ✅ L1 阶段生成 JSON 计划后冻结，后续严格按计划执行 | ⚠️ 有 plan 模式但计划不冻结，模型可随时偏离 | ⚠️ 有计划生成，无冻结机制 | ✅ Plan-Review-Validate，计划与 review 分离 |
| 同阶段并行委派 | ✅ 同阶段任务由 worker 池并发执行，max_concurrency 可配 | ✅ Subagents 隔离并行，可多任务同时执行 | ✅ 并行 Agent 会话，同项目多实例 | ⚠️ 单会话内串行，exec 可多进程 |
| 阶段栅栏推进 | ✅ 同阶段全部 success 后才推进下一阶段，失败触发重试 | ⚠️ Subagents 返回摘要后主会话续跑 | ⚠️ 多 Agent 独立，无显式栅栏 | ⚠️ Review 阶段可阻断，无栅栏机制 |
| 失败任务续写重试 | ✅ 失败任务自动重试，优先续写 remaining files 而非从头开始 | ⚠️ 有重试能力，无 remaining files 续写优化 | ⚠️ 有基础重试，无续写优化 | ✅ Session resume 可续接历史会话 |
| 可用性门禁 | ✅ 五维门禁：build / test / review / health / budget 全量校验 | ⚠️ 有基础检查，无系统化多维门禁 | ⚠️ 有基础检查，无系统化门禁 | ✅ Review Agent 可做代码审查门禁 |

### 10.4 可定制性对比

| 维度 | kkcode | Claude Code | OpenCode | Codex CLI |
|---|---|---|---|---|
| 项目级命令模板 | ✅ `.kkcode/commands/*.md` 模板，支持变量替换 | ✅ Skills 可 `/` 触发，CLAUDE.md 常驻 | ✅ 支持自定义命令目录 | ✅ Slash 命令可自定义，支持团队共享 |
| 自定义子智能体 | ✅ YAML/MJS 定义 + `/create-agent` 一键生成 | ✅ Subagents + Skills 可定制专属工作流 | ✅ 支持 agents 目录定义 | ⚠️ Slash 命令可扩展，无 agent 目录 |
| 本地工具目录热加载 | ✅ `.kkcode/tools/` 下 .mjs 自动加载，`/reload` 热更新 | ✅ 通过 MCP + Skills 扩展，生态丰富 | ✅ 支持工具目录加载 | ⚠️ 通过 MCP 扩展，无本地目录 |
| Hook/插件脚本 | ✅ `.kkcode/plugins/` + hook 事件机制 | ✅ Hooks + Plugins 市场 | ✅ 支持 hook 机制 | ⚠️ 无预置 hook，可脚本化扩展 |
| 规则与指令分层注入 | ✅ 全局 + 项目级 rules 分层合并注入 system prompt | ✅ CLAUDE.md 分层（全局/项目/目录级） | ✅ 指令文件分层 | ✅ AGENTS.md 分层 |

---

## 11. 何时选 kkcode

优先考虑 kkcode 的场景：

- 你需要 **团队内可控** 的编码代理（权限、审计、预算、门禁）。
- 你需要 **长程并行编排**，不止是单轮对话改代码。
- 你需要 **高可定制**：按项目接入自定义 skills/tools/agents/MCP。

---

## 12. 常见问题

### Q1: `/permission` 改完会永久保存吗？
默认是运行时生效（当前进程）。建议同步写入配置文件以固化策略。

### Q2: LongAgent 为什么会拒绝"你好"这类输入？
LongAgent是执行型编排器，非编码目标会被意图识别拦截，避免空转消耗 token。

### Q3: 如何让模型稳定优先改某些文件？
在任务目标里明确“范围文件 + 验收标准”，并结合 review/budget 门禁。

---

## 13. 联系方式

项目维护联系：`drliuxk@ecupl.edu.cn`

---

## 14. License

本项目基于 [MIT License](LICENSE) 开源。
