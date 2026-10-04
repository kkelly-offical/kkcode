# 1.0.9 通用 Agent 与会话体验修复

状态：**已完成并正式发布1.0.9 / Android10016**。发行提交`b0ef227`（PR#44）与最终候选`f9983b6`同树，npm latest与原证书APK均已核验；[版本入口](versions.md)及[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.9/release-verification.json)。

## 开发与验收清单

每项同时记录实现、可复现检查和剩余问题；不以代码已写或ToDo打勾代替验收。

| 编号 | 优化点与目标行为 | 验收要点 | 状态 |
| --- | --- | --- | --- |
| H01 | 普通Agent不再强制测试验收或自动注入“验收失败继续修复”；只有显式配置或宿主严格合同启用硬门禁 | 查询、运维、文档工作可正常结束；真实失败仍如实记录；未知效果、审批、预算及严格验收不降级 | 已完成并核验 |
| H02 | 回答结束与任务验收独立；历史未验收项不自动扩展新问题的任务范围 | 历史失败保留；询问状态不诱发写文件或测试；严格合同仍能读取未验收证据 | 已完成并核验 |
| C01 | 上下文显示采用一致的计数口径；普通会话避免在估算与实际输入usage间反复跳动 | 同一响应的两个事件一致，保留来源／时间／输出预留；压缩和硬预算继续使用完整的新请求预算 | 已完成并核验 |
| U01 | Web／Android自由滚动；停在底部时跟随最新输出，向上阅读时不抢滚动 | 长单条回复滚到真正底部；展开工具、加载图片和Markdown后仍正确；提供回到最新 | 已完成并核验 |
| U02 | 每次进入会话自动定位最新消息 | 重开长会话、切换会话、加载早期页均不误跳开头或干扰阅读 | 已完成并核验 |
| C02 | 手动Compact有提交／执行／停止状态，可取消，接受后清除原指令并防重复提交 | 取消传到真实压缩操作；失败保留历史、允许恢复输入；成功立即更新标尺并显示100k→11k等简短提示 | 已完成并核验 |
| U03 | Compact之后，之前的消息在显示上折叠 | 可展开查看此前可见历史；保留原始指令／证据／工具配对，不用UI折叠删除内容 | 已完成并核验 |
| U04 | 优化Markdown渲染，Android支持表格 | 对齐、代码／链接、长单元格和宽表横向查看；保留安全链接、文本选择和流式更新 | 已完成并核验 |
| M01 | 每次打开模型选择器自动刷新目录，本机目录缓存支持显式刷新 | UI打开时发起刷新；旧列表可用；刷新失败可见、可重试；切换渠道和晚到响应不串台 | 已完成并核验 |
| N01 | Android网络／错误提示随实际状态更新，恢复后收起，旧错误不跨会话悬挂 | 断开→重连→恢复；重复错误合并；会话切换／成功重试清除过时提示；保留真实失败记录 | 已完成并核验 |
| R01 | 发布1.0.9正式版并升级本机已授权remote运行时 | 完整回归、跨平台／Web／CodeQL、Android原证书与递增版本码、公开下载／升级验证；tmux仍在/root且all-folders | 已发布并核验 |

## 已确认的现象

- 本机日常显卡查询被归为缺少代码检查，Harness两次追加强制验收提示；后续状态问题继承该阻断并诱发无关测试文件写入。原会话已由用户取消、删除，私密恢复副本保留，不重写其原始失败。
- 上下文事件存在实际数字差异：`turn.usage.update`只发输入数且缺少来源／输出预留，紧接的`session.context.updated`加上输出数，下一步又切回更大的估算。新版本将分离请求预算与用户显示口径。
- 原始会话、工具回执和相关事件快照仅保存在本机私密审计目录，公开回归使用脱敏合成场景。不使用真实模型调用补验，不重启旧冻结评测。

## 当前工作边界

用户已授权本机/root下tmux remote通过coding企业网关运行，文件范围为all-folders。修复需要重启宿主时保留会话与既有副作用；不自动续跑用户已取消的模型任务。不重启或调整vLLM，不放宽审批、目录凭据保护或严格任务合同。

## 当前验证结果

