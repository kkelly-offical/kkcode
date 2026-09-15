# KK Code 1.0.0 内核 / SDK 分层架构与迁移路线图

状态：设计文档（本文件不改动 `src/` 任何产品代码）。
基线：`main @ 48afacc`（v0.9.3 开发起点），证据来自三份调研报告：

- **M1**：Codex 拆分调研（`.tower/comms/inbox/20260912-agent-codex-survey-tower-m1-codex.md`）
- **M2**：Kimi Code 拆分调研（`.tower/comms/inbox/20260912-agent-kimi-survey-tower-survey-summary-m2-kimi-code.md`）
- **M3**：kkcode 耦合分析（`.tower/comms/inbox/20260912-agent-kkcode-survey-tower-m3-kkcode.md`）

文中以 `M1 §4.1`、`M2 四.3`、`M3 §二.7` 形式引用报告章节编号；`M3` 的耦合点编号 1–15 与风险编号 1–4 沿用原报告。

> **范围声明（重要）**：**1.0.0 只做进程内分层** —— 在同一个 `kkcode` npm 包、同一个
> 进程里划出 kernel / sdk / frontends 三层边界。**独立 npm 包拆分（`packages/`
> workspace、`@kkcode/core`、`@kkcode/sdk` 等）是 1.x 评估项**，见 §8。本路线图
> 不含任何包发布形态的变更。

---

## 1. 现状：为什么必须分层

M3 对全部 291 个 `.mjs` 的静态 import 扫描（含 Tarjan SCC 环检测）给出的事实
（M3 §一、§二）：

| 事实 | 数字 / 位置 | 证据 |
| --- | --- | --- |
| UI 层直接 import 内核 | repl.mjs + src/repl + src/ui + src/commands + src/cli 共 **76 个文件**直接 import **47 个不同内核文件** | M3 §一 |
| 内核 boot 序列复制 | 同一套注册表初始化逻辑在 **6+ 个入口**复制粘贴 | M3 §二.A（耦合点 1–6） |
| 内核内部静态循环 | session/ 内 **8 文件 SCC**（engine↔loop↔system-prompt↔longagent 家族） | M3 §四.1 |
| 目录级双向依赖 | session↔tool、session↔orchestration、provider↔repl 共 3 组 | M3 §四.1 |
| 模块级单例 | **9 组**（EventBus、PermissionEngine、ToolRegistry、McpRegistry、SkillRegistry、HookBus、两个 prompt handler 槽位、provider 注册表） | M3 §四.2 |
| 层级倒置 | kernel/session/loop.mjs import theme/；kernel/permission/prompt.mjs 内核自己开 readline 碰 TTY | M3 §二.C（耦合点 13–15） |
| 测试印证的 de facto 内核面 | test/ 引用最多：tool/registry(16)、session/store(12)、provider/router(11)、orchestration/background-manager(9)、core/events(6) | M3 §一 |

后果已经在发生：boot 职责无归属（调用方引导一次、`executeTurn` 内部再引导一次，
M3 耦合点 5）；`/trust` 的 `reinitializeExtensions` 要手工重建五套注册表，注释
自证"少重建一套就会留下一个仍按旧信任状态工作的子系统"（M3 耦合点 6）。

**1.0.0 的目标不是"重写"，而是给这些已经存在的内核能力划出可被机器检查的边界。**

---

## 2. 目标分层（1.0.0，进程内）

