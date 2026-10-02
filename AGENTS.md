# KK Code 工作记忆

只维护当前状态、有效约束和未完事项。过程写入[实施记录](docs/implementation-1.0.6.md)，
旧检查点见[历史记忆](docs/history/working-memory-through-2026-10-02.md)，不要逐轮追加日志。

## 发行与授权

- 已发布稳定 **1.0.5 / Android10010**（npm latest）及 **1.0.6-preview.1 / Android10012**。
  Preview.1为47aa1bf（PR#34），与验收候选6d8806f同树；匿名下载、哈希、签名与升级已核验。
  [versions.md](docs/versions.md)和公开release-verification.json是发行事实入口；旧标签不移动。
- 用户明确“允许所有来自我们的管理员合并操作”。对本任务相关合入不再重复询问；核验变更
  与实际检查，不修改保护规则、不虚称批准审核、不自动合入无关PR#5/#6/#22。
- 用户最新明确要求修复后发布 **1.0.6正式版 / Android10013**，授权本轮npm latest、GitHub稳定Release
  和原证书APK。完成必要工程、安全与安装包检查；不发布网关镜像、不升级生产/演示，不改旧标签。

## 产品约束

- Agent / Auto / YOLO能力相同，差别是审批策略；Ultra增加持久分阶段编排，Plan只读探索、
  规划与持久ToDo。保留单个模式选择器及原CLI/Web/Android布局，不加未实现的远控按钮。
- ToDo完成、子代理汇报、checks_observed不是完整验收。未知效果先暂停核查；取消不回滚，
  恢复由用户触发并检查既有副作用，不能放松校验换取通过。
- 严格任务图保留宿主身份、范围和硬预算；普通委派预算仍是操作估算。工作树续作要明确交接，
  压缩/委派不得扩大账号、项目、会话或任务权限。
- 压缩时上传附件（含最近保留轮次）移入私有归档，只留短描述/引用，按需召回。归档失败保留
  原历史并拒绝压缩；不能凭文字猜测把普通粘贴当附件删除。保留原始指令、证据和工具配对。
- Browser仅隔离Chromium与明确授权的本机Chrome/Edge桥接；不加跨设备调度/桌面遥控面板。
  不禁用沙箱或放宽全局userns；既定例外只适用于评测VM内两个固定Chromium路径。
- Android保持direct-SSH和原签名证书，公开版本码递增；CLI、Web网关、App分别升级。
  不宣称达到1.1.0成熟度、优于竞品或已完成延期的C04、GitLab和长期实用门禁。

## 实测与下一步

- 发布工程检查已完成；PR#35的发行回执和文档维护已合入，候选及main检查均通过。
- R15使用实际公开包，目录`/root/kkcode-1061-wire-acceptance-20261002`，五场景已结束并关闭。
  文档反馈修复通过，其余四项未完整交付；服务已停、授权撤销。看实施记录及private/closure-receipt.json。
- 本轮在`fix/1.0.6-stable-20261002`修复Vite命令分类、Responses推理重复计数及短历史压缩，
  并在新的评测副本修复依赖链接复制。当前验收/发行准备中，尚未发布正式1.0.6。旧成绩不改写。
- 新模型针对性复验已询问独立有限授权，尚未收到回复；当前只做工程/隔离环境回归。原截止
  **2026-10-02T04:02:34.744Z**未延长。新增用量unknown须停止、核查并确定继续依据，不重用聊天秘密，
  不调整/重启vLLM。历史3笔unknown继续计账；R12/R13/R14已关闭，不重启或改写旧记录。
- 分支只清理已合入、无独有提交且未被工作树/开放PR使用者；本轮已清理43远端、48本地，
  恢复包在`/tmp/kkcode-1061-merged-branch-cleanup-wyr6zjog/`。保留其他开放Issues与历史失败。

## 证据入口

- [当前版本](docs/versions.md) · [发行范围](docs/release-1.0.6.md) · [实施与验收](docs/implementation-1.0.6.md)
- [使用文档](docs/README.md) · [能力边界](docs/capabilities.md) · [历史导航](docs/history.md)
- 发行回执与本机资料：`/tmp/kkcode-1061-release-final-20261002/`；完整公开回执在GitHub Release。
- 9月30日旧冻结对照评测`/root/kkcode-agent-eval-20260930`不可修改/重启；参考源码位于
  `/root/kkcode-architecture-audit-20260930`，不得执行竞品仓库安装脚本。
