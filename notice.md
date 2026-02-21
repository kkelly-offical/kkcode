# kkcode 开发者配置指南

## ~/.kkcode/ 完整目录结构

```
~/.kkcode/                              # 全局根目录（可通过 KKCODE_HOME 环境变量覆盖）
│
├── config.yaml                         # 全局配置（主配置文件，YAML 格式推荐）
├── config.yml                          #   ↳ 备选文件名
├── config.json                         #   ↳ 备选文件名（JSON 格式）
├── kkcode.config.yaml                  #   ↳ 备选文件名
├── kkcode.config.yml                   #   ↳ 备选文件名
├── kkcode.config.json                  #   ↳ 备选文件名
│
├── mcp.json                            # 全局 MCP 服务器配置
├── rule.md                             # 全局规则（单文件，Markdown）
├── gate-preferences.json               # LongAgent 质量门控偏好（自动生成）
├── usage.json                          # 用量统计与定价数据（自动管理）
├── background-tasks.json               # 后台任务元数据（自动管理）
├── audit-log.json                      # 操作审计日志（自动管理）
│
├── projects/                           # Auto Memory 持久记忆（按项目隔离）
│   └── {项目名}_{hash}/
│       └── memory/
│           ├── MEMORY.md               #   主记忆文件（注入系统提示，限 200 行）
│           ├── patterns.md             #   可选：模式和约定笔记
│           └── debugging.md            #   可选：调试经验笔记
│
├── rules/                              # 全局规则目录
│   ├── 01-code-style.md                #   按文件名字母序加载
│   └── 02-security.md
│
├── skills/                             # 全局 Skill 目录
│   ├── my-skill.mjs                    #   可编程 Skill（JS Module）
│   └── my-template.md                  #   模板 Skill（Markdown）
│
├── agents/                             # 全局自定义 Sub-Agent 目录
│   ├── bug-hunter.yaml                 #   YAML 格式 Agent 定义
│   └── perf-analyzer.mjs              #   JS Module 格式 Agent 定义
│
├── commands/                           # 全局自定义命令模板
│   └── deploy.md                       #   Markdown 模板，支持变量展开
│
├── hooks/                              # 全局 Hook 模块
│   ├── pre-write.mjs                   #   JS Module Hook
│   └── post-commit.js                  #   JS Hook
│
├── sessions/                           # 会话存储（自动管理）
│   ├── index.json                      #   会话索引
│   └── {sessionId}.json                #   单个会话数据
│
├── checkpoints/                        # 会话检查点（自动管理）
│   └── {sessionId}/
│       ├── latest.json
│       └── cp_{iteration}.json
│
├── tasks/                              # 后台任务运行时（自动管理）
│   ├── {taskId}.log
│   └── {taskId}.json
│
├── locks/                              # 文件锁（自动管理）
│   └── {hash}.lock
│
├── events.log                          # 事件日志（自动轮转，默认 32MB）
└── events.{timestamp}.log              # 已轮转的事件日志（默认保留 14 天）
```

> 项目级 `.kkcode/` 目录结构与全局相同，项目级配置优先于全局。

---

## 1. 全局配置文件

支持 YAML（推荐）和 JSON 两种格式，按以下顺序查找（找到第一个即停止）：

| 优先级 | 全局路径 | 项目级路径 |
|--------|----------|------------|
| 1 | `~/.kkcode/config.yaml` | `{项目}/kkcode.config.yaml` |
| 2 | `~/.kkcode/config.yml` | `{项目}/kkcode.config.yml` |
| 3 | `~/.kkcode/config.json` | `{项目}/kkcode.config.json` |
| 4 | `~/.kkcode/kkcode.config.yaml` | `{项目}/.kkcode/config.yaml` |
| 5 | `~/.kkcode/kkcode.config.yml` | `{项目}/.kkcode/config.yml` |
| 6 | `~/.kkcode/kkcode.config.json` | `{项目}/.kkcode/config.json` |

项目级配置会深度合并到全局配置之上。所有配置项均有内置默认值，只需覆盖你想修改的字段。

### ~/.kkcode/config.yaml 完整样例

