# 1.0.10 模型参数与通用编排优化

状态：**1.0.10 / Android10017稳定正式版已发布并核验**。npm latest与GitHub Release已上线，Preview保持1.0.6-preview.1。用户授权范围为[优化清单](optimization-next.md) A01—U01，不扩大产品范围。

## 实现与检查清单

| 范围 | 实现 | 检查状态 |
| --- | --- | --- |
| A01/A02 | 自动能力保留在端点／协议／凭据分区的目录；普通回合首次／过期时有界读取元数据，直接SDK及严格任务不额外发现。输入限额、共享窗口和输出分别计算；未知输出按窗口1/5估算；85%触发作用于预留输出后的可用输入 | 目录→实际请求、刷新、冷缓存、跨端点、独立输入窗口、vLLM部署上限及非法数字检查通过 |
| A03/A04 | 原生思考枚举及拼写映射，五档包含xhigh；预算按有效范围及本次输出额度换算，合并实际相同的档位；二态按明确的开关参数发送。采样及支持能力分别解析；自动值不写成手动覆盖 | 模拟接口的实际请求、枚举缓存往返、关闭及不支持的档位、动态预算检查通过 |
| S01/S02 | 默认主代理128步、普通子代理64步，角色与显式父级限制保留；每个子代理按自身路由解析参数。支持context_summary/context_refs；过大的只读历史分叉在启动前建议精简交接，保留原历史 | 委派、续作、原范围与预算继承、小窗口交接29项检查通过 |
| S03 | 小量token的200条历史不再提前压缩；原阶段流程摘要阈值随输入预算变化，移除阶段交接正文固定切片；摘要前归档完整文本，失败／过长／截断则保留原文 | 原生上下文与工具结果重放、阶段摘要路由、归档及完整请求预算专项通过 |
| O01/O02 | 普通Ultra由模型按需安排阶段，持久ToDo／状态／取消继续有效；staged配置、显式required门禁、宿主严格任务及未完成旧阶段保留原流程。已确认的子代理等待不当作无进展重复 | 非代码自然结束、真实文件工具执行、步数限制及停止专项通过；旧staged断言保留 |
| U01 | CLI、Web、Android共用能力驱动的思考选项，按模型保存偏好；输出显示接口／手动／估算来源；向导不再追问上下文数字或要求用户猜测思考能力 | Web真实设备服务保存／重开、320px窄屏通过；最终Android源码85项JVM／81项界面检查通过 |

## 实施与约束

- 分支 `feat/1.0.10-model-runtime` 已经PR#46合入；发行提交`da25fd1`与最终候选`303d0f4`同树，以已发布1.0.9后主线为基线。已批准的严格预算不随目录更新扩大；新的预算档案只在宿主准备／确认时计算，不修改既有冻结档案。
- API能力缺失仍保留未知或明确标记兜底，不通过试发推理补齐字段。模型目录的声明不是实际推理／工具行为验收；未实现的原生协议能力不因一个标记自动启用。
- 普通Ultra的完成是会话执行结果，`completionPolicy=observational`；不冒充严格验收通过。ToDo／子代理汇报不变成验收凭证；未知效果、权限、所有者和取消传播仍受原执行层约束。
- 原分阶段流程可通过 `agent.longagent.orchestration: staged` 显式使用；既有未完成阶段任务按原流程续作。取消后不启动新回合，恢复仍由用户触发。
- 现有显式配置保留。新建渠道只保存用户确认的连接、模型等字段，自动发现的能力在缓存中刷新，避免旧自动值被误当作永久人工覆盖。

## 验证与交付