```
┌────────────────────────── frontends 层（可替换的薄客户端） ─────────────────────────┐
│ src/repl.mjs · src/repl/（TUI）        src/commands/（chat/resume/review/… 子命令）  │
│ src/cli/（参数解析与分发）              src/ui/（渲染组件）                           │
│ 规则：只允许 import src/sdk/ 与 src/kernel/index.mjs；禁止 deep-import 内核内部文件   │
└──────────────────────────────────────────────────────────────────────────────────────┘
                    │  只持有 createKernel() 返回的 kernel 句柄
┌────────────────────────────── sdk 层（编程契约面） ──────────────────────────────────┐
│ src/sdk/index.mjs        —— 对外稳定面：createKernel() 再导出 + 事件类型契约          │
│ src/sdk/events.mjs       —— KernelEvent 类型表（EVENT_TYPES 的稳定子集 + 版本标记） │
│ src/sdk/types.d.mts      —— 公开 API 的 JSDoc/d.ts 类型（typecheck 守护面内）       │
│ 规则：sdk 只依赖 kernel 公开面；自身不含任何业务逻辑                                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
                    │
┌────────────────────────────── kernel 层（唯一内核） ────────────────────────────────┐
│ src/kernel/index.mjs     —— 白名单导出（facade）：只导出 §4 定义的 API 面            │
│ src/kernel/kernel.mjs    —— createKernel() 组合根：boot 序列唯一归属、单例的实例化    │
│ src/kernel/<子域>/       —— 由现有目录逐步迁入（见 §6 阶段 2–3）：                   │
│   session/（engine、loop、store、compaction、rollback、longagent 家族）              │
│   tool/  permission/  provider/  mcp/  skill/  plugin/  orchestration/  core/        │
│   agent/（内建/自定义 agent 注册表与 prompt 资产，M23 自 src/agent/ 迁入）            │
│ 规则：内核不得 import theme/、ui/、repl/、cli/、commands/；不得直接写 process.stdout │
└──────────────────────────────────────────────────────────────────────────────────────┘
                    │
┌────────────────────────────── platform / 持久化层 ──────────────────────────────────┐
│ src/config/（分层配置加载）  src/storage/（路径与落盘）  src/kernel/session/store（会话存储）│
│ src/audit/  src/observability/  src/net/  src/http/                                   │
│ ~/.kkcode/（会话、background task checkpoint、credentials）                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

目录落位说明（阶段 4 收尾时的现状）：

- **1.0.0 不新建 `packages/`**。`src/kernel/`、`src/sdk/` 是包内目录边界，不是
  发布单元；发布形态仍然是单包 `@kkelly-offical/kkcode`（package.json 不变）。
- 子域目录现有十个，均为纯机械搬迁（每域一次 rename，文件内容不变）：
  阶段 3c 迁入 core、permission、tool、provider、mcp、skill、plugin、
  orchestration、session 九域（逐域独立 PR）；M23 自 `src/agent/` 迁入
  agent/ 为第十域（git mv 保历史）—— 内建/自定义 agent 注册表与 prompt
  资产，是 boot 序列第 4 步与模式路由（resolveAgentForMode）的运行时依赖，
  归属决策见 M18 调研；frontends 对其的消费经 facade 第 3 组导出。
  frontends 对内核的引用在阶段 4 全部收敛到 `src/kernel/index.mjs` facade，
  边界由 eslint `no-restricted-imports` 与 `scripts/check-boundaries.mjs`
  在 CI 强制（§4.2.2）。
- `src/theme/`、`src/ui/`、`src/repl/` 永远留在 frontends 层；`src/config/`、
  `src/storage/` 属于 platform 层，被 kernel 单向依赖。

---

## 3. 各层职责与依赖规则

| 层 | 职责 | 允许依赖 | 禁止 |
| --- | --- | --- | --- |
| frontends | 终端交互、渲染、参数解析、用户提示（approval/question 的展示与收集） | sdk、kernel/index | deep-import kernel 内部；持有内核状态 |
| sdk | 稳定编程面：`createKernel()`、事件类型契约、公开类型；面向未来第三方嵌入与本仓库 frontends | kernel/index | 业务逻辑；绕过 kernel 直接碰 storage |
| kernel | agent loop 与回合执行、模式路由、会话存储、权限判定、工具/Skill/MCP/Hook 运行时、后台任务编排、provider 路由、领域事件发射 | platform（config/storage/audit/observability） | import 任何 frontend 文件；直接操作 TTY / process.stdout（M3 耦合点 14、15 的倒置必须消除） |
| platform | 配置分层加载、路径、落盘、审计、可观测性 | 无（叶层） | 依赖上层 |

依赖方向严格单向：frontends → sdk → kernel → platform。违反边界的 import 由
lint 规则强制（§6 阶段 4 的完成判据）。

---

## 4. Kernel 公开 API 面：`createKernel()` 组合根

API 面基于 M3 §三归纳的**现有真实接口**（本节每个签名都已在 `48afacc` 核对到
文件与行号；路径已随阶段 3c 刷新为 `src/kernel/` 现状，行号为迁移前核对值 ——
3c 是纯机械搬迁，文件内容未变），不是新发明的能力。`createKernel()` 是唯一的组合根：收口 6+ 份
boot 序列（M3 §二.A），把 9 组模块级单例收编为实例字段（M3 §四.2）。

```js
// src/kernel/kernel.mjs（阶段 2 落地）
export async function createKernel(options = {}) {
  // options: { cwd, configState?, trust?, allowProjectSources?, handlers? }
  //   handlers: { onPermissionPrompt, onQuestionPrompt, onOutput, onEvent } ——
  //   宿主回调注入，取代现在的模块级 setPermissionPromptHandler /
  //   setQuestionPromptHandler 槽位（M3 §四.2）
  //
  // 返回 kernel 句柄（下表）；配套 kernel.shutdown() 收口
  // McpRegistry.shutdown() + session flushNow()（M3 §三）
}
```

### 4.1 API 面总表

| 命名空间 | 成员 | 现状来源（已核对） | 说明 |
| --- | --- | --- | --- |
| `kernel` | `shutdown()` | M3 §三 | 收口 McpRegistry.shutdown + `flushNow()`（kernel/session/store.mjs:137） |
| `kernel.turns` | `executeTurn(options)` | kernel/session/engine.mjs:283 | 单对象参数 16 字段：prompt, contentBlocks, mode, model, sessionId, configState, providerType, baseUrl, apiKeyEnv, maxIterations, signal, output, allowQuestion, toolContext, runSpec, steerSource（勘误见 §9） |
| | `routeMode(prompt, mode, opts)` · `resolvePromptMode(...)` · `resolveMode(...)` · `getPublicModeContract(...)` | kernel/session/engine.mjs:152 / 199 / 51 / 60 | 模式路由四件套 |
| | `newSessionId()` | kernel/session/engine.mjs:210（勘误见 §9） | |
| `kernel.sessions` | `touchSession` `updateSession` `appendMessage` `appendPart` `replaceMessages` `getSession` `listSessions` `getConversationHistory` `forkSession` `markSessionStatus` `appendUserMessage` `appendAssistantMessage` | kernel/session/store.mjs:205–423 | 会话存储读写面 |
| | `compactSession(...)` | kernel/session/compaction.mjs:318 | |
| | `confirmRollback` `executeRollback` `handleRollbackIfNeeded` | kernel/session/rollback.mjs:84 / 170 / 212 | |
| `kernel.permissions` | `check` `setTrusted` `isTrusted` `clearSession` `setPersistGrantHandler` | kernel/permission/engine.mjs:52 | PermissionEngine 的方法集原样成为实例方法 |
| `kernel.tools` | `initialize` `list` `get`（ToolRegistry）+ `executeTool(...)` | kernel/tool/registry.mjs:2444、kernel/tool/executor.mjs:110 | |
| `kernel.extensions` | SkillRegistry · McpRegistry（`initialize/listTools/healthSnapshot/shutdown`）· HookBus / `initHookBus` | kernel/skill/registry.mjs:500、kernel/mcp/registry.mjs:272、kernel/plugin/hook-bus.mjs:131 / 66 | |
| `kernel.background` | `launch` `launchDelegateTask` `get` `list` `summary` · `createTaskDelegate` | kernel/orchestration/background-manager.mjs:477、kernel/orchestration/task-scheduler.mjs:200 | 进程模型契约见 §7.3 |
| `kernel.providers` | `listProviders` `getProvider` `requestProvider` `requestProviderStream` `countTokensProvider` | kernel/provider/router.mjs:28 / 32 / 280 / 395 / 567 | |
| `kernel.events` | `subscribe` `registerSink` `listenerCount` + `EVENT_TYPES` | kernel/core/events.mjs:6、kernel/core/constants.mjs:11 | 现成的内核→宿主通知通道，是 SDK 事件契约的骨干（M3 §三末条） |

### 4.2 边界纪律

1. **白名单导出**：`src/kernel/index.mjs` 只 re-export 白名单成员；其余内核文件
   一律视为私有。对照 Codex 门面 crate `codex-core-api` 的
   `#![deny(private_interfaces)]` 纪律（M1 §1、§4.2）。
   阶段 4 落地后的白名单 = §4.1 句柄面（createKernel）+ facade 头注登记的两组
   扩展：frontends 实际消费的无状态契约面（模式/事件常量、provider 目录与向导等
   纯函数）与 §7.2/§7.3 的进程级显式例外（会话存储、BackgroundManager、
   默认事件总线/默认权限引擎/默认 HookBus/两个默认提示通道、agent 注册表
   单例及其 authoring 面）。新增导出必须在
   facade 头注登记归属组与理由。