```yaml
# kkcode 全局配置
language: en                    # 界面语言: en | zh

provider:
  default: openai               # 默认提供商: openai | anthropic | ollama | openai-compatible
  openai:
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    default_model: gpt-5.3-codex
    models: [gpt-5.3-codex, gpt-5.2]
    timeout_ms: 120000
    stream_idle_timeout_ms: 120000
    max_tokens: 32768
    retry_attempts: 3
    retry_base_delay_ms: 800
    stream: true
    context_limit: null          # 上下文窗口大小（null = 使用内置默认值）
    thinking: null               # 扩展思考配置（null = 关闭）
  anthropic:
    base_url: https://api.anthropic.com/v1
    api_key_env: ANTHROPIC_API_KEY
    default_model: claude-opus-4-6
    models: [claude-sonnet-4-5, claude-sonnet-4-6, claude-haiku-4-5-20251001, claude-opus-4-6]
    timeout_ms: 120000
    stream_idle_timeout_ms: 120000
    max_tokens: 32768
    retry_attempts: 3
    retry_base_delay_ms: 800
    stream: true
    context_limit: null          # 上下文窗口大小（null = 使用内置默认值）
    thinking: null               # 扩展思考（null = 关闭；启用示例: { type: enabled, budget_tokens: 10000 }）
  ollama:
    base_url: http://localhost:11434
    api_key_env: ""
    default_model: llama3.1
    timeout_ms: 300000
    stream_idle_timeout_ms: 300000
    max_tokens: 32768
    retry_attempts: 1
    retry_base_delay_ms: 1000
    stream: true
    context_limit: null
    thinking: null
  model_context:                 # 按模型名覆盖上下文窗口大小
    deepseek-chat: 128000
    qwen-max: 128000

agent:
  default_mode: agent           # 启动默认模式: ask | plan | agent | longagent
  max_steps: 8                  # 单轮最大工具调用步数
  subagents: {}                 # 自定义 sub-agent 配置覆盖
  routing:
    categories: {}
  longagent:
    max_iterations: 0           # 0 = 无限制
    no_progress_warning: 3
    no_progress_limit: 5
    max_stage_recoveries: 3
    heartbeat_timeout_ms: 120000
    checkpoint_interval: 5
    parallel:
      enabled: true
      max_concurrency: 3
      stage_pass_rule: all_success
      task_timeout_ms: 600000
      task_max_retries: 2
    planner:
      intake_questions:
        enabled: true
        max_rounds: 6
      ask_user_after_plan_frozen: false
    scaffold:
      enabled: true
    git:
      enabled: ask              # true | false | "ask"
      auto_branch: true
      auto_commit_stages: true
      auto_merge: true
      branch_prefix: kkcode
    usability_gates:
      prompt_user: first_run    # "first_run" | "always" | false
      build:  { enabled: true }
      test:   { enabled: true }
      review: { enabled: true }
      health: { enabled: true }
      budget: { enabled: true }
    resume_incomplete_files: true

mcp:
  auto_discover: true           # 自动发现 .mcp.json 等配置
  timeout_ms: 30000
  servers: {}                   # 在 config 中直接定义 MCP 服务器（也可用独立 mcp.json）

skills:
  enabled: true
  dirs: [".kkcode/skills"]

tool:
  sources:
    builtin: true
    local: true
    mcp: true
    plugin: true
  write_lock:
    mode: file_lock
    wait_timeout_ms: 120000
  local_dirs: [".kkcode/tools", ".kkcode/tool"]
  plugin_dirs: [".kkcode/plugins", ".kkcode/plugin"]

permission:
  default_policy: ask           # ask | allow | deny
  non_tty_default: deny
  rules: []

session:
  max_history: 30
  recovery: true
  compaction_threshold_ratio: 0.7
  compaction_threshold_messages: 50
  context_cache_points: true

storage:
  session_shard_enabled: true
  flush_interval_ms: 1000
  event_rotate_mb: 32
  event_retain_days: 14

background:
  mode: worker_process
  worker_timeout_ms: 900000
  max_parallel: 2

runtime:
  tool_registry_cache_ttl_ms: 30000
  mcp_refresh_ttl_ms: 60000

review:
  sort: risk_first              # risk_first | time_order | file_order
  default_lines: 80
  max_expand_lines: 1200
  risk_weights:
    sensitive_path: 4
    large_change: 3
    medium_change: 2
    small_change: 1
    executable_script: 2
    command_pattern: 3

usage:
  pricing_file: null
  aggregation: [turn, session, global]
  budget:
    session_usd: null
    global_usd: null
    warn_at_percent: 80
    strategy: warn              # warn | block

ui:
  theme_file: null
  mode_colors:
    ask: "#8da3b9"
    plan: "#00b7c2"
    agent: "#2ac26f"
    longagent: "#ff7a33"
  layout: compact               # compact | comfortable
  markdown_render: true
  status:
    show_cost: true
    show_token_meter: true
```

