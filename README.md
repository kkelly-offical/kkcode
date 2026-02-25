# kkcode

[![npm version](https://img.shields.io/npm/v/@kkelly-offical/kkcode)](https://www.npmjs.com/package/@kkelly-offical/kkcode)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-green)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Models](https://img.shields.io/badge/Models-Qwen%20%7C%20GLM%20%7C%20DeepSeek%20%7C%20Claude%20%7C%20GPT%20%7C%20Ollama-orange)

面向团队协作的终端 AI Coding Agent。

**可执行** — 内置 16+ 工具链，子智能体委派，主动规划与审批。
**可治理** — 三级权限策略，会话审计，Token 预算控制。
**可长跑** — LongAgent 阶段并行编排，自动重试与门禁闭环。
**多模型** — 原生支持 Qwen3.5、GLM-5、DeepSeek、Claude、GPT、Ollama 本地模型。

---

## 目录

- [快速开始](#快速开始)
- [支持的模型](#支持的模型)
- [模式系统](#模式系统)
- [LongAgent 编排](#longagent-编排)
- [主动规划](#主动规划)
- [权限系统](#权限系统)
- [内置工具](#内置工具)
- [子智能体](#子智能体)
- [Auto Memory](#auto-memory)
- [MCP 接入](#mcp-接入)
- [GitHub 集成](#github-集成)
- [扩展机制](#扩展机制)
- [会话与审计](#会话与审计)
- [TUI 交互](#tui-交互)
- [项目结构](#项目结构)
- [配置](#配置)
- [常见问题](#常见问题)
- [致谢](#致谢)
- [License](#license)

---

## 快速开始

### 环境要求

- Node.js `>=22`
- npm / pnpm
- 建议终端：Windows Terminal、iTerm2 或现代 Linux terminal

### 快速开始

```bash
npm install -g @kkelly-offical/kkcode
kkcode
```

首次启动会进入 **引导设置**，选择编程语言、技术栈、代码风格等偏好，kkcode 会在每次对话中自动应用这些设置。随时可用 `/profile` 查看或修改，`/like` 重新运行引导。

**从源码运行（开发用）：**

```bash
git clone https://github.com/kkelly-offical/kkcode.git
cd kkcode
npm install
npm run start
```

### 初始化项目配置

```bash
kkcode init -y
```

配置文件按优先级自动查找：

- 用户级：`~/.kkcode/config.yaml`
- 项目级：`./kkcode.config.yaml` 或 `./.kkcode/config.yaml`

---

## 支持的模型

kkcode 通过统一的 Provider 抽象层支持多种模型，开箱即用：

| 提供商 | 模型 | 类型 | 配置样例 |
|--------|------|------|----------|
| 阿里 DashScope | Qwen3.5-Plus、Qwen3-Max、Qwen3-Coder | `openai-compatible` | [`config-qwen3.5.yaml`](configs/config-qwen3.5.yaml) |
| 智谱 AI | GLM-5、GLM-4.5 | `openai-compatible` | [`config-glm5.yaml`](configs/config-glm5.yaml) |
| DeepSeek | DeepSeek-Chat (V3)、DeepSeek-Reasoner (R1) | `openai-compatible` | [`config-deepseek.yaml`](configs/config-deepseek.yaml) |
| Anthropic | Claude Opus 4.6、Sonnet 4.6 | `anthropic` | [`config.example.yaml`](docs/config.example.yaml) |
| OpenAI | GPT-5.3-Codex、GPT-5.2 | `openai` | [`config.example.yaml`](docs/config.example.yaml) |
| Ollama | Qwen3、DeepSeek-Coder、LLaMA 等本地模型 | `ollama` | [`config-ollama.yaml`](configs/config-ollama.yaml) |
| 任意 OpenAI 兼容 API | Kimi、Yi、Moonshot 等 | `openai-compatible` | [`config-multi-provider.yaml`](configs/config-multi-provider.yaml) |

切换模型只需修改配置文件中的 `provider.default`，或在 TUI 中使用 `/provider` 和 `/model` 命令。

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

LongAgent 是 kkcode 的核心差异能力，支持两种编排模式：

**Hybrid 模式**（默认）— 7 阶段流水线：

```
Intake → Preview → Blueprint → Git分支 → Scaffold+并行编码 → Debugging → 门禁验证 → Git合并
```

**4-Stage 模式** — 4 阶段顺序执行：

```
Preview(只读) → Blueprint(只读) → Coding(写入) → Debugging(写入)
```

### 关键机制

- **阶段并行** — 同阶段任务由独立 worker 并发执行，`max_concurrency` 控制并发数
- **文件隔离** — 每个文件仅归属一个 task，plan 阶段即检测冲突
- **自动重试** — 失败任务自动重试，优先续写未完成文件
- **门禁闭环** — build / test / review / health / budget 五项质量门禁
- **Git 集成** — 自动创建特性分支，每阶段提交，完成后合并
- **防卡死** — 检测探索循环，强制推进到下一阶段

---

## 主动规划

Agent 执行中可主动进入规划模式，无需用户手动切换：

1. Agent 遇到复杂任务时调用 `enter_plan`
2. 在规划模式下分析代码、设计方案
3. 调用 `exit_plan` 提交计划，TUI 弹出审批面板
4. 用户 Approve 或 Reject（可附反馈）
5. 批准后按计划执行，驳回则修订

---

## 权限系统

采用 **策略 + 交互审批 + 会话缓存授权** 组合模型。

- `permission.default_policy`: `ask | allow | deny`
- `permission.rules[]`: 按工具 / 模式 / 文件模式 / 命令前缀匹配细粒度规则
- 审批一次后同会话内同类操作自动放行

提供三级权限模板：[严格](configs/permission-strict.yaml) | [标准](configs/permission-standard.yaml) | [宽松](configs/permission-permissive.yaml)

TUI 审批面板：`1` allow once / `2` allow session / `3` deny / `Esc` deny

---

## 内置工具

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容（支持 offset/limit 分页） |
| `write` | 原子写文件（overwrite / append / insert） |
| `edit` | 事务性字符串替换 + 自动回滚 |
| `patch` | 按行号范围替换文件内容 |
| `glob` | 按模式搜索文件 |
| `grep` | 按正则搜索文件内容 |
| `bash` | 执行 shell 命令 |
| `task` | 委派子智能体执行子任务 |
| `todowrite` | 结构化任务管理 |
| `question` | 向用户提问 |
| `enter_plan` / `exit_plan` | 主动规划与审批 |
| `webfetch` / `websearch` | 网页抓取与搜索 |
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

## GitHub 集成

通过 GitHub Device Flow 实现安全的仓库访问，无需手动配置 Token。

```bash
kkcode --github                    # 登录并选择仓库
kkcode --github logout             # 登出
```

工作流程：登录 → 选择仓库/分支 → 选择本地或云端模式 → 进入 REPL → 退出时询问是否推送。

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
kkcode session gc            # 过期清理
kkcode usage show            # 用量统计
kkcode longagent status      # LongAgent 状态
```

---

## TUI 交互

### 状态栏

底部实时显示：`MODE` `MODEL` `TOKENS` `COST` `CONTEXT` `MEM` `PERMISSION` `LONG`

### 快捷键

| 按键 | 功能 |
|------|------|
| `Enter` | 发送 |
| `Ctrl+J` | 换行 |
| `Tab` | 模式轮换 |
| `Up/Down` | 输入历史 |
| `Ctrl+Up/Down` | 滚动日志区 |
| `Esc` | 中断当前 turn（空闲时清空输入） |
| `Ctrl+C` | busy 时中断 turn；空闲时连按两次退出 |
| `Ctrl+L` | 清空活动区 |

支持 `@图片路径` 或 `@图片URL` 引用多模态输入。

### 常用 Slash 命令

**会话**: `/new` `/resume` `/history` `/compact` `/undo`
**模式**: `/ask` `/plan` `/agent` `/longagent`
**配置**: `/provider` `/model` `/permission`
**个人**: `/profile` `/like`
**工具**: `/paste` `/status` `/keys` `/commands`
**其他**: `/help` `/clear` `/exit`

---

## 项目结构

```
kkcode/
├── src/
│   ├── index.mjs              # CLI 入口
│   ├── repl.mjs               # TUI 主循环
│   ├── core/                  # 核心类型、常量、事件总线
│   ├── config/                # 配置加载、Schema 校验、默认值
│   ├── session/               # 会话引擎、消息循环、LongAgent 编排
│   ├── tool/                  # 工具注册、执行、事务管理
│   ├── agent/                 # 子智能体（explore/reviewer/researcher）
│   ├── provider/              # 多 Provider 适配
│   ├── permission/            # 权限引擎
│   ├── mcp/                   # MCP 客户端（stdio/sse/http）
│   ├── orchestration/         # 后台任务管理与并行 worker
│   ├── observability/         # 可观测性（Metrics/Tracer）
│   ├── ui/                    # Dashboard 渲染
│   ├── storage/               # 会话/任务持久化
│   ├── usage/                 # Token 计量与预算
│   └── util/                  # 通用工具函数
├── configs/                   # 配置样例与权限模板
├── test/                      # 单元测试与集成测试
├── package.json
├── LICENSE                    # GPL-3.0
└── NOTICE.md                  # 第三方致谢与声明
```

---

## 配置

完整配置参考：[`docs/config.example.yaml`](docs/config.example.yaml)

### 配置样例（configs/ 目录）

| 文件 | 说明 |
|------|------|
| [`config-qwen3.5.yaml`](configs/config-qwen3.5.yaml) | 通义千问 Qwen3.5 系列 |
| [`config-qwen3.yaml`](configs/config-qwen3.yaml) | 通义千问 Qwen3 系列 |
| [`config-glm5.yaml`](configs/config-glm5.yaml) | 智谱 GLM-5 / GLM-4.5 |
| [`config-deepseek.yaml`](configs/config-deepseek.yaml) | DeepSeek V3 / R1 |
| [`config-ollama.yaml`](configs/config-ollama.yaml) | 本地 Ollama |
| [`config-multi-provider.yaml`](configs/config-multi-provider.yaml) | 多 Provider 组合 |
| [`permission-strict.yaml`](configs/permission-strict.yaml) | 严格权限（生产环境） |
| [`permission-standard.yaml`](configs/permission-standard.yaml) | 标准权限（日常开发） |
| [`permission-permissive.yaml`](configs/permission-permissive.yaml) | 宽松权限（个人/CI） |

---

## 常见问题

**Q: LongAgent 为什么拒绝"你好"？**
LongAgent 是执行型编排器，非编码目标会被意图识别拦截。请使用 `ask` 模式进行对话。

**Q: enter_plan 和 /plan 有什么区别？**
`/plan` 是用户手动切换模式。`enter_plan` 是 agent 执行中主动进入规划，审批通过后继续执行。

**Q: 如何切换模型？**
TUI 中使用 `/provider` 切换提供商，`/model` 切换模型。或修改配置文件中的 `provider.default`。

**Q: Auto Memory 会无限增长吗？**
注入系统提示时限制 200 行。Agent 会保持精简并删除过时条目。

**Q: 支持哪些国产模型？**
原生支持通义千问 Qwen3.5/3 系列、智谱 GLM-5/4.5、DeepSeek V3/R1，以及任何 OpenAI 兼容 API。

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