2. **deep-import 禁令**：frontends 只允许 `import ... from "../kernel/index.mjs"`
   与 `../sdk/…`；由 eslint `no-restricted-imports` + 边界脚本在 CI 强制
   （阶段 4 完成判据，已落地：`scripts/check-boundaries.mjs` 接进
   `npm run lint`，frontends → kernel 内部边数与 kernel → frontends 边数均为 0）。
3. **输出纪律**：kernel 内禁止 `process.stdout.write` / `console.log`；一切
   用户可见输出走 `kernel.events` 与宿主注入的 `handlers.onOutput`。对照
   Codex core 的 `#![deny(clippy::print_stdout)]`（M1 §2.1）与 exec 的 stdout
   契约（M1 §2.4）。现有 `output` 参数在阶段 3 纯化为数据事件通道（§7.5）。
4. **交互纪律**：kernel 不得自行在 `process.stdin/stdout` 上开 readline
   （现状 M3 耦合点 15：kernel/permission/prompt.mjs、kernel/tool/question-prompt.mjs）；
    approval/question 一律挂起为事件，由宿主 handler 解决 —— 即 Kimi Code 的
   「审批建模为可寻址资源」原则的进程内形态（M2 四.5）。

---

## 5. 对照分析：Codex / Kimi Code 拆分原则 → kkcode 映射