---

## 2. MCP 服务器配置

### ~/.kkcode/mcp.json

独立的 MCP 配置文件，与 Cursor / Claude Code 的 `.mcp.json` 格式兼容。`servers` 和 `mcpServers` 字段均可识别。

```jsonc
{
  "mcpServers": {
    // ── stdio 传输（默认）── 启动子进程通信
    "mongodb": {
      "command": "npx",
      "args": ["-y", "mongodb-mcp-server",
        "--connectionString", "mongodb://localhost:27017/mydb"
      ],
      "env": {}
      // Windows 上自动启用 shell: true，无需手动设置
      // 如需强制关闭: "shell": false
    },

    // ── 另一个 stdio 示例 ──
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-filesystem", "/path/to/allowed/dir"],
      "startup_timeout_ms": 10000,
      "request_timeout_ms": 30000,
      "health_check_method": "auto",   // auto | ping | tools_list
      "framing": "auto"                // auto | content-length | newline
    },

    // ── SSE / Streamable HTTP 传输 ── 连接远程 MCP 服务
    "figma": {
      "transport": "sse",
      "url": "http://localhost:3845/sse",
      "headers": {}
    },

    // ── HTTP 传输 ── 简单 REST 风格
    "my-api": {
      "transport": "http",
      "url": "http://localhost:8080",
      "headers": { "Authorization": "Bearer xxx" },
      "timeout_ms": 10000
    },

    // ── 禁用某个服务器 ──
    "disabled-example": {
      "command": "some-server",
      "enabled": false
    }
  }
}
```

### MCP 自动发现

`auto_discover: true`（默认）时，kkcode 按以下顺序合并 MCP 配置（先发现的优先）：

| 优先级 | 路径 | 说明 |
|--------|------|------|
| 1 | `{项目}/.mcp.json` | Claude Code / VS Code 约定 |
| 2 | `{项目}/.mcp/config.json` | 目录约定 |
| 3 | `{项目}/.kkcode/mcp.json` | kkcode 项目级 |
| 4 | `~/.kkcode/mcp.json` | kkcode 全局 |

`config.yaml` 中 `mcp.servers` 里定义的服务器会覆盖自动发现的同名服务器。

> kkcode 还内置了一个 `context7` MCP 服务器（`@upstash/context7-mcp`），启动时自动安装并注册。如需禁用，在 `mcp.json` 中设置 `"context7": { "enabled": false }`。

### MCP 故障排查

```bash
kkcode mcp test          # 查看所有 MCP 服务器健康状态
kkcode mcp test --json   # JSON 格式输出（含 transport/reason/error）
kkcode mcp list          # 列出健康的服务器
kkcode mcp tools         # 列出所有可用 MCP 工具
kkcode doctor --json     # 完整诊断（含 mcp 节点）
```

启动时 kkcode 会打印每个 MCP 服务器的连接状态：

```
  mcp ✓ mongodb (6 tools, stdio)
  mcp ✗ figma connection_refused
```

---

## 3. 规则文件

规则会注入到系统提示词中，影响 AI 的行为。支持单文件和目录两种方式。

### ~/.kkcode/rule.md（全局单文件规则）

```markdown
# 代码风格

- 使用 2 空格缩进
- 函数命名使用 camelCase
- 组件命名使用 PascalCase
- 所有公开 API 必须有 JSDoc 注释

# 安全要求

- 禁止使用 eval()
- 所有用户输入必须验证和转义
- 数据库查询必须使用参数化查询
```

### ~/.kkcode/rules/ 目录（多文件规则）

目录下的 `.md` 文件按文件名字母序加载，适合分类管理：

```
~/.kkcode/rules/
  01-code-style.md       # 代码风格规则
  02-security.md         # 安全规则
  03-testing.md          # 测试规则
```

> 项目级规则放在 `{项目}/.kkcode/rule.md` 或 `{项目}/.kkcode/rules/`，与全局规则叠加（不覆盖）。
> 加载顺序：全局单文件 → 全局目录 → 项目单文件 → 项目目录。

---

