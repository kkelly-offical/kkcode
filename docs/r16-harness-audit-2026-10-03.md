# R16 失败归因与 Kimi Code / Codex 源码对照

审计日期：2026-10-03。结论：**不能把 R16 三个问题案例统称为 Qwen3.8-27B 能力不足。艺术存在 KK 执行框架缺陷，算法存在评测器缺陷，全栈同时存在流程中断与生成代码问题。**

本报告区分 KK 的工具/会话执行框架、外部评测器、模型生成的交付物。未修改产品代码或已发布 1.0.6，以下修复建议尚未接入正式版本。

## 范围与证据

- 审计对象：已关闭的 `/root/kkcode-106-stable-harness-20261002`，正式包 SHA-256 `c74461783036fdd608788237014d03beb925a068e1c02d557f19e56f7d3237bd`。
- R16 于 2026-10-03 02:41:29（UTC+8）关闭；437 请求、23,619,076 计账 tokens、无新增模型用量 unknown。最后全栈产生一笔待核查的工具效果；权限已撤销，清理回执正常，原记录不改写。
- 私有审计目录：`/root/kkcode-r16-harness-audit-20261003`。包含脱敏会话、工具时间线、原文件哈希、纯函数回放、两组独立诊断及原始协议回包。没有新增模型调用，没有调整 vLLM，没有运行竞品安装脚本。
- KK 源码以稳定版 `609cc9a4b5f00808c2332f83bb23c67971e9c17e` 为准；审计时 main 中所涉执行框架文件与该版无差异。
- Kimi Code：官方 **TypeScript** 仓库，提交 [`21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3`](https://github.com/MoonshotAI/kimi-code/tree/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3)。没有把旧 Python kimi-cli 当作当前实现。
- Codex：官方仓库，提交 [`86a54b051c08f34f373c507ae16a91915ab08700`](https://github.com/openai/codex/tree/86a54b051c08f34f373c507ae16a91915ab08700)。两者均于审计时核对远端提交；比较的是这些固定版本的流程，不是同模型实跑成绩。

## 案例结论

| 案例 | R16 原结果 | 本次核查后的归因 |
| --- | --- | --- |
| baseline | 原生完成，独立自动检查通过 | 没有此次需解释的失败；代码质量仍待人工审阅 |
| research | 原生完成，独立自动检查通过 | 没有此次需解释的失败；引用支持程度仍待人工审阅 |
| art | 原生 `permission-denied`；独立构建、单测及 5 组浏览器检查通过 | KK 错误恢复/收尾存在确定缺陷，模型也使用了不可靠的检查命令形式；不是作品未做出的证据 |
| algorithms | 原生完成；评测器根目录 build 失败 | 目录契约不清与评测器响应解包缺陷。保持生成代码不变的诊断最终通过全部已有自动检查 |
| fullstack | 原生 `inspection-required`；后端基础检查通过、前端检查失败 | 120 秒后台服务超时触发全局核查屏障；代码存在真实幂等缺陷、前端未实现，但模型是在调试途中被中断 |

### 1. 艺术：正常纠错被历史记录和命令识别挡住

会话 `ses_eecac540-10c`，下列编号为宿主工具完成记录的零基索引。

1. **索引 6 的只读探测被误报为写受保护目录。** 命令包含 `ls .kkcode 2>/dev/null` 和 `echo "HOME=$HOME"`。词法器因为变量展开把整条命令标为 uncertain，`bashTouchesProtected` 随即按整条文本是否提到 `.kkcode` 返回写保护命中。纯函数对照中，单独的 `ls .kkcode 2>/dev/null` 不命中，加上上述 echo 即命中。不能以修复此误报为由放开 `.kkcode` 写权限。
2. **索引 83 的 edit 没有写入，却成为永久失败项。** 模型把 `app.css` 内的片段误定位到 `base.css`；工具返回 no match、`fileChanges: []`。随后模型 grep 找到真实位置，并在索引 85 成功修复 `app.css`。当前完成门禁按失败目标路径记账，仅修改另一个正确文件不能清除 `base.css` 的 `failed_mutation`。源码事务实现确认 no match 在写入前返回。纯函数对照“错文件零写入 → 正确文件修复 → npm test 成功”仍被阻断。
3. **有效测试与不可靠 shell 表达式被混在一起。** `playwright test 2>&1` 的单纯 stderr 合流不改变测试退出码，但分类器拒绝全部重定向；`npm run e2e` 不在脚本名称白名单。另一方面，模型后面用了 `| tail`、`; echo EXIT=$?`，这些表达式确实可能掩盖失败，拒绝把它们算作可信通过是合理的。需要修正识别粒度，而不是根据输出中的 PASS 放行。
4. **索引 118 的查看文件/git status 组合被当成可能修改，令先前检查过期。** 保守分类有其边界，但错误信息和恢复路径必须让模型能够完成实际复核。
5. **最终停机标签误导且阻断恢复。** `loop.mjs` 在任意收尾验证失败后，只要整轮 `toolEvents` 曾出现 `PERMISSION_DENIED` 就退出，优先于两轮修复提示。这里引用的是很早以前的索引 6，并非最后一个必要操作被拒绝。模型的“全部完成”正文还会被原样保留，与宿主 blocked 状态不一致。

完整工具记录经稳定版 `evaluateCompletionEvidence` 回放，精确复现原来的三个 `unverified_check`、索引 83 的 `failed_mutation` 以及 `checks_required afterIndex 118`。艺术发生过一次压缩，但失败证据仍在宿主记录中；本案没有证据表明附件压缩或工具配对丢失导致失败。

独立验收已通过构建、33 项单测与 5 组浏览器检查；模型记录也有 32 项 E2E 通过。视觉品质尚未人工验收，因此结论是“收尾存在误阻断”，不是“完整产品验收已经完成”。

源码：[受保护路径判断](../src/kernel/permission/protected-paths.mjs)、[检查与失败记账](../src/kernel/session/completion-evidence.mjs)、[会话收尾](../src/kernel/session/loop.mjs)、[零匹配在写入前返回](../src/kernel/tool/edit-transaction.mjs)。私有回放：`completion-controls.json`、`art/timeline.json`。

### 2. 算法：两层评测问题，不能从原 build 失败推断算法不会做

模型交付在 `/workspace/kk1615/orchestrator/`，README 明确给出 `cd orchestrator`、构建和 `node dist/cli.js`。评测准备却在所有此类任务根目录留下 React/Vite 模板；评测器固定在根目录运行 `npm run build` 并寻找 `dist/cli.js`。于是执行的是未配置 tsconfig 的模板构建，输出 TypeScript 帮助后退出 1，算法 oracle 根本没有运行。

公开要求约定了 CLI 相对路径，但没有明确禁止子工程或声明所有命令必须从 workspace 根执行。模型也没有提供根入口。应将其归为交付入口契约不清、评测器未支持声明入口；不能只归责模型或暗自搜索任意目录后算通过。

本次按顺序执行两组**非模型诊断**，均使用独立 VM 目录、全新普通执行 UID、cgroup 资源上限、隔离网络和原独立 grader；没有执行旧会话或改写原成绩：

| 诊断 | 相对原评测的变化 | 结果 |
| --- | --- | --- |
| A | 只将 build/test 前缀和 CLI cwd 改为已声明的 `orchestrator` | build 与 64 项自测通过；5 组 DAG 协议通过；日志截断检查失败 |
| B | 在 A 基础上，让评测器解包时保留原响应的 `recovery` 字段；测试断言不变 | build、64 项自测、全部 6 组独立协议检查通过 |

第二层错误位于 `graders/candidate-broker-client.mjs`：展开 `r.value.data` 时只保留 `ok`，丢弃同级恢复信息。实际进程响应如下：

```json
{"ok":true,"data":{"tasks":[{"id":"persist","deps":[],"status":"completed","attempt":1}],"eventSeq":3},"recovery":{"mode":"restore","truncatedTail":true,"incomplete":false,"eventsRestored":3}}
```

原评测客户端把 `recovery` 去掉后，grader 才报 “Truncated tail silently accepted as complete”。这是评测器产生的假阴性。对照没有让模型改代码，也没有删改 oracle 断言。

两次诊断的全部 **26 个源文件逐字节与冻结交付物一致**，源清单哈希均为 `f0d071e46ce743feaac4975e3cf1712daecf20ab3d9aca6b5800896e00fd855b`，均 `cleanupKnown: true`。重打包 tar 的时间元数据可不同，判断代码不变使用逐文件哈希。证据：`source-integrity-comparison.json`、`algorithm-diagnostic-result.json`、`algorithm-envelope-result.json`、`algorithm-envelope-grader.log`。

这些通过只覆盖已有 oracle。持久化故障语义、持续流量 aging、复杂度和代码质量仍需审阅。例如生成 CLI 对 journal append 失败只写 stderr 后仍可能返回成功，值得另设故障注入案例；本次没有运行该故障场景，不能把自动检查通过等同于生产级保证。

### 3. 全栈：后台服务生命周期不足，交付代码也有真实缺陷

会话 `ses_d2cf4b43-aec` 的索引 60 启动：

```text
command: PORT=8080 ./scripts/start-backend.sh
cwd: /workspace/kk1611
run_in_background: true
```

模型没有设置 timeout，继承 120000ms。服务 18:36:37 UTC 启动，18:38:36 收到退出信号；任务记录为 `process_timeout`、`SIGTERM`、`captureIncomplete: false`、`terminationIncomplete: false`，同时 `outcomeUnknown: true`。KK 的 `runBash` 将已启动进程的 timeout/signal 均映射为效果未知，会话下一步触发 `inspection-required`，后台串行评测也按已定规则停止。

这不是随机丢失进程状态，也不是模型用量耗尽。工具已经明确提示后台任务仍有有限超时，模型未按建议把临时服务的启动、断言、清理放进一个受控测试，是工具使用问题；同时，开发场景缺少可供模型使用的会话级受管服务能力，使普通本地调试过早进入所有者核查屏障。

**不能直接清除这笔 unknown 或自动重跑。** 进程退出被确认不代表先前数据库写入可忽略。应增加具有独立等待窗口、有限服务租期、权限/端口范围、任务预算、显式停止和清理证据的工具生命周期，而不是取消未知效果核查。

生成代码的缺陷另有直接证据：`internal/store/store.go` 的事务插入幂等键时将 `booking_id` 设为空串，创建 booking 后提交前没有回填该字段。重复同键请求因而无法返回已有预约，会重试后冲突；冻结工具输出同时显示空的幂等引用和自写集成测试失败。这是具体代码问题，不能甩给评测器。冻结 `web/` 只有 package/lock 文件，没有前端实现，因此 Web build/test 失败也真实反映了未完成。

独立后端 `go build/vet/test -race` 通过，并不覆盖所有带 `integration` build tag 的测试。模型自写集成测试中幂等、并发同键等失败尚在调试，因 Harness 屏障中断；该轨迹无法回答“若继续，模型是否会修好”。

证据：`fullstack/background-task.json`、`fullstack/timeline.json`、冻结源码；产品位置：[Bash 超时和结果分类](../src/kernel/tool/registry.mjs)、[下一步核查屏障](../src/kernel/session/loop.mjs)。

## 相同问题在 Kimi Code / Codex 中的预期流程

以下是源码推导，不是把竞品的“结束一轮”当作交付验收，也没有证明换框架后同一模型必然通过。

| 问题 | Kimi Code 固定版本 | Codex 固定版本 | 对 KK 的启示 |
| --- | --- | --- | --- |
| 编辑片段未命中 | `Edit` 返回 `isError: true`，模型可读错误、重新定位和编辑 | apply_patch 解析/验证失败以 `RespondToModel` 返回，可重新读文件再修复 | 已证明未写入的失败要可恢复，不应强迫再次修改错误路径 |
| 某次调用被拒绝 | 常规拒绝是该调用的 error；只有显式 `stopTurn` 才触发对应停轮逻辑 | 调用拒绝/沙箱拒绝返回该调用的错误或退出结果；后续仍受原权限约束 | 不以“历史出现过一次拒绝”冒充当前阻断原因；不重试被禁止的动作 |
| 临时服务器超过前台等待 | 默认可在前台等待到时转后台；显式后台默认 600 秒，可配置更长，支持 `disable_timeout`；受工具可用性/配置约束 | 默认启用 UnifiedExec，等待窗口结束时返回活进程 ID；通过 `write_stdin` 轮询/交互；若策略禁用该能力则采用 one-shot，硬超时仍会终止 | 等待结束不应自动等同于服务租期结束；保留权限、预算和清理边界 |
| 项目位于子目录 | Bash 的 `cwd` 解析到指定目录 | exec_command 的 `workdir` 解析到指定目录 | 两边都能执行子项目，但不会替我们的外部 grader 自动修复根目录假设 |
| 模型给出最终答复 | 基本 turn machine 在无工具调用且非空时进入 done；功能可通过显式机制拦截 | 无后续需求时走 Stop hooks；配置的 hook 可要求继续或阻止 | “一轮完成”“工具效果核实”“需求验收”应分别表达，不能比较终态标签就断言优劣 |

Kimi Code 源码：

- [Edit 错误返回](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/tools/edit/editTool.ts#L89)、[拒绝调用的返回结构](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/toolExecutor/beforeToolExecuteEvent.ts#L19)、[显式 stopTurn](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/loop/loopService.ts#L1729)。
- [后台时限参数](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/tools/os/bash/bash.ts#L6)、[运行/转后台/cwd 流程](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts#L175)、[turn machine](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/human/agent/turn.ts#L573)。

Codex 源码：

- [apply_patch 错误反馈](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/core/src/tools/handlers/apply_patch.rs#L386)、[命令拒绝返回](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L443)。
- [UnifiedExec 默认启用](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/features/src/lib.rs#L1013)、[交互与 one-shot 分支](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/core/src/tools/spec_plan.rs#L1091)、[等待窗口/终止/活进程回执](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/core/src/unified_exec/process_manager.rs#L631)、[收尾 hooks](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/core/src/session/turn.rs#L653)。

三者都不能从 shell 管道的最后一个退出码自动证明前面的测试成功。Kimi/Codex 的宽容纠错也不等于自动做了我们的独立需求验收，不能靠删除验收来提高成绩。

## 建议的修复顺序

1. **先修评测器。** 明确并公开 projectRoot/CLI 入口，按案例提供合适模板；保留协议 envelope 元数据，加入“恢复信息在顶层/data 内”的正反例。保留此次原始失败和独立诊断，不覆盖旧成绩。
2. **修 KK 可恢复错误的记账。** 把宿主证明未启动/零写入、已知失败、部分写入/效果未知分开；关联当前阻断与当前权限，避免历史拒绝吞掉修复机会。修正收尾状态与正文冲突。
3. **修检查证据识别。** 精确处理不改退出码的 fd 合流、明确项目脚本和只读操作；继续拒绝被管道/echo 掩盖的退出码。优先让执行器生成结构化检查回执，减少模型反复迎合字符串白名单。
4. **补受管临时服务。** 分开等待时长与服务租期，提供状态、日志、停止和清理凭据；尊重会话权限与总预算，不解除旧 unknown、不自动重放数据库操作。
5. 修复后新开冻结小批次，以同一模型、同一任务/预算做串行对照，再讨论模型上限。已有 baseline/research/算法及艺术证据表明，当前结果不足以得出“27B 做不了这些任务”；全栈持久化和长流程仍是有待真实验证的能力边界。