### 5.1 Codex 五原则（M1 §4）映射

| # | Codex 原则（证据） | kkcode 1.0.0 落点 |
| --- | --- | --- |
| C1 | 先抽纯类型协议包，内核只暴露 Manager→Thread 两类型 + submit/nextEvent 两动词（SQ/EQ；M1 §2.1、§4.1） | 进程内等价物已存在：`EventBus` + `EVENT_TYPES`（kernel/core/events.mjs:6、kernel/core/constants.mjs:11）就是 EQ；`kernel.turns.executeTurn` 就是 submit 动词。1.0.0 把 EVENT_TYPES 的稳定子集固化为 `src/sdk/events.mjs` 事件契约；独立的 `@kkcode/protocol` 类型包留到 1.x（§8） |
| C2 | 门面包隔离公共 API + 官方 sample 证明门面自足（codex-core-api、thread-manager-sample；M1 §3.1、§4.2） | `src/kernel/index.mjs` 白名单 facade（§4.2.1）；CI 增加 smoke 脚本跑通「createKernel → executeTurn 最小 turn → 收事件 → shutdown」全链路（§6 阶段 2 完成判据） |
| C3 | 所有前端收敛到一条带版本的服务协议，前端零内核依赖（tui 依赖表无 codex-core；M1 §2.2、§4.3） | 1.0.0 取进程内形态：76 个 UI 文件的 deep-import 收敛为只依赖 facade，UI 对内核内部文件 import 数 → 0（M3 §一基线 47 个文件）；网络服务层（JSON-RPC/REST）是 1.x 评估项（§8） |
| C4 | headless 模式即 SDK 机器契约，stdout 纪律用 lint 保证（exec JSONL；M1 §2.4、§3.2、§4.4） | 阶段 5 固化 headless `--output-format json` 的 stdout JSONL 契约（thinking/进度走 stderr）；kernel 禁 print 进 lint（§4.2.3）。TS SDK 薄封装 spawn CLI 的形态照抄 Codex sdk/typescript，列为 1.x |
| C5 | 单版本列车 + 「协议并存 → deprecated alias → feature flag → 删除」兼容流水线（M1 §3.4、§4.5） | kkcode 已是单包单版本；`src/kernel/core/deprecations.mjs` 已把兼容别名移除目标钉在 1.0.0（docs/ROADMAP.md §7）。1.0.0 补齐：内核公开面变更必须带 deprecated alias 一个 minor 周期，事件契约变更必须带版本标记 |