## 4. Skill 文件

Skills 是可复用的提示词模板，通过 `/skill名` 命令调用。

### ~/.kkcode/skills/my-skill.mjs（可编程 Skill）

```javascript
export const name = "api-doc"
export const description = "为指定模块生成 API 文档 (usage: /api-doc <module path>)"

export async function run(ctx) {
  const target = (ctx.args || "").trim()
  if (!target) {
    return "请指定模块路径。\n\n用法: /api-doc src/utils/auth.mjs"
  }

  return `为以下模块生成完整的 API 文档: ${target}

要求:
1. 读取模块源码，分析所有导出的函数、类、常量
2. 为每个导出项生成 JSDoc 格式文档
3. 包含参数类型、返回值、使用示例
4. 输出为 Markdown 格式`
}
```

### ~/.kkcode/skills/refactor.md（模板 Skill）

```markdown
---
name: refactor
description: "重构指定文件或函数"
---

对以下目标进行重构: $ARGS

重构原则:
1. 保持外部行为不变
2. 提取重复代码为独立函数
3. 简化条件逻辑
4. 改善命名清晰度
5. 运行现有测试确认无回归
```

### 内置 Skills

kkcode 预置了以下 skills，无需配置即可使用：

| Skill | 命令 | 说明 |
|-------|------|------|
| commit | `/commit` | 生成 Conventional Commits 格式的 git 提交 |
| review | `/review [path]` | 代码审查（正确性、安全、质量、性能） |
| debug | `/debug <error>` | 系统化调试：复现 → 定位 → 修复 → 验证 |
| frontend | `/frontend <desc>` | 框架感知的前端开发（Vue/React/Next/Nuxt/Svelte） |
| init | `/init <framework>` | 项目脚手架（vue/react/next/nuxt/svelte/node/express） |
| tdd | `/tdd <desc>` | TDD 工作流引导：RED → GREEN → REFACTOR |
| backend-patterns | `/backend-patterns` | 后端开发模式参考（API 设计、数据库、缓存等） |
| frontend-patterns | `/frontend-patterns` | 前端开发模式参考（组件设计、状态管理等） |
| security-checklist | `/security-checklist` | 安全审查清单（OWASP Top 10、依赖审计等） |

---

## 5. 自定义 Agent 文件

### ~/.kkcode/agents/bug-hunter.yaml

```yaml
name: bug-hunter
description: "扫描代码中的 bug 和安全漏洞"
mode: subagent
permission: readonly
tools: [read, glob, grep, list, bash]
prompt: |
  You are a bug-hunting specialist. Scan code for logic errors,
  security vulnerabilities, race conditions, and resource leaks.
  Report with file path, line number, severity, and suggested fix.
```

### ~/.kkcode/agents/perf-analyzer.mjs

```javascript
export const name = "perf-analyzer"
export const description = "分析代码性能瓶颈"
export const mode = "subagent"
export const permission = "readonly"
export const tools = ["read", "glob", "grep", "bash"]
export const prompt = `You are a performance analysis specialist.
Identify N+1 queries, unnecessary allocations, missing memoization,
and hot path bottlenecks. Suggest concrete optimizations with benchmarks.`
```

也可通过 `/create-agent <描述>` 命令让 AI 自动生成 agent 定义。

---

## 6. 自定义命令模板

### ~/.kkcode/commands/deploy.md

```markdown
---
name: deploy
description: "部署到指定环境"
template: "deploy $1 $RAW"
---
```

调用方式: `/deploy staging --dry-run`
展开为: `deploy staging --dry-run`

---

## 7. Hook 模块

Hooks 在特定事件（工具调用前后、消息提交等）时执行。

### ~/.kkcode/hooks/pre-write.mjs

```javascript
export const event = "tool.write.before"

export async function handler(ctx) {
  // ctx.args 包含工具参数
  // 返回 { block: true, reason: "..." } 可阻止操作
  if (ctx.args?.path?.includes(".env")) {
    return { block: true, reason: "禁止修改 .env 文件" }
  }
}
```

---

## 8. 项目级指令文件

在项目根目录放置以下文件，内容会注入到系统提示词中（按优先级，找到即停止）：

| 文件名 | 说明 |
|--------|------|
| `AGENTS.md` | Claude Code 约定 |
| `CLAUDE.md` | Claude Code 约定 |
| `CONTEXT.md` | 通用约定 |
| `KKCODE.md` | kkcode 专用 |
| `.kkcode.md` | kkcode 专用（隐藏文件） |
| `kkcode.md` | kkcode 专用 |

