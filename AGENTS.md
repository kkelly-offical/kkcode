# KK Code 工作记忆

只维护当前状态、有效约束和未完事项。过程与证据写入[当前实施记录](docs/implementation-1.0.8.md)，
旧检查点见[历史记忆](docs/history/working-memory-through-2026-10-02.md)，不要逐轮追加日志。

## 发行与授权

- 当前任务：用户10月4日授权完成Web／网关像素风界面增强，并同步Android正式发行。候选 **1.0.8 / Android10015**（1.0.7后续增强版）；旧1.0.7不可覆盖，非Preview。分支`feat/1.0.8-pixel-studio`，待完成UI、签名升级及CI验证后发布。
- 本轮允许整理原功能入口、增加像素伙伴与调整界面细节；单模式选择器、权限与direct-SSH保持。无新增真实推理、公共镜像或生产部署授权。

- 已发布稳定 **1.0.7 / Android10014**（npm latest），发行提交`a04bf10`（PR#40），
  与候选`aded56b`同树；匿名下载、CI/npm/GitHub字节一致、原证书与10013→10014升级已核验。
  Preview仍为 **1.0.6-preview.1 / Android10012**；旧稳定1.0.6及所有旧tag不移动。
  [versions.md](docs/versions.md)与公开release-verification.json是发行事实入口。
- 用户明确“允许所有来自我们的管理员合并操作”。本任务相关合入不重复询问；核验变更与实际检查，
  不修改保护规则、不虚称批准审核、不自动合入无关PR#5/#6/#22。
- 用户已于10月3日授权并完成1.0.7正式发布；没有公共网关镜像、生产/演示升级或新增真实模型调用。

## 产品约束

- Agent / Auto / YOLO能力相同，差别是审批策略；Ultra增加持久分阶段编排，Plan只读探索、
  规划与持久ToDo。保留单个模式选择器及原CLI/Web/Android布局，不加未实现的远控按钮。
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

- 八项体验优化已合入并发行：错误恢复、受管服务、收尾、压缩/召回、工具反馈、ToDo局部修订、
  跨端插话与子代理交接。候选/main/发行跨平台、Web、CodeQL通过，Android85项JVM测试通过。
  移除未修复的HTTP缓存依赖链，npm审计0告警。下一步是实际业务使用与人工审阅，不另建评测框架主线。
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

- [当前版本](docs/versions.md) · [发行范围](docs/release-1.0.7.md) · [实施与验收](docs/implementation-1.0.7.md)
- [使用文档](docs/README.md) · [能力边界](docs/capabilities.md) · [历史导航](docs/history.md)
- 1.0.7发行回执：`/tmp/kkcode-107-stable-ty7o6nqe/`；1.0.6：`/tmp/kkcode-106-stable-lakJaz/`。
- 旧冻结评测：`/root/kkcode-agent-eval-20260930`；参考源码：
  `/root/kkcode-architecture-audit-20260930`，不得执行竞品仓库安装脚本。