- 通用Agent受控回归：系统信息查询、文档写入、按要求报告失败检查均正常结束，不自动追加测试任务；失败证据保留且严格调用方仍能恢复。上下文的两个事件携带相同输入数、来源、预算与时间。
- 手动Compact与命令契约15项通过：请求去重、并发排斥、准备阶段／provider等待阶段取消、晚到摘要不替换历史、即时上下文与重开恢复。无真实模型调用。
- Web真实设备服务＋Playwright检查通过：打开即最新、长文本底部跟随、向上滚动不抢位置、回到底部、模型目录每次打开重新请求、Compact取消／草稿恢复／即时数字／历史折叠和重开。完整既有Web检查也通过。
- Android编译与85项JVM检查通过；新增7项模拟器检查通过，包括实际取消RPC、编辑中新草稿保护、折叠／100k→11k、长单条消息滚动、Markdown单元格格式／对齐／安全链接／截图、目录刷新与晚到响应、连接恢复自动收起。完整80项UI／设备检查通过；包含连续两次压缩的可见历史保留回归。
- 模拟器初检发现滚动触发布局重入，已改成下一帧请求定位并通过专项。Markwon粗体回归按实际字形效果判断，兼容其自带span，保留选择与安全链接校验。
- 首轮全量回归4243项（4080通过、7失败、156跳过），失败来自下述已修复的旧策略／新增字段断言；第二轮4245项中4087通过、2项旧文档断言失败、156跳过；文档版本与契约已修正，7项文档检查通过，随后最终候选／主线／发行全套CI通过。旧后台验收测试已改成显式启用严格验收（原断言不降级，针对性复跑通过）；渲染历史金样只投影原有context字段，新增加的完整计数元数据另有端到端检查，原输出字节不改写。源码1.0.9文档版本与本地镜像标签契约也已同步，公开1.0.8事实保持。

压缩折叠仅作用于当前客户端可见／服务端仍可读取的记录；重载不会凭摘要伪造已不在当前展示页的旧正文。历史证据与私有归档继续遵循原保留及权限机制。

正式APK已构建：1.0.9 / Android10016，原证书v2/v3、非debug通过，隔离只读模拟器中10015→10016覆盖升级及启动通过。最终候选、主线、发行流水线以及匿名下载与安装验证全部通过。

## 正式发行回执