### 5.2 Kimi Code 五原则（M2 §四）映射

| # | Kimi Code 原则（证据） | kkcode 1.0.0 落点 |
| --- | --- | --- |
| K1 | 单一内核、多客户端表面（0.33.0 CLI 全表面跑 agent-core-v2、0.24.0 web 切入同一引擎；M2 一、四.1） | boot 序列 6+ 份 → 1 份（阶段 1）；`src/commands/`（chat/resume/retry/longagent/review）与 REPL 逐一改为只拿 kernel 句柄（阶段 2、4）。现状证据：M3 耦合点 1–6 |
| K2 | 协议先行、规范即契约（OpenAPI/AsyncAPI 与运行时 schema 同源，"the live spec wins"；M2 二.1、四.2） | 进程内形态：`src/sdk/events.mjs` 是事件的单一事实源，类型由它生成/校验，文档与实现冲突时以代码契约为准；事件面标 `experimental` 争取演进空间。REST/WS 活规范是 1.x（§8） |
| K3 | 事件溯源持久化 + 可重同步事件流（wire.jsonl 版本化、seq/epoch 重放；M2 三、四.3） | kkcode 会话存储已是 append 式（appendMessage/appendPart，kernel/session/store.mjs:260/288）但有 flush 缓冲与索引态。1.0.0 只做半步走：把「UI 状态即真相」改为「store 即真相、UI 为投影」写进分层规则（§3），并给 store 记录加 schema 版本字段；完整 wire.jsonl 式重放是 1.x |
| K4 | 子智能体一等公民隔离（独立 wire.jsonl、tasks/ 生命周期、委派白名单；M2 四.4） | 已有骨架：`BackgroundManager` + `createTaskDelegate` + 独立 worker 进程（M3 §四.3）。1.0.0 把 worker 入口与跨进程状态传递写成显式契约（§7.3），delegate 生命周期事件进 EVENT_TYPES 契约面 |
| K5 | 审批/问答建模为会话级可寻址资源（REST 列出/解决 + WS 推送；M2 四.5） | 进程内形态：PermissionEngine 挂起 → `permission.asked` 事件（EVENT_TYPES 已有）→ 宿主 handler 解决；取代内核自开 readline 的现状（M3 耦合点 15）。任意 frontend（TUI/headless/未来 server）都能解决同一会话的审批 |

---

## 6. 分阶段迁移路线图

总纪律：**每个阶段结束 `npm run lint`、`npm run typecheck`、`npm test` 必须全绿**。
当前基线：**258 个测试文件、约 2300+ 用例**（`grep -c` 统计 2297–2355，随断言
风格略有浮动）；用例数在每个阶段结束后**只增不减**。每阶段是独立可合入、可
回退的 PR 序列，不做长期分叉的"大重构分支"。

### 阶段 1 —— 纯边界整理（零行为变更）

不改任何可观察行为，只做代码归位与依赖方向反转。

- 1a. **收口 boot 序列**：抽出内部 `bootstrapKernelExtensions({ cwd, configState, trust })`
  函数，容纳现在 6+ 份复制的初始化顺序（ToolRegistry→SkillRegistry→
  CustomAgentRegistry→initHookBus，M3 耦合点 1–5）；repl.mjs、commands/chat.mjs、
  commands/session.mjs、commands/longagent.mjs、commands/review.mjs、
  engine.mjs:306-312 全部改调它。初始化顺序逐字保持现状。
- 1b. **破 session/ 8 文件静态环**（M3 §四.1）：以依赖倒置拆开
  engine↔system-prompt（闭环比是 system-prompt.mjs:7 → engine.mjs）与
  longagent 家族 → loop 的回向边；共享纯类型/常量下沉到无依赖的叶子模块。
  运行时解析序不变。
- 1c. **终端原语中立化**：ui/ 从 repl/ 取的纯函数（stripAnsi、padRight、
  text-layout 等，M3 §四.1 良性环）搬入 `src/ui/` 或 `src/util/`，消除 ui↔repl
  互 import。

**完成判据**（全部可机器核对）：
1. `npm run lint && npm run typecheck && npm test` 全绿，用例数 ≥ 基线。
2. `grep -rn "ToolRegistry.initialize" src/commands/ src/repl.mjs` 命中数从
   现状 6+ 处降为 0（全部改调 bootstrap 函数）。
