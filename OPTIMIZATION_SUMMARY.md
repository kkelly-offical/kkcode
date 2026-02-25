# LongAgent 模块优化总结

## 概览

对 kkcode 的 LongAgent 模块（~3500+ 行）进行了 12 项优化，涵盖正确性修复、可靠性增强、可维护性重构和代码质量改进。

## 修改文件清单

| 文件 | 改动类型 |
|------|---------|
| `src/session/longagent-utils.mjs` | 新增工具函数 + 常量 |
| `src/session/longagent.mjs` | Bug 修复 + 重构 |
| `src/session/longagent-hybrid.mjs` | Bug 修复 + 重构 |
| `src/session/longagent-4stage.mjs` | Bug 修复 + 重构 |
| `src/session/longagent-git-lifecycle.mjs` | **新建** — 共享 Git 生命周期 |
| `src/session/longagent-task-bus.mjs` | 正则修复 |
| `src/session/task-validator.mjs` | 依赖修复 |
| `src/session/usability-gates.mjs` | 无改动（已有导出被消费） |
| `src/orchestration/stage-scheduler.mjs` | 语义错误追踪集成 |

---

## Batch A: 正确性修复

### A1. Gate 缓存失效 bug
- **问题**: usability-gates 的 5 分钟 TTL 缓存在 remediation agent 修改代码后不失效，导致门禁返回旧结果
- **修复**: 在 `longagent.mjs` 和 `longagent-hybrid.mjs` 的 remediation 循环中，重新运行 gate 前调用 `clearGateCache()`
- **影响**: 修复了门禁检查可能误判通过的正确性 bug

### A2. task-validator glob 依赖缺失
- **问题**: `task-validator.mjs` 动态 import npm `glob` 包，但该包不在 dependencies 中，`findFilesByExtension` 永远返回空数组
- **修复**: 改用 Node.js 22 内置 `fs.glob`，加 `find` 命令 fallback
- **影响**: 验证器的语法检查从形同虚设恢复为正常工作

## Batch B: UX 与可靠性

### B1. 可中断退避等待
- **问题**: 指数退避 sleep（最长 30s）完全阻塞，不响应 stop 请求
- **修复**: 新增 `interruptibleSleep(ms, { signal, sessionId, getStopRequested })` 工具函数，将长 sleep 拆为 500ms 小段
- **影响**: 用户发出 stop 后最多 500ms 内响应，而非等待整个退避周期

### B2. Parallel 模式 checkpoint 恢复
- **问题**: `longagent.mjs` import 了 `loadCheckpoint` 但从未使用，parallel 模式无法从崩溃恢复
- **修复**: 在 `runParallelLongAgent` 入口添加 checkpoint 恢复逻辑，恢复后跳过 intake/planning/scaffold 阶段
- **影响**: parallel 模式崩溃后可从上次 checkpoint 恢复，避免从头重跑

## Batch C: 可维护性重构

### C1. Git 操作代码去重
- **问题**: Git 分支创建逻辑在 3 种模式中各写了一份（stash → create branch → unstash）
- **修复**: 新建 `longagent-git-lifecycle.mjs`，导出 `setupGitBranch()`，三种模式改为调用共享函数
- **影响**: 消除约 60 行重复代码，统一了 detached HEAD 检测和 stash 失败处理

### C2. Usage 累加去重
- **问题**: `aggregateUsage.input += X.usage.input || 0` 四行模式在各文件中重复约 10 次
- **修复**: 新增 `accumulateUsage(aggregate, turn)` 工具函数，替换所有内联累加
- **影响**: 消除约 30 行重复代码，统一了 usage 累加逻辑

### C3. 统一返回值结构
- **问题**: 3 种模式返回不同字段结构（parallel 22 字段、4-stage 仅 9 字段），engine.mjs 读取缺失字段变 undefined
- **修复**: 新增 `buildLongAgentResult(fields)` 提供完整默认值，三种模式的 return 改为调用此函数
- **影响**: engine.mjs 和 repl.mjs 不再读到 undefined 字段

## Batch D: 可靠性增强

### D1. 语义错误追踪器集成到 stage-scheduler
- **问题**: `createSemanticErrorTracker` 仅在 hybrid 模式使用，parallel 模式的 stage-scheduler 中重复相同错误的 task 会无限重试
- **修复**: 为每个 logical task 创建 semanticTracker，task 失败时检测重复错误模式，升级为 PERMANENT 阻止无效重试
- **影响**: 避免 parallel 模式中相同错误反复重试浪费 token

### D2. TaskBus 广播正则增强
- **问题**: `longagent-task-bus.mjs` 的 `\w+` 不匹配带点号/横线的 key（如 `api.base_url`）
- **修复**: 正则从 `(\w+)` 改为 `([\w.\-/]+)`
- **影响**: TaskBus 可正确解析含 dots/dashes/slashes 的广播 key

### D3. 4-stage Git 合并错误处理
- **问题**: `longagent-4stage.mjs` 的 git merge 用空 catch 吞掉所有错误，合并失败时用户无感知
- **修复**: 添加 merge 结果检查、失败时 emit alert 事件、回滚到 feature branch
- **影响**: 4-stage 模式的 Git 合并失败不再静默丢失

## Batch E: 小改进

### E1. 意图检测增强
- **问题**: `isLikelyActionableObjective` 对超过 8 字符的任意文本都返回 true，"今天天气怎么样" 会触发 LongAgent
- **修复**: 扩展非编码关键词列表，添加 "what is"、"explain"、"什么是"、"解释" 等问答类前缀
- **影响**: 减少非编码意图误触发 LongAgent 的概率

### E2. Magic number 常量化
- **问题**: 散落在各文件中的硬编码数字（noProgressLimit=5, maxGateAttempts=5, gateTimeoutMs=15min 等）
- **修复**: 在 `longagent-utils.mjs` 新增 `LONGAGENT_DEFAULTS` 常量对象（22 个命名常量），各消费文件引用常量
- **影响**: 集中管理配置默认值，便于调优和审计

---

## 验证结果

所有修改文件通过 `node --check` 语法检查：

```
OK: src/session/longagent-utils.mjs
OK: src/session/longagent.mjs
OK: src/session/longagent-hybrid.mjs
OK: src/session/longagent-4stage.mjs
OK: src/session/longagent-git-lifecycle.mjs
OK: src/session/longagent-task-bus.mjs
OK: src/session/task-validator.mjs
OK: src/orchestration/stage-scheduler.mjs
```