- 本轮逐项检查使用隔离模拟接口、受控provider和真实本地文件／设备服务；**未新增真实模型推理**，不恢复旧评测、不调整vLLM。
- 模型目录到实际请求覆盖131072输出、xhigh与max独立值、原生枚举拼写、目录刷新／磁盘冷缓存／路由隔离、独立输入限额、部署窗口缩小、无效数字、二态开关及预算边界。最新参数、命令生命周期与存储检查合计49项通过。
- Web完整套件通过；最后界面布局的真实DeviceService回归覆盖每次打开模型刷新、五档选择／保存／重开、320px窄屏，以及1.0.9滚动、Compact取消／草稿／标尺／折叠行为。生成资源与源码一致。
- 最终Android源码：JVM **85项通过**，UI／设备 **81项通过**；原证书1.0.9/10016→1.0.10/10017覆盖安装、firstInstallTime不变、启动和run-as拒绝均通过。APK为stable渠道、非debuggable，v2/v3签名验证通过；公开发布状态仍以versions.md为准。
- Node **22.12.0** 干净打包安装及SDK、持久ToDo／子代理接口、预算档案、SQLite／产物存储往返通过，无provider网络或推理。Node发行归档已与官方SHASUMS256.txt核对。
- 依赖审计0告警；类型、语法、架构边界、导入环与秘密扫描通过。跨平台完整检查和CodeQL随[PR#46](https://github.com/kkelly-offical/kkcode/pull/46/checks)逐提交记录；合入以最终提交的实际检查为准，不以历史通过代替。
- 本机交付回执目录：`/tmp/kkcode-110-candidate-u4w_66rm/`，保存最终npm包、签名APK、哈希、界面截图和检查日志；`candidate-verification.json`记录最终提交、完整检查、CI与产物的对应关系。不是公共发行回执。
- APK SHA-256：`44db7908cd01b44c8b3f4e7cbbe41a7dde4479737f7824e8085102d58b26638f`；原证书SHA-256：`cf75774a4d87ba1ccc4a811f271bd301076cf6beefd7432a3cb30231164be5d1`。
- 公开npm latest=1.0.10，preview=1.0.6-preview.1；v1.0.10为稳定正式发行。未推送公共网关镜像，未升级本机或其他生产remote／网关，本机仍为1.0.9。

## 检查中发现的问题

首次全量4248项中12项失败，后续4253项中1项、4255项中2项失败，主要为旧默认值／固定档位／向导自动写配置断言。按1.0.10行为更新后，原严格合同与staged验收断言保留。加入元数据GET后的HTTP夹具及严格请求顺序问题也已修复：严格预算执行只读缓存，SIGKILL后费用unknown不可重复消费的检查通过。

收尾中还修复了三处实际生命周期竞争，不修改安全限制或断言换取通过：

1. 操作日志快照在原子替换期间反复读到已解除链接的inode：仍保留8次上限，关闭句柄后有界退避，再重新检查权限与链接。
2. Windows命令矩阵的Compact尚未结束就删除测试目录：模拟服务清理前等待自己已接收的操作结束，再恢复存储并移除目录。
3. 产物目录锁刚释放时stat读到nlink=0：在原锁超时范围内重读路径，不使用旧inode；新增检查验证持续竞争会超时且不发布任何新产物。实际权限、符号链接及硬链接限制不变。

修复前本地完整4261项为4104通过、1失败、156跳过，失败为上述产物锁竞争；随后相关49项专项通过。最终完整结果见交付回执和PR检查。所有尝试日志保留，不能把失败轮次或跳过项描述为通过。

## 参数依据

[Anthropic模型元数据](https://platform.claude.com/docs/en/api/typescript/models/retrieve)、[共享上下文与输出](https://platform.claude.com/docs/en/build-with-claude/context-windows)、[Gemini模型元数据](https://ai.google.dev/api/models)、[OpenAI输出计数](https://developers.openai.com/api/docs/guides/token-counting)用于核对字段语义；适配器只发送明确支持的参数，保留API原生枚举。

## 1.0.10 正式发行回执

用户在候选合入后明确授权“直接发布”。候选verify [37192049044](https://github.com/kkelly-offical/kkcode/actions/runs/37192049044)、CodeQL [37192049043](https://github.com/kkelly-offical/kkcode/actions/runs/37192049043)，主线verify [37192924088](https://github.com/kkelly-offical/kkcode/actions/runs/37192924088)、CodeQL [37192923959](https://github.com/kkelly-offical/kkcode/actions/runs/37192923959)，正式发行 [37193159946](https://github.com/kkelly-offical/kkcode/actions/runs/37193159946)均通过。

- 最终本地完整检查4262项：4106通过、0失败、156条件跳过，另有CLI端到端33项通过。最终macOS测试已改用存储规范化后的临时目录路径，确认锁竞争模拟实际触发；原失败日志保留。
- 匿名npm、GitHub与CI tarball字节一致；原证书APK、android-update.json、SBOM、公开回执与SHA256SUMS可匿名下载。公开包在最低Node22.12安装及SDK／SQLite往返通过。
- Android10017原证书、v2/v3、非debug及10016→10017覆盖升级证据复用同一未变化的APK。未新增真实模型推理或生产服务升级。
- [稳定Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.10) · [公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.10/release-verification.json)；完整本机发行回执：`/tmp/kkcode-110-stable-25oiumt6/`。

本节是发行后的状态回写，发行tag和npm包保持原样，不重新打包或覆盖已发行产物。

## 发布后思考入口修复（2026-10-04）

用户在安卓模型面板完全看不到思考入口。实际本机进程仍为1.0.9；通过已认证的本地设备RPC确认旧`models.discover`不含`runtime`。确认对话与后台任务均为空后，正常停止remote、备份完整私密状态，以已核验的公开npm包升级1.0.10并恢复原tmux、`/root`、all-folders和企业网关连接。设备归属及配置文件字节保持，未恢复取消任务、未发起模型推理。备份入口为`/root/.local/state/kkcode-coding/backup-110-path`。

升级后还确认当前`kimi-code / k3`的实时目录只声明窗口和媒体能力，没有effort字段，1.0.10只显示自动。另发现安卓在使用默认模型但尚未显式选择时，以空模型ID寻找能力；旧服务缺字段时也直接隐藏控件，缺少原因提示。

- 按[Kimi官方规格](https://www.kimi.com/code/docs/kimi-code/models.html)补齐精确官方HTTPS端点及模型ID的能力。K3与标准coding模型提供low/high/max；none关闭思考并由服务端切换到K2.8 Preview，界面明确标为“直答（K2.8）”。高速模型保持固定思考。API已有控制声明优先，不给其他域名、路径、协议或同名模型套用此兜底。
- Android默认模型正确匹配能力；Android/Web对旧端缺字段、能力未确认和固定思考显示原因，不伪造可用档位。新App界面修复尚未进入已发行APK；现有1.0.10 App显式选中模型后可读取后端的新档位。
- 11项受控参数检查、Web真实设备服务交互检查、9项Android选择器检查通过，含旧端缺元数据及默认模型回归；类型和针对性lint通过。请求仅使用隔离fixture，不做真实推理效果宣称。
- 本机后端补丁正在准备，使用独立安装目录并记录源码提交与包哈希；不覆盖已发行tag、npm或APK。修复证据目录：`/tmp/kkcode-thinking-controls-fix-6l6xdsfk/`。
