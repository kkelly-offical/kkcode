# kkcode

![Node](https://img.shields.io/badge/Node.js-%3E%3D22-green)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

面向团队协作的终端 AI Coding Agent：兼顾 **可执行**（工具链 + 子任务）、**可治理**（权限 / 审计 / 预算）、**可长跑**（LongAgent 阶段并行编排）。

---

## 目录

- [快速开始](#快速开始)
- [模式系统](#模式系统)
- [LongAgent 编排](#longagent-编排)
- [主动规划](#主动规划)
- [权限系统](#权限系统)
- [内置工具](#内置工具)
- [子智能体](#子智能体)
- [Auto Memory](#auto-memory)
- [MCP 接入](#mcp-接入)
- [扩展机制](#扩展机制)
- [会话与审计](#会话与审计)
- [TUI 交互](#tui-交互)
- [项目结构](#项目结构)
- [配置示例](#配置示例)
- [常见问题](#常见问题)
- [致谢](#致谢)
- [License](#license)

---

## 快速开始

### 环境要求

- Node.js `>=22`
- npm / pnpm
- 建议终端：Windows Terminal、iTerm2 或现代 Linux terminal

### 安装与运行

```bash
cd kkcode
npm install
npm run start
```

全局链接（开发常用）：

```bash
npm link
kkcode
```

### 初始化项目配置

```bash
kkcode init -y
```

配置文件按优先级自动查找：

- 用户级：`~/.kkcode/config.yaml`
- 项目级：`./kkcode.config.yaml` 或 `./.kkcode/config.yaml`

---

## 模式系统

| 模式 | 目标 | 工具权限 | 典型场景 |
|---|---|---|---|
| `ask` | 问答 / 解释 | 只读 | 理解代码、解释报错 |
| `plan` | 方案拆解 | 只读 | 先出执行计划 |
| `agent` | 单轮执行 | 全工具 | 快速改代码 + 运行命令 |
| `longagent` | 长程编排 | 全工具 + 调度 | 跨文件 / 多阶段任务 |

TUI 中按 `Tab` 一键轮换模式。

---

## LongAgent 编排

LongAgent 是 kkcode 的核心差异能力，支持"意图识别 + 阶段并行 + 门禁闭环"。

### 主流程

1. **意图识别** — 非编码目标直接阻断，避免空转
2. **Intake** — 多轮澄清并生成摘要
3. **Plan Frozen** — 冻结阶段计划（StagePlan）
4. **Stage Barrier** — 同阶段任务并发执行，全部终态后推进
5. **Recovery** — 失败任务重试，优先续写 remaining files
6. **Usability Gates** — build / test / review / health / budget 全量校验
7. **完成判定** — 门禁通过 + 完成标记

### 并行与一致性

- 同阶段并发由 `max_concurrency` 控制
- 子任务由后台 worker 承载，主会话等待 barrier
- 写入工具支持 file lock，避免并发冲突
- TUI 实时显示阶段状态、进度条与文件变动摘要

---

## 主动规划

Agent 在执行过程中可**主动进入规划模式**，无需用户手动切换。

1. Agent 遇到复杂任务时调用 `enter_plan`
2. 在规划模式下分析代码、设计方案（理解 → 设计 → 审查 → 最终计划）
3. 调用 `exit_plan` 提交计划，TUI 弹出审批面板
4. 用户 **Approve** 或 **Reject**（可附反馈）
5. 批准后按计划执行，驳回则修订

---

## 权限系统

采用 **策略 + 交互审批 + 会话缓存授权** 组合模型。

- `permission.default_policy`: `ask | allow | deny`
- `permission.rules[]`: 按工具 / 模式 / 命令前缀匹配细粒度规则
- 审批一次后同会话内同类操作自动放行

TUI 审批面板：`1` allow once / `2` allow session / `3` deny / `Esc` deny

---

## 内置工具

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容（支持 offset/limit 分页） |
| `write` | 原子写文件（支持 overwrite / append / insert 模式） |
| `edit` | 事务性字符串替换 + 自动回滚 |
| `patch` | 按行号范围替换文件内容 |
| `glob` | 按模式搜索文件 |
| `grep` | 按正则搜索文件内容（支持行号、分页） |
| `bash` | 执行 shell 命令 |
| `task` | 委派子智能体执行子任务 |
| `todowrite` | 结构化任务管理 |
| `question` | 向用户提问 |
| `enter_plan` | 主动进入规划模式 |
| `exit_plan` | 提交计划等待审批 |
| `webfetch` | 抓取网页内容 |
| `websearch` | Web 搜索 |
| `codesearch` | 代码搜索引擎 |

写入安全特性：原子写、事务回滚、外部修改检测、读前编辑约束、file lock 串行化。

---

## 子智能体

通过 `task` 工具委派专项子智能体：

| 类型 | 说明 | 权限 |
|------|------|------|
| `build` | 通用构建执行 | 全工具 |
| `explore` | 快速代码探索 | 只读 |
| `reviewer` | 代码审查（bug / 安全 / 质量） | 只读 |
| `researcher` | 深度研究 + Web 搜索 | 只读 + 网络 |

支持通过 YAML/MJS 自定义子智能体，或 `/create-agent` 自动生成。

---

## Auto Memory

为每个项目维护独立持久记忆，跨会话保存项目知识。

- 存储位置：`~/.kkcode/projects/<项目名>_<hash>/memory/MEMORY.md`
- 每次会话启动时自动注入系统提示词（限 200 行）
- Agent 可直接读写记忆文件
- 状态栏显示 `MEM` 徽章表示已加载

---

## MCP 接入

支持三种传输协议：

| 传输 | 适用场景 | 关键字段 |
|------|----------|----------|
| `stdio` | 本地子进程 | `command`, `args` |
| `sse` | 远程 Streamable HTTP | `url`, `headers` |
| `http` | REST 风格 | `url`, `headers` |

自动发现：合并 `.mcp.json`、`.kkcode/mcp.json`、`~/.kkcode/mcp.json` 中的配置。

```bash
kkcode mcp test          # 健康状态
kkcode mcp tools         # 可用工具列表
```

---

## 扩展机制

| 扩展类型 | 目录 | 说明 |
|----------|------|------|
| 命令模板 | `.kkcode/commands/` | Markdown 模板，支持变量替换 |
| 技能 | `.kkcode/skills/` | 可编程技能，`/create-skill` 生成 |
| 子智能体 | `.kkcode/agents/` | YAML/MJS 定义，`/create-agent` 生成 |
| 自定义工具 | `.kkcode/tools/` | .mjs 自动加载，`/reload` 热更新 |
| 插件/Hook | `.kkcode/plugins/` | Hook 事件脚本 |
| 规则 | `.kkcode/rules/` | 项目级提示词规则 |
| 指令文件 | `KKCODE.md` | 项目级指令，自动注入提示词 |

---

## 会话与审计

- 会话存储：`~/.kkcode/sessions/`
- 审计日志：`~/.kkcode/audit-log.json`
- 事件日志：`~/.kkcode/events.log`
- 三层用量追踪：turn / session / global
- 预算策略：`warn | block`

```bash
kkcode doctor --json         # 完整诊断
kkcode session list          # 会话列表
kkcode session fsck          # 一致性检查
kkcode session gc            # 过期清理
kkcode usage show            # 用量统计
kkcode longagent status      # LongAgent 状态
```

---

## TUI 交互

### 状态栏

底部实时显示：`MODE` `MODEL` `TOKENS` `COST` `CONTEXT` `MEM` `PERMISSION` `LONG`

- **CONTEXT** 85%+ 红色告警
- **COST** 含缓存节省额（如 `↓$0.03`）

### 快捷键

| 按键 | 功能 |
|------|------|
| `Enter` | 发送 |
| `Ctrl+J` | 换行 |
| `Tab` | 模式轮换 |
| `/paste` | 粘贴剪贴板图片 |
| `Ctrl+Up/Down` | 滚动日志区 |
| `Ctrl+Home/End` | 跳转日志首尾 |
| `Up/Down` | 输入历史 |
| `Esc` | 清空输入 |
| `Ctrl+L` | 清空活动区 |
| `Ctrl+C` | 退出 |

支持 `@图片路径` 或 `@图片URL` 引用多模态输入。

### 常用 Slash 命令

`/help` `/status` `/history` `/new` `/resume` `/mode` `/provider` `/model` `/permission` `/paste` `/commands` `/reload` `/clear` `/exit`

---

## 项目结构

```
kkcode/
├── src/
│   ├── index.mjs              # CLI 入口
│   ├── repl.mjs               # TUI 主循环（输入/渲染/键盘处理）
│   ├── runtime.mjs            # 运行时初始化
│   ├── context.mjs            # 全局上下文构建
│   ├── core/                  # 核心类型、常量、事件总线
│   ├── config/                # 配置加载、Schema 校验、默认值
│   ├── session/               # 会话引擎、消息循环、系统提示词
│   │   ├── loop.mjs           # Agent 主循环（流式处理/自动续写）
│   │   ├── engine.mjs         # 会话引擎
│   │   ├── longagent.mjs      # LongAgent 编排调度
│   │   ├── longagent-plan.mjs # 阶段计划生成与冻结
│   │   ├── compaction.mjs     # 上下文压缩
│   │   ├── instinct-manager.mjs # Instinct 自动学习
│   │   └── prompt/            # 各 Provider 系统提示词模板
│   ├── tool/                  # 工具注册、执行、事务管理
│   │   ├── registry.mjs       # 内置工具定义（read/write/edit/patch/...）
│   │   ├── edit-transaction.mjs # 编辑事务与原子写入
│   │   ├── task-tool.mjs      # task 子任务委派
│   │   ├── image-util.mjs     # 图片处理与剪贴板读取
│   │   └── prompt/            # 工具使用提示词
│   ├── agent/                 # 子智能体（explore/reviewer/researcher）
│   ├── provider/              # 多 Provider 适配（Anthropic/OpenAI/Ollama/...）
│   ├── permission/            # 权限引擎与工作区信任
│   ├── mcp/                   # MCP 客户端（stdio/sse/http）
│   ├── skill/                 # 技能注册与生成
│   ├── command/               # 自定义命令加载
│   ├── commands/              # CLI 子命令（doctor/init/theme/...）
│   ├── orchestration/         # 后台任务管理与并行 worker
│   ├── plugin/                # Hook 事件总线
│   ├── ui/                    # Dashboard 渲染、活动日志
│   ├── theme/                 # 主题系统、状态栏、颜色
│   ├── storage/               # 会话/任务持久化
│   ├── usage/                 # Token 计量与预算控制
│   ├── review/                # Diff 审查工作流
│   ├── rules/                 # 规则文件加载
│   ├── knowledge/             # 知识库
│   └── util/                  # 通用工具函数（git/markdown/...）
├── templates/                 # 模板文件（主题/定价/Hook 示例）
├── test/                      # 单元测试与 E2E 测试
├── kkcode.config.yaml         # 项目默认配置
├── package.json               # Node.js 包定义
├── LICENSE                    # GPL-3.0
└── SECURITY.md                # 安全政策
```

---

## 配置示例

```yaml
provider:
  default: anthropic
  anthropic:
    type: anthropic
    base_url: https://api.anthropic.com/v1
    api_key_env: ANTHROPIC_API_KEY
    default_model: claude-sonnet-4-20250514
    thinking:
      type: enabled
      budget_tokens: 10000

agent:
  default_mode: agent
  max_steps: 8
  longagent:
    parallel:
      enabled: true
      max_concurrency: 3

permission:
  default_policy: ask

usage:
  budget:
    strategy: warn
```

完整配置参考见 [NOTICE.md](NOTICE.md)。

---

## 常见问题

**Q: LongAgent 为什么拒绝"你好"？**
LongAgent 是执行型编排器，非编码目标会被意图识别拦截。

**Q: enter_plan 和 /plan 有什么区别？**
`/plan` 是用户手动切换模式。`enter_plan` 是 agent 执行中主动进入规划，审批通过后继续执行。

**Q: Auto Memory 会无限增长吗？**
注入系统提示时限制 200 行。Agent 会保持精简并删除过时条目。

**Q: 大文件创建被截断怎么办？**
使用 `write(mode="append")` 分段追加创建，或用 `patch` 按行号范围修改。

---

## 致谢

kkcode 的设计受到以下项目的启发：

- **[Claude Code](https://github.com/anthropics/claude-code)** — Anthropic 官方 AI Coding CLI。工具体系、子智能体架构、提示词工程等核心设计以此为标杆。
- **[OpenCode](https://github.com/nicepkg/opencode)** — 开源终端 AI Coding 助手。多 Provider 支持、主题系统等借鉴了其设计。
- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Instinct 自动学习、Hook Recipes、TDD 工作流等能力受此启发。

---

## License

本项目基于 [GNU General Public License v3.0](LICENSE) 开源。

Copyright (C) 2026 kkcode team
