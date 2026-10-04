# KK Code 工作记忆

只维护当前状态、有效约束和未完事项。过程与证据写入[当前实施记录](docs/implementation-1.0.10.md)，
旧检查点见[历史记忆](docs/history/working-memory-through-2026-10-02.md)，不要逐轮追加日志。

## 发行与授权

- 已发布稳定 **1.0.9 / Android10016**（npm latest），发行提交`b0ef227`（PR#44），与最终候选`f9983b6`同树。
  候选／主线／发行跨平台、Web、CodeQL通过，匿名CI/npm/GitHub包一致，Node22.12及原证书10015→10016升级已核验。
  Preview仍为 **1.0.6-preview.1 / Android10012**；1.0.8与所有旧tag不移动。
  [versions.md](docs/versions.md)与公开release-verification.json是发行事实入口。
- 用户明确“允许所有来自我们的管理员合并操作”。本任务相关合入不重复询问；核验实际检查，
  不修改保护规则、不虚称批准审核、不自动合入无关PR#5/#6/#22。
- 用户10月4日授权修复后发布1.0.9正式版，已完成。未发布公共网关镜像、未升级其他生产／演示网关、未新增真实模型评测。

## 产品约束

- Agent / Auto / YOLO能力相同，差别是审批策略；Ultra增加持久任务状态与按需编排，显式staged／严格合同保留阶段流程，Plan只读探索、
  规划与持久ToDo。保持单个模式选择器、会话导航与输入区，不加未实现的远控按钮。
- ToDo完成、子代理汇报、checks_observed不是完整验收。未知效果先暂停核查；取消不回滚，
  恢复由用户触发并检查既有副作用，不能放松校验换取通过。
- 严格任务图保留宿主身份、范围和硬预算；普通委派预算仍是操作估算。工作树续作要明确交接，
  压缩/委派不得扩大账号、项目、会话或任务权限。
- 压缩时上传附件（含最近保留轮次）和召回正文只留短描述/引用，按需从私有归档召回。
  归档失败保留原历史并拒绝压缩；不能凭文字猜测删除普通粘贴。保留原始指令、证据和工具配对。
- Browser仅隔离Chromium与明确授权的本机Chrome/Edge桥接；不加跨设备调度/桌面遥控面板。
  不禁用沙箱或放宽全局userns；既定例外只适用于评测VM内两个固定Chromium路径。
- Android保持direct-SSH和原签名证书，公开版本码递增；CLI、Web网关、App分别升级。
  不宣称达到1.1.0成熟度、优于竞品或已完成延期的C04、GitLab和长期实用门禁。

## 实测与下一步

- [1.0.9清单](docs/implementation-1.0.9.md)全部完成并发行：普通会话取消强制测试门禁、上下文口径、自由滚动／最新定位、Compact取消／即时数字／历史折叠、Markdown表格、模型自动刷新和Android提示生命周期。普通回答结束不等于验收通过；显式配置和宿主严格合同仍保留门禁。
- 本机1.0.9 remote已在`tmux kkcode-coding`中从`/root`运行，通过原企业网关连接，all-folders及原身份／配置保留。升级前确认空闲并备份；不自动续跑已取消任务。私密升级记录与备份入口在`/root/.local/state/kkcode-coding/`。

- 1.0.7八项连续工作改进与1.0.8像素界面、KIKI伙伴、工具入口均已发行；伙伴建议只追加草稿、不自动发送或验收。
  当前跨平台、Web、CodeQL通过，Android85项JVM／80项UI与设备测试及签名升级通过，npm审计0告警。
  下一步是实际业务使用与人工审阅，不另建评测框架主线。
- 用户10月4日确认[下一轮优化清单](docs/optimization-next.md)：API模型参数自动配置、输出／思考／上下文同源预算、子代理配置与上下文管理、缩减Ultra固定编排及重复控制提示。接口值优先，缺失时分析已有返回数据并兜底；思考预备略思／审思／深思／精思／穷理五档（low/medium/high/xhigh/max），按接口能力动态映射并调整可见表述，不写死各档token阈值、不强凑档数，只有二态则显示开关，普通用户不必手填技术参数。已授权实施 **1.0.10 / Android10017，实现与专项验证完成、发行候选**，当前正式版仍为1.0.9；[实施记录](docs/implementation-1.0.10.md)维护实际检查与剩余事项；普通任务减少强制流程，权限、硬预算、未知效果与显式宿主合同保留。
- R15已关闭：`/root/kkcode-1061-wire-acceptance-20261002`；文档反馈修复通过，其余四项未完整交付。
  R16于10月3日02:41（UTC+8）关闭：`/root/kkcode-106-stable-harness-20261002`；437请求/
  23619076 tokens/USD0，无新增用量unknown，全栈工具效果unknown未解除。两批服务/授权均已关闭。
  [失败归因审计](docs/r16-harness-audit-2026-10-03.md)中的宿主缺陷已针对性修复，原结果与unknown不改写。
- 原截止**2026-10-02T04:02:34.744Z**未延长；历史继承2276请求/110224798 tokens/3旧unknown继续计账。
  新增用量或工具效果unknown须停止、核查并确定继续依据；不重用聊天秘密，不调整/重启vLLM。
  R12—R16与9月30日冻结评测不重启或修改；新模型调用须有新的有效授权和预算。
- 分支只清理已合入、无独有提交且未被工作树/开放PR使用者；旧清理恢复包保留在
  `/tmp/kkcode-1061-merged-branch-cleanup-wyr6zjog/`。其他开放Issues与历史失败保留。

## 证据入口

- [当前版本](docs/versions.md) · [发行范围](docs/release-1.0.9.md) · [实施与验收](docs/implementation-1.0.9.md)
- [使用文档](docs/README.md) · [能力边界](docs/capabilities.md) · [历史导航](docs/history.md)
- 1.0.10候选／PR#46交付回执：`/tmp/kkcode-110-candidate-u4w_66rm/`；未公开发行，实际完整检查见该目录`candidate-verification.json`及PR检查。
- 1.0.9发行回执：`/tmp/kkcode-109-stable-qv6gzea1/`。
- 1.0.8发行回执：`/tmp/kkcode-108-stable-_1tnlyzp/`。
- 1.0.7发行回执：`/tmp/kkcode-107-stable-ty7o6nqe/`；1.0.6：`/tmp/kkcode-106-stable-lakJaz/`。
- 旧冻结评测：`/root/kkcode-agent-eval-20260930`；参考源码：
  `/root/kkcode-architecture-audit-20260930`，不得执行竞品仓库安装脚本。
