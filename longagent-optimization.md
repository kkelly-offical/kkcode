# LongAgent 模式优化方案

## 1. 进度检测脆弱性

**问题**：依赖文本标记 `[PROGRESS: X%]`，Agent 可能遗漏，导致误判"无进展"触发恢复。

**方案**：
- 改为基于工具调用行为检测进度（文件写入、命令执行次数）
- 引入结构化进度上报接口，而非纯文本解析
- 对比前后文件系统变化作为进度的客观依据

```js
// 当前：文本比对
const hasProgress = normalizedCurrent !== normalizedPrevious;

// 优化：结合工具调用计数
const hasProgress = toolCallCount > 0 || fileChangeCount > 0;
```

---

## 2. 文件锁竞争条件

**问题**：5 秒超时后强制删除锁，无 PID 校验，可能误删其他进程的锁。

**方案**：
- 锁文件写入持有进程的 PID
- 释放前校验 PID 是否仍存活，死进程才强制释放
- 超时时间改为可配置项

```js
// 锁文件内容
{ pid: process.pid, timestamp: Date.now() }

// 释放前校验
const isAlive = isProcessAlive(lock.pid);
if (!isAlive || isStale) forceRelease();
```

---

## 3. 恢复循环无退避

**问题**：失败后立即重试，确定性错误会快速耗尽重试次数，无指数退避。

**方案**：
- 引入指数退避（1s → 2s → 4s）
- 记录失败原因，相同错误不重试，直接上报用户
- 区分"可重试错误"与"致命错误"

```js
const delay = Math.min(1000 * 2 ** recoveryCount, 30000);
await sleep(delay);
```

---

## 4. 并行模式文件所有权无技术保障

**问题**：并行 Agent 的文件隔离依赖 Prompt 约束，无实际拦截机制。

**方案**：
- 在 `stage-scheduler` 中对 Agent 的文件写入操作做白名单校验
- 写入非授权文件时拦截并记录警告，而非静默允许
- 可选：将文件所有权写入 state，供后续审计

---

## 5. Git 自动合并静默失败

**问题**：`auto_merge` 失败时用户停留在 feature 分支，无明确错误提示。

**方案**：
- 合并失败时立即暂停会话，输出冲突文件列表
- 提供 `kiro-cli longagent merge-status` 命令查看冲突详情
- 不自动回滚，保留现场供用户手动解决

---

## 6. Scaffolding 额外延迟

**问题**：L1.5 阶段需要额外一轮 LLM 调用创建 stub，增加整体延迟。

**方案**：
- 将 scaffolding 与 plan 生成合并为单次调用（在 L1 阶段同时输出 stub 契约）
- 对简单任务（单文件修改）跳过 scaffolding

---

## 7. Token 用量无硬限制

**问题**：仅告警，不阻断，长任务可能产生意外高额费用。

**方案**：
- 增加 `max_tokens_per_session` 配置项
- 超限时暂停会话并提示用户确认是否继续
- 在 `status` 命令中显示当前 token 消耗与预算百分比

---

## 8. Checkpoint 恢复丢失上下文

**问题**：Checkpoint 只保存状态，不保存工具输出，恢复后 Agent 缺少执行上下文。

**方案**：
- Checkpoint 中额外保存最近 N 条工具调用摘要（非完整输出）
- 恢复时将摘要注入系统 Prompt，帮助 Agent 快速重建上下文

---

## 优先级排序

| 优先级 | 问题 | 影响 |
|--------|------|------|
| P0 | 恢复循环无退避 | 快速耗尽重试，任务失败 |
| P0 | Git 合并静默失败 | 用户数据风险 |
| P1 | 进度检测脆弱 | 误触发恢复，浪费 token |
| P1 | 文件锁竞争 | 并发场景数据损坏 |
| P2 | 文件所有权无保障 | 并行模式正确性 |
| P2 | Token 无硬限制 | 费用风险 |
| P3 | Scaffolding 延迟 | 性能优化 |
| P3 | Checkpoint 上下文 | 恢复质量 |