> 所有匹配的文件都会加载，不是只加载第一个。

---

## 9. 项目级 .kkcode/ 目录

```
{项目}/
  .kkcode/
    config.yaml              # 项目级配置（深度合并到全局之上）
    mcp.json                 # 项目级 MCP 服务器
    rule.md                  # 项目级规则（单文件）
    rules/                   # 项目级规则（目录）
      api-conventions.md
    skills/                  # 项目级 Skill
      project-deploy.mjs
    agents/                  # 项目级自定义 Agent
      domain-expert.yaml
    tools/                   # 项目级自定义工具
    plugins/                 # 项目级插件
    hooks/                   # 项目级 Hook
    commands/                # 项目级自定义命令
```

---

## 10. 模式说明

| 模式 | 说明 | 可用工具 |
|------|------|----------|
| `ask` | 纯问答，不调用写入工具 | read, glob, grep, list, websearch, webfetch, codesearch, background_output, todowrite, enter_plan, exit_plan |
| `plan` | 只读分析，生成计划但不修改文件 | 同 ask |
| `agent` | 完整 agent，可读写文件、执行命令 | 全部工具 |
| `longagent` | 长任务自治模式，多阶段并行执行 | 全部工具 + 阶段管理 |

运行时切换：`/mode agent` 或 `/mode longagent`

### 主动规划工具

Agent 在执行过程中可以主动进入规划模式（所有模式均可使用）：

| 工具 | 说明 |
|------|------|
| `enter_plan` | Agent 主动进入规划阶段，后续输出为计划内容 |
| `exit_plan` | 提交计划给用户审批，TUI 弹出 Approve / Reject 面板 |

工作流：`enter_plan` → 分析代码、设计方案 → `exit_plan` → 用户审批 → 批准后执行

### 内置子智能体

通过 `task` 工具委派子任务：

| 类型 | 说明 | 权限 |
|------|------|------|
| `explore` | 快速代码探索和文件搜索 | 只读 |
| `reviewer` | 代码审查（bug、安全、质量） | 只读 |
| `researcher` | 深度研究，结合代码分析与 Web 搜索 | 只读 |
| `architect` | 功能架构设计（分析代码模式、设计实现蓝图） | 只读 |
| `guide` | kkcode 自助指南（解答 kkcode 功能、配置、使用问题） | 只读 |
| `security-reviewer` | 安全审计（OWASP Top 10、密钥扫描、依赖审计） | 只读 |
| `tdd-guide` | TDD 专家（RED → GREEN → REFACTOR，目标 80%+ 覆盖率） | 全工具 |
| `build-fixer` | 构建错误诊断与修复（TypeScript、Python、Go、Rust、Java） | 全工具 |

---

## 11. 常用命令速查

| 命令 | 说明 |
|------|------|
| `/mode <mode>` | 切换模式 (ask/plan/agent/longagent) |
| `/model <name>` | 切换模型 |
| `/provider <name>` | 切换提供商 |
| `/commit` | AI 生成 git 提交 |
| `/review [path]` | 代码审查 |
| `/debug <error>` | 系统化调试 |
| `/create-skill <desc>` | AI 生成自定义 skill |
| `/create-agent <desc>` | AI 生成自定义 sub-agent |
| `/reload` | 重新加载命令、skill、agent |
| `/status` | 查看 LongAgent 运行状态 |
| `/stop` | 停止 LongAgent |
| `/resume` | 从检查点恢复 LongAgent |
| `/cost` | 查看当前会话费用 |
| `/help` | 显示帮助信息 |

### GitHub 集成命令

| 命令 | 说明 |
|------|------|
| `kkcode --github` | 启动 GitHub 登录流程，自动打开浏览器并复制验证码 |
| `kkcode --github logout` | 登出 GitHub 账户，清除本地 Token |

---

## 12. GitHub 集成

kkcode 支持通过 GitHub Device Flow 安全地访问您的 GitHub 仓库，无需手动配置 Personal Access Token。

### 12.1 登录流程

```bash
kkcode --github
```

执行命令后：