- 候选verify [37150500437](https://github.com/kkelly-offical/kkcode/actions/runs/37150500437)、CodeQL [37150500426](https://github.com/kkelly-offical/kkcode/actions/runs/37150500426)通过；主线verify [37150631587](https://github.com/kkelly-offical/kkcode/actions/runs/37150631587)、CodeQL [37150631713](https://github.com/kkelly-offical/kkcode/actions/runs/37150631713)通过；正式发行 [37150700765](https://github.com/kkelly-offical/kkcode/actions/runs/37150700765)通过。
- 最终候选Linux22：4245项，4081通过、0失败、164条件跳过；另外E2E33项、兼容45项、Android85项JVM／80项界面与设备检查通过。网页检查包含真实设备服务、取消、滚动、模型刷新和Compact全链路，未使用真实模型推理。
- npm latest=1.0.9，preview=1.0.6-preview.1；匿名npm／GitHub／CI tarball字节相同。原证书APK、android-update.json、SBOM、公开回执和SHA256SUMS均可匿名下载。Node22.12安装、792文件秘密扫描、SDK与SQLite往返通过。
- 本机空闲时正常停止旧remote，私密状态备份后从公开校验包升级到1.0.9；`tmux kkcode-coding`仍在`/root`、all-folders，原设备／所有者身份与配置字节保留，已恢复连接。没有自动恢复已取消的任务。
- 完整回执目录：`/tmp/kkcode-109-stable-qv6gzea1/`；本机升级备份入口：`/root/.local/state/kkcode-coding/backup-109-path`。旧R12—R16结果与授权边界未改写。

## 下一轮优化现状审计（2026-10-04）

用户要求将模型参数自动配置、子代理配置／上下文管理和缩减强制编排纳入下一轮，并汇报当前约束。已登记[下一轮开发清单](optimization-next.md)；以下是对发行后源码的静态审计，不表示这些新优化已实现，不修改 1.0.9 发行事实。没有执行真实推理、修改运行配置或重启服务。

已按用户进一步明确的方向收敛 A01/A03/U01：接口有效值优先，字段缺失时分析已有返回数据，再由适用规格和默认兜底；用户主要调节思考强度。有分级时按实际能力映射数字等级，预备略思／审思／深思／精思／穷理五档，对应 low/medium/high/xhigh/max，随接口返回调整可见档位及表述，只有二态时只显示开关。详细交互约定见清单。当前 [thinking-effort.mjs](../src/kernel/provider/thinking-effort.mjs) 与 [CLI 选择器](../src/repl/overlay-controller.mjs) 仍使用固定 off/low/medium/high/max；off 路径省略思考参数，不能仅凭省略就断言所有服务均关闭思考。下一轮需核对能力、界面与真实请求的对应关系，尚未修改运行实现。

五档预设包含 xhigh，实际显示仍按各模型接口能力映射，不固定思考阈值。规格已明确：原生枚举直接映射，不把 xhigh 和 max 混用；只有预算参数时按有效范围与本次输出额度动态换算；二态采用开关；不凑档数、不冒充官方分级。保留原生配置及来源，支持界面与实际参数的双向还原，未确定能力时使用默认。本轮只维护规格，文档链接与差异检查通过。

### 模型参数与上下文

- [context-budget.mjs](../src/kernel/session/context-budget.mjs) 的默认请求输出为 `min(16384, floor(context/4))`（小窗口保留正值），发现的 `max_output_tokens` 只参与取最小值。已知输出上限较大也无法自动提高默认 16K，须在 A02 统一修复。
- [model-catalog.mjs](../src/kernel/provider/model-catalog.mjs) 已解析部分窗口、输出能力、支持参数和价格；`applyDiscoveredCapabilities` 只选择 provider 的 `default_model`，且只在字段未设置时回填。这些自动值与显式配置缺乏独立来源，需检查切模型、刷新及对子代理路由的传播，不能宣称每个实际请求已完整同步。
- 输出解析当前没有读取 Anthropic 模型元数据的 `max_tokens` 或 Gemini 的 `outputTokenLimit`；能力解析主要接受布尔值，不能完整读取嵌套的 `{ supported: true }`。现有目录传输支持 OpenAI／Responses／Anthropic 路径，不因字段可解析而宣称已实现原生 Gemini 推理。另将 `max_input_tokens` 与总窗口归入同一 contextLength，输入／总窗口语义需分开。
- [thinking-effort.mjs](../src/kernel/provider/thinking-effort.mjs) 按声明输出上限或窗口的 1/8 推算思考预算；[router.mjs](../src/kernel/provider/router.mjs) 的这部分取值与实际请求 `maxTokens` 分开。例如目录输出上限较大、请求仍为 16K 时，存在思考额度不匹配的路径，需由 A03 同源解析后检查。
- 普通请求的 Compact 默认按完整输入加输出预留达到窗口 85%，或历史达到 200 条触发，另有原生压缩分支；[compaction.mjs](../src/kernel/session/compaction.mjs) 的消息数条件仍是独立触发。工具结果[预算](../src/kernel/tool/output-budget.mjs)默认按窗口 8% 估算字符量，再限制于 16,000—200,000 字符。
- Ultra 还有独立的阶段摘要预算：[longagent-hybrid.mjs](../src/kernel/session/longagent-hybrid.mjs) 在 `priorContext.length > 8000` 默认条件下调用压缩；[辅助函数](../src/kernel/session/longagent-hybrid-helpers.mjs)先截取 `limit*2` 字符，再要求约 `limit*0.6` 字符摘要，结果限制到 `limit`。预览、蓝图、调试交接另有固定切片。这不是模型 token 窗口，需要列入 S03，不能只修改主会话预留。

官方 API 资料核对：Anthropic [模型详情](https://platform.claude.com/docs/en/api/typescript/models/retrieve)提供 `max_input_tokens`、`max_tokens` 和嵌套能力；Gemini [Models API](https://ai.google.dev/api/models)提供输入／输出限额、支持方法与采样默认值等；OpenAI [模型详情](https://developers.openai.com/api/reference/cli/resources/models/methods/retrieve)主要返回身份和归属等基础元数据。因此自动配置可以尽量完整，但不能承诺每个兼容 `/models` 都会提供全部参数；未知、规格回退、用户覆盖与实际端点证据需要分别表达。

### 当前强制或默认编排

| 范围 | 现状与触发条件 | 下一轮方向 |
| --- | --- | --- |
| 普通 Agent 完成判断 | `verify_completion=false`；普通回答不会因缺少测试自动追加修复。显式启用或当前宿主严格任务仍要求验证，待处理子任务／未知操作另有生命周期约束 | 保持普通任务自然结束；不把运行结束或 ToDo 完成冒充检查通过 |
| 普通主／子代理步数 | [defaults.mjs](../src/config/defaults.mjs) `agent.max_steps=8`；[loop.mjs](../src/kernel/session/loop.mjs) 再与角色 maxTurns 取较小值，距上限两步注入收尾提示。实际部署可覆盖，8 是仓库默认而非已读取的本机会话值 | 评估主／子代理分开的合理默认或软提示；显式硬上限不能由模型自行提升 |
| 截断续写 | 普通循环中需有半成品，已知输出预算时核对 usage；单段最多 8 次、单回合累计最多 24 次，另受步数限制；空响应不自动续跑 | 先修输出／思考预算，再减少因人为截断导致的续写及重复控制提示 |
| 无进展检测 | [progress-guard.mjs](../src/kernel/session/progress-guard.mjs) 对相同调用及结果组成的序列检测，重复 3 次提醒、6 次停止，支持 1—3 步模式 | 保留防循环，区分有依据的等待／轮询；避免为了防循环反复加入长提示 |
| 子代理分派与继承 | [task-scheduler.mjs](../src/kernel/orchestration/task-scheduler.mjs)支持 fresh_agent／fork_context；后者仅只读。模型优先级为既有子会话合同→角色覆盖→models.subagent→当前会话；普通递归深度上限 8。结构化 brief 需要范围和交付物，直接 prompt 并非必须填写所有字段；续作保留原合同 | 精简模型可见参数，按任务提供必要上下文；权限、归属、停止、预算和续作副作用保留 |
| Ultra 阶段 | 默认路径包括澄清、探索、蓝图、可选 Git、脚手架、阶段执行、调试、完成检查及最终门禁。已有任务意图区分，文档／研究／运维会调整脚手架及 build/test 要求，并非所有任务都执行全部步骤 | 继续缩减固定路径，让模型决定何时需要计划／拆分／审阅，保留持久状态与恢复 |
| Ultra 审阅与检查 | 默认启用蓝图检查、阶段间增量门禁、存在文件改动时的交叉审阅、完成检查；最终 build/test/review/health/budget 门禁受配置与任务条件影响 | 复核重复检查、工程提示与机械返回循环；按具体变更和用户目标检查，不无条件测试所有工作 |
| Ultra 重试与资源 | 默认并发 3、阶段任务超时 10 分钟、任务重试 2、阶段恢复 3、累计阶段尝试 12、调试最多 20 轮、最终门禁最多 5 次、重规划最多 2 次；goal 模式默认 2 小时时限、连续 2 轮无强进展视为阻塞，轮数／总迭代数默认不设正上限 | 审核多层循环叠加及停止原因，减少固定流程；资源上限和显式授权继续由宿主约束 |

上述数字来自默认配置与实际读取点，不保证每条路径都会消耗完整次数；取消、预算、时限、父级策略或早期完成均可提前终止。Ultra 入口与步骤依据 [longagent-hybrid.mjs](../src/kernel/session/longagent-hybrid.mjs)、[goal-model.mjs](../src/kernel/session/goal-model.mjs) 和 [child-policy.mjs](../src/kernel/orchestration/child-policy.mjs)。

可以简化的是任务方法：固定工程蓝图、预先创建脚手架、多层审阅、重复门禁和催促提示。继续保留的是宿主事实与授权：账号／项目／会话隔离，工具和读写范围，显式审批，父子取消及执行状态，硬预算／截止，未知副作用核查，压缩归档与工具配对，以及用户或宿主明确要求的验收合同。模型能力更强不改变这些授权边界。
