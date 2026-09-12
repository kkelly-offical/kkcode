# Headless JSONL 机器契约（1.0.0）

状态：**1.0.0 契约面**（`turn.result` stable / `assistant.delta` experimental，见下文稳定性承诺）。
适用命令：`kkcode chat --output-format json` 与 `kkcode chat --output-format stream-json`。
单一事实源：事件类型表由代码导出（`src/cli/output-format.mjs` 的
`HEADLESS_JSONL_EVENTS`），本页是它的说明；两者漂移时以代码为准并有测试钉住
（`test/output-format.test.mjs`）。

本页是 1.0.0 内核/SDK 分层的 SDK 面收口（docs/architecture-kernel-sdk-1.0.0.md
§6 阶段 5），对照 Codex `exec` 的 JSONL 契约（M1 §2.4）与 Kimi Code 的
stream-json stdout/stderr 分离（M2）。1.x 的 TS SDK 薄封装（spawn CLI 换
JSONL，对照 Codex sdk/typescript）以本契约为前置。

---

## 1. 流纪律（本契约的核心）

| 流 | 内容 | 保证 |
| --- | --- | --- |
| **stdout** | 纯 JSONL：每行恰好一个 JSON 事件 | 每行可被 `JSON.parse`；以 `\n` 结尾；带 `schemaVersion` 与 `type`；`type` 必在 §3 事件类型表内；绝不出现进度条、日志、提示语、ANSI 着色 |
| **stderr** | 进度、路由说明、诊断、警告、审批/提问提示 | 人类可读文本；机器消费方**不得**解析 stderr |

- 进程级失败（配置缺失、参数错误、未捕获异常）：退出码非 0，stdout 保持纯
  JSONL（通常为零事件），错误文本只出现在 stderr。
- 交互提示（权限审批、问答）：非 TTY 下不发生（内核确定性收口）；TTY 下提示
  写 stderr，stdout 契约不被污染（`src/cli/tty-prompts.mjs`）。
- kernel 侧由 lint 强制同一纪律：`src/kernel/` 禁止 `process.stdout.write` 与
  `console.log/info/debug/dir`（eslint `no-restricted-syntax` +
  `scripts/check-boundaries.mjs` 的 `findKernelStdoutViolations`，架构
  §4.2.3；对照 Codex core 的 `#![deny(clippy::print_stdout)]`）。
  `console.error/warn` 写 stderr，是允许的诊断通道。

消费侧最小解析（jq / shell）：

```bash
kkcode chat "summarize this repo" --output-format json | jq -r '.content'
```

## 2. 事件信封

每个事件是一个 JSON 对象，两个公共字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | string | 契约版本，当前恒为 `"1"`。破坏性变更时递增并在 CHANGELOG 公告 |
| `type` | string | 事件类型，取值必在 §3 表内 |

## 3. 事件类型表

| `type` | 出现于 | 稳定性 | 语义 |
| --- | --- | --- | --- |
| `turn.result` | `json`（唯一一行）、`stream-json`（最后一行） | **stable** | 回合终态结果 |
| `assistant.delta` | 仅 `stream-json` | **experimental** | 助手正文增量片段 |

### 3.1 `turn.result`（stable）

```json
{"type":"turn.result","schemaVersion":"1","sessionId":"ses_…","turnId":"turn_…","status":"succeeded","mode":"assistant","model":"k3","content":"…","usage":{"input":11,"output":7,"estimated":false},"cost":0.000138,"toolResults":[],"warnings":[],"error":null}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` / `turnId` | string | 会话与回合 id（可用于 `kkcode session` 系列命令回访） |
| `status` | string | `"succeeded"` / `"blocked"`（预算阻断）/ longagent 终态 |
| `mode` / `model` | string | 实际执行航道与模型 |
| `content` | string | 助手最终正文 |
| `usage` | object | `{ input, output, estimated }` token 计数；`estimated` 为 true 表示估算值 |
| `cost` | number | 本回合计价（USD） |
| `toolResults` | array | 工具调用结果摘要 |
| `warnings` | array | 计价/预算警告（同文本也会出现在 stderr） |
| `error` | string \| null | 预留的失败详情字段 |

> **已知语义边界（experimental，1.x 可能收紧）**：provider 级失败（超时、
> 5xx）当前以 `content: "provider error: …"` 的普通文本收尾，`status` 仍是
> `"succeeded"`、`error` 为 null —— 这是 0.9.x 的既有行为，阶段 5 只固化
> 不改造。机器消费方今天要判断失败，应同时看进程退出码与 `content` 前缀；
> 待 `status`/`error` 的失败语义收紧后会按 §4 的变更政策公告。

### 3.2 `assistant.delta`（experimental）

```json
{"schemaVersion":"1","type":"assistant.delta","delta":"Hello"}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `delta` | string | 正文的增量片段 |

- 与 TUI 字节流同源：按到达顺序拼接 `delta` 即得 `turn.result.content`
  （末尾可能多一个渲染换行，不属于正文；`delta` 的分片边界无语义，消费方
  不得依赖分片方式）。
- experimental：payload 形状（如新增 `channel` 字段区分 thinking）可在次
  版本演进，消费方须容忍未知字段。

## 4. 稳定性承诺与变更政策

1. **stable 的部分**：流纪律（§1）、事件信封（§2）、`turn.result` 的既有
   字段名与语义。在 `schemaVersion: "1"` 内只做**兼容追加**（可能新增字段，
   消费方必须忽略未知字段）；不改名、不改义、不删字段。
2. **experimental 的部分**：`assistant.delta` 的 payload、§3.1 标注的失败
   语义边界。可在次版本收紧，变更会进 CHANGELOG。
3. **破坏性变更**（无论 stable/experimental）：递增 `schemaVersion` 并在
   CHANGELOG 与迁移说明中公告 —— 对照 Codex 单版本列车 + 兼容流水线
   （M1 §3.4/§4.5）与 Kimi「规范即契约」（M2 四.2）。
4. 事件类型的新增是兼容变更；消费方必须把未知 `type` 的行当作可忽略的
   通知（forward compatibility）。

## 5. 与内核事件面的关系

stdout JSONL 是**进程间**机器契约；内核还有一套**进程内**事件总线
（`src/kernel/core/constants.mjs` 的 `EVENT_TYPES`，`kernel.events` 通道）。
两者今天服务的消费者不同：前者给 spawn CLI 的脚本/未来的 TS SDK，后者给
进程内宿主。内核 `EVENT_TYPES` 的稳定子集沉淀为 `src/sdk/events.mjs` 契约
面是 1.x 评估项（架构 §2、§8）；本页契约不依赖它先行落地。