3. 对 session/ 跑 import 环检测脚本（M3 同款 Tarjan 扫描）：8 文件 SCC 消失。
4. 新增 boot 顺序契约测试：mock 各注册表，断言初始化调用序列与现状一致
   （证明 1a 零行为变更）。

### 阶段 2 —— `createKernel()` 组合根与单例收编

- 2a. 新增 `src/kernel/kernel.mjs` + `src/kernel/index.mjs`：实现 §4 的
  createKernel 与 facade；9 组模块级单例（M3 §四.2）逐个包成 kernel 实例字段。
- 2b. **兼容策略**：每个被收编的单例保留模块级默认实例导出（deprecated alias，
  走 deprecations.mjs 通道），旧 import 路径继续工作 —— 对照 Codex 的
  ConversationManager→ThreadManager 软迁移（M1 §3.4、§4.5）。
- 2c. 各入口（repl.mjs、commands/*）改为 `createKernel()` 拿句柄；`buildContext()`
  （src/context.mjs:32）成为 kernel 内部实现细节，外部调用方迁移到句柄。

**完成判据**：
1. 三件套全绿；新增 smoke 测试：createKernel → 最小 executeTurn（mock provider）
   → 收 turn.start/turn.finish 事件 → shutdown，证明门面自足（对照 C2）。
2. 新增多实例测试：两个 createKernel() 实例的 PermissionEngine 信任态、
   ToolRegistry 工具集互不可见（证明单例收编有效，M3 §四.2 的"地雷"排除）。
3. `grep -rn "buildContext" src/repl.mjs src/commands/` 命中数 → 0。

### 阶段 3 —— 渲染解耦与目录物理迁移

- 3a. **消除内核 → theme 倒置**（M3 耦合点 14：kernel/session/loop.mjs:31-33、
  kernel/session/session-title.mjs:4 import theme/）：`output` 通道纯化为数据事件（经
  EventBus/registered sinks），ANSI 着色与 markdown 渲染移到 frontends 的 sink。
- 3b. **内核不碰 TTY**（M3 耦合点 15）：permission/question prompt 一律经
  createKernel 注入的 handler；删除内核 fallback readline（headless 宿主必须
  显式给 handler 或得到确定性 deny）。
- 3c. 子域目录物理迁入 `src/kernel/`：按 platform 先行（config/storage 不动）、
  core → permission → tool → provider → mcp/skill/plugin → orchestration →
  session 的顺序逐域搬，每域一个 PR，import 路径机械更新。

**完成判据**：
1. 三件套全绿。
2. `grep -rn "from \"../theme/" src/kernel/` 与 `grep -rn "readline" src/kernel/`
   命中数 → 0。
3. 新增无头契约测试：不注入 prompt handler 的 kernel 遇到需审批工具时收到
   确定性 deny 事件（而非阻塞读 stdin）。
4. 渲染快照测试：TUI 输出与迁移前逐字节一致（证明 3a 零行为变更）。

### 阶段 4 —— 前端收敛与边界 lint

- 4a. frontends（repl.mjs、repl/、ui/、commands/、cli/）残余 deep-import 全部
  改走 facade；`/trust`、`/compact`、rollback 等 slash 命令改用 kernel 句柄
  （M3 耦合点 7–12 逐一消除）。
- 4b. eslint `no-restricted-imports` + `scripts/` 边界检查脚本固化 §3 依赖规则，
  进 `npm run lint`。

**完成判据**：
1. 三件套全绿。
2. 边界脚本报告：frontends → kernel 内部文件的 import 边数从基线
   （M3 §一：76 文件 / 47 个内核文件）降为 **0**；对 `src/kernel/index.mjs`
   与 `src/sdk/` 的 import 不受限。
3. M3 §二 耦合点清单 15 条逐条核销（在 PR 描述里打勾）。

### 阶段 5 —— headless 机器契约（SDK 面的 1.0.0 形态）

- 5a. 固化 headless 模式的 stdout 契约：`--output-format json` 时 stdout 纯
  JSONL 一行一事件，其余输出一律 stderr（对照 Codex exec 契约，M1 §2.4）；
  事件类型即 `src/sdk/events.mjs` 契约面。
- 5b. kernel 输出纪律进 lint（§4.2.3）。

**完成判据**：
1. 三件套全绿；新增 e2e：headless 跑最小任务，断言 stdout 每行可被
   `JSON.parse` 且事件类型全部命中契约表。
2. `docs/` 增加一页 headless JSONL 契约说明（事件类型表）。

### 阶段门槛汇总

| 阶段 | 风险最高动作 | 回退单元 |
| --- | --- | --- |
| 1 | 破环时运行时解析序变化 | 单 PR revert |
| 2 | 单例实例化后隐藏共享态暴露 | 默认实例 alias 保留，按子域回退 |
| 3 | 渲染解耦改变输出字节流 | output 适配器双轨（旧 output 参数保留一个 minor） |
| 4 | slash 命令行为漂移 | 按命令回退 |
| 5 | JSONL 字段不稳定 | 契约面标 experimental（对照 K2） |

---

## 7. 风险与回退策略

### 7.1 循环依赖（M3 §四.1）

- **风险**：session/ 8 文件 SCC 目前靠 Node「调用时才解析绑定」扛着；搬目录/
  改入口时极易炸（TDZ / undefined import）。目录级双向（session↔tool、
  session↔orchestration、provider↔repl）在物理迁移时会集中暴露。
- **缓解**：阶段 1b 先破文件级环再谈搬家；阶段 3c 逐域迁移、每域独立 PR；
  CI 常驻 M3 同款环检测脚本，环数只减不增。
- **回退**：任何一环拆解导致测试变红，revert 该单 PR 即可回到绿；不允许多个
  破环动作叠在一个 PR 里。

### 7.2 模块级单例（M3 §四.2，9 组）

- **清单**：EventBus listeners/sinks（kernel/core/events.mjs:3-4）、PermissionEngine
  sessionAllow/workspaceTrusted/persistGrantHandler（kernel/permission/engine.mjs:8-10）、
  ToolRegistry state（kernel/tool/registry.mjs:41-51）、McpRegistry state 含
  initPromise 单飞锁（kernel/mcp/registry.mjs:272+）、SkillRegistry state、HookBus
  state（kernel/plugin/hook-bus.mjs:19）、两个 customPromptHandler 槽位
  （kernel/permission/prompt.mjs:4、kernel/tool/question-prompt.mjs:4）、provider 全局注册表
  （kernel/provider/router.mjs:21）。
- **风险**：收编为实例字段后，某处漏改的旧路径仍读模块级默认实例，出现
  「半迁移」状态分裂（/trust 五套注册表问题的泛化版，M3 耦合点 6）。
- **缓解**：默认实例 alias + deprecations.mjs 记录每个旧路径的调用点；阶段 2
  的多实例测试（§6.2 判据 2）是防回归闸门。哪些状态必须是**进程级**单例
  （如 McpRegistry 连接池）要显式写进 kernel 契约，而不是默认全部实例化。
- **回退**：默认实例导出长期保留到 1.x，单个子域收编失败可单独回退，不影响
  其他子域。

### 7.3 background worker 独立进程模型（M3 §四.3）

- **现状**：background-manager.mjs:317 `spawn(process.execPath, [WORKER_ENTRY,
  "--task-id", taskId])`，WORKER_ENTRY 由 import.meta.url 定位源码文件；
  worker 进程内重建整个内核（background-worker.mjs:5-13 import buildContext、
  ToolRegistry、McpRegistry、executeTurn、PermissionEngine）；主进程与 worker
  的信任态/工具集天然两份，靠 checkpoint JSON 文件与 payload 序列化做 IPC；
  另有 inline 模式（runInline，background-manager.mjs:440+）同进程跑。
- **风险**：kernel 化后「源码文件即子进程入口」的假设必须显式化，否则未来
  打包/bundle（1.x 评估项）会直接炸；worker 内 createKernel() 的 config/trust
  传递遗漏会导致后台任务与前台权限判定不一致。
- **缓解**：把 worker 入口写成显式子进程契约（稳定路径 + 参数协议 + payload
  序列化字段表）；worker 内改用 createKernel() 启动（阶段 2 后自然成立）；
  「哪些状态跨进程、如何传递」列成契约表进文档。
- **回退**：inline 模式是现成的降级通道 —— worker 模式出问题时可配置
  全量回落 runInline，功能不缺失、仅隔离性降级。

### 7.4 配置分层对 kernel 化的影响（M3 §四.4）

- **现状**：`buildContext()`（src/context.mjs:32）被 commands、repl.mjs、
  background-worker 各自调用，内部做配置加载 + session store / event log 配置
  注入；`resolveExtensionPolicy`（src/context.mjs:22）被内核（engine.mjs:16、
  loop.mjs:39）与 UI 双方依赖，是事实上的「策略内核」碎片。
- **风险**：不同宿主各自 buildContext，配置快照的生成时机/内容不一致；
  resolveExtensionPolicy 归属不定会导致 kernel 化后策略解析出现两份。
- **缓解**：配置解析收敛进 kernel —— createKernel 拥有唯一的
  loadConfig → extensionPolicy 链路，宿主只传 `cwd`/`configState` 覆盖项；
  resolveExtensionPolicy 随阶段 3c 迁入 kernel，UI 侧改从 kernel 句柄读策略。
- **回退**：buildContext 签名与行为保持不变并 re-export，外部调用方逐个迁移，
  迁一个验证一个。

### 7.5 loop → theme 渲染耦合（M3 耦合点 14、§四.4）

- **风险**：现在 `output.write` 混着 ANSI 着色字节流；直接改成数据事件会让
  TUI 输出字节变化（用户可见差异），也会让依赖 output 回调的调用方
  （commands/chat.mjs、background worker）拿到不同形态的数据。
- **缓解**：阶段 3a 先加数据事件通道、保留旧 output 适配器双轨一个 minor；
  渲染快照测试（§6.3 判据 4）钉住 TUI 字节流。
- **回退**：双轨期内随时可切回旧 output 通道；双轨删除安排在 1.0.0 收尾，
  走 deprecations.mjs 公告。

---

## 8. 1.x 评估项（明确不在 1.0.0 范围）

以下事项**不在 1.0.0 承诺内**，完成进程内分层后按当时优先级评估：

1. **独立 npm 包拆分**：`packages/` pnpm workspace（`@kkcode/core`、
   `@kkcode/protocol`、`@kkcode/sdk`、……），内部包是否单独语义化版本（对照
   Codex 全 0.0.0 + 单版本列车，M1 §3.4）。
2. **网络服务层**：JSON-RPC/REST/WS server 壳（对照 Codex app-server M1 §2.2、
   Kimi REST/WS 三件套 M2 二.1），含 wire 协议版本并存与 schema codegen。
3. **TS SDK 薄封装**：spawn `kkcode --output-format json` 的 npm 包（对照
   Codex sdk/typescript，M1 §3.2）—— 1.0.0 的 JSONL 契约（阶段 5）是其前置。
4. **完整事件溯源**：wire.jsonl 式版本化事件流 + 重放恢复（对照 K3，M2 四.3）。
5. **ACP / IDE 入口**（对照 M2 二.2）。
6. **facade 闭包的类型清扫**：阶段 4 把 frontends 全部收敛到
   `src/kernel/index.mjs` 后，facade 的传递闭包带着 283 个存量 checkJs 错误
   （45 个内核文件从未进过 typecheck 面）；`src/repl/config-persistence.mjs` 与
   `src/ui/event-scope.mjs` 因此暂时退出 tsconfig include 白名单（见 tsconfig
   头注）。逐域清零后把两个文件加回白名单。

---

## 9. 对 M3 的勘误（本文件核对于 48afacc）

1. M3 §三称 `executeTurn` 为 15 参；实际签名为单对象 **16 字段**
   （kernel/session/engine.mjs:283-299，§4.1 已逐字段列出）。
2. M3 §三把 `newSessionId` 归入 session/store.mjs；实际定义在
   **kernel/session/engine.mjs:210**，store.mjs 中只有 forkSession 的同名参数。
3. M3 §三称 buildContext 位于 src/context.mjs:78；实际 `export async function
   buildContext` 起始于 **src/context.mjs:32**（函数体约 78 行之长，
   应为行数描述）。

以上均为位置/计数细节，不影响 M3 的结论与风险判断。