1. **自动打开浏览器** — 自动弹出 GitHub 设备授权页面
2. **自动复制验证码** — 设备码自动复制到剪贴板，直接粘贴即可
3. **自动轮询授权状态** — 无需手动操作，自动等待用户完成网页授权
4. **增强网络容错** — 针对不稳定网络环境优化，自动重试机制

### 12.2 本地/云端操作选项

登录成功后，选择仓库和分支时，如果本地已存在该仓库，提供三种操作模式：

| 选项 | 说明 |
|------|------|
| **使用本地仓库** | 直接使用本地代码，不执行任何更新操作 |
| **同步云端代码** | 执行 `git pull` 拉取云端最新代码 |
| **强制重新克隆** | 删除本地仓库后重新完整克隆 |

### 12.3 退出后自动推送

完成编码工作退出 REPL 后，如果检测到本地有未推送的更改：

```
🚀 检测到本地更改，是否推送至云端？(y/N)
```

输入 `y` 自动执行 `git add`、`commit`（AI 生成提交信息）和 `push`。

### 12.4 登出

```bash
kkcode --github logout
```

清除本地存储的 GitHub Token，下次使用需重新授权。

### 12.5 存储位置

GitHub Token 存储在：`~/.kkcode/github-token.json`

---

## 13. 图片引用

在输入中引用图片，支持本地文件和远程 URL 两种方式：

| 语法 | 说明 | 示例 |
|------|------|------|
| `@路径` | 本地图片文件 | `@screenshot.png`、`@./img/demo.jpg` |
| `@"带空格路径"` | 含空格的本地路径 | `@"my files/screenshot.png"` |
| `@URL` | 远程图片 URL | `@https://example.com/img.png` |
| `@"URL"` | 带引号的远程 URL | `@"https://example.com/my image.png"` |
| 裸路径 | 自动识别本地图片路径 | `./img/demo.png` |
| 裸 URL | 自动识别远程图片 URL | `https://example.com/img.png` |

支持的图片格式：`png`、`jpg/jpeg`、`gif`、`webp`、`bmp`、`svg`

> 图片会被 base64 编码后作为多模态内容发送给模型。远程图片有 15 秒超时和 20MB 大小限制。

---

## 14. Auto Memory（持久记忆）

kkcode 为每个项目维护独立的持久记忆，跨会话保存项目知识和用户偏好。

### 存储位置

```
~/.kkcode/projects/<项目名>_<hash>/memory/
├── MEMORY.md        # 主记忆文件（自动注入系统提示，限 200 行）
├── patterns.md      # 可选：项目模式和约定
├── debugging.md     # 可选：调试经验
└── ...              # 可按主题自由创建
```

- `<项目名>` 取自 `cwd` 的 basename（最多 30 字符，仅保留 `[a-zA-Z0-9_-]`）
- `<hash>` 取自 `cwd` 的 MD5 前 12 位，确保不同路径下的同名项目不冲突

### 工作机制

1. 每次会话开始时，`MEMORY.md` 的内容（前 200 行）会自动注入系统提示词
2. Agent 可以通过 `write` / `edit` 工具直接读写记忆文件
3. Agent 被指导在遇到可复用的模式时主动记录，在发现过时信息时主动清理

### 适合记录

- 项目架构决策、技术栈约定
- 重要文件路径和模块关系
- 用户偏好（工作流、工具选择、沟通风格）
- 反复出现的问题和调试方案

### 不适合记录

- 会话级临时状态（当前任务进度等）
- 未经验证的推测
- 与项目指令文件（KKCODE.md 等）重复的内容

### TUI 状态栏

当 `MEMORY.md` 存在且非空时，状态栏会显示 `MEM` 徽章。

---

## 15. 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `KKCODE_HOME` | 覆盖 `~/.kkcode` 根目录位置 |

---

## 16. 快速上手

```bash
# 1. 设置 API Key
export ANTHROPIC_API_KEY="sk-ant-..."

# 2. 初始化项目配置（可选）
kkcode init --yes

# 3. 创建全局规则（可选）
mkdir -p ~/.kkcode
cat > ~/.kkcode/rule.md << 'EOF'
- 使用中文回复
- 代码注释用英文
- 遵循项目现有代码风格
EOF

# 4. 配置 MCP 服务器（可选）
cat > ~/.kkcode/mcp.json << 'EOF'
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "mongodb-mcp-server",
        "--connectionString", "mongodb://localhost:27017/mydb"]
    }
  }
}
EOF

# 5. 启动
kkcode
```
