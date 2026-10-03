# 1.0.7 正式版

[版本与升级](versions.md) · [实施与验证](implementation-1.0.7.md)

已发布 **1.0.7 / Android10014**：npm latest、[GitHub稳定Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.7)及原证书APK。
公开下载、CI/npm/GitHub包一致性、签名与10013→10014覆盖升级已核验；
[完整发行回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.7/release-verification.json)。

本版集中改善智能体连续工作的八个环节：

- 错误恢复：宿主确认的零写入编辑失败可以纠正，历史权限拒绝不再误伤后续修复。
- 受管进程：等待窗口与服务寿命分开，临时服务有归属、增量日志和协作停止。
- 任务收尾：聚焦当前验收缺口，减少重复提示，不把失败或未知操作报成完成。
- 压缩与附件：保存有界的任务交接信息；上传附件及召回正文仅留简述和引用，按需读取。
- 工具反馈：明确工作目录、状态、退出结果、日志游标与截断情况。
- 动态ToDo：支持局部修订、变更原因和版本冲突恢复，保留未修改事项。
- 中途插话：CLI、Web、Android可持久接收运行中新指示，取消后未读指示仍保留。
- 子代理交接：带回文件、检查、阻碍和工作树位置，继续沿用原范围与预算。

CLI/Web/Android沿用原布局与单一模式选择器。Agent / Auto / YOLO能力一致、审批策略不同；
Plan保持只读，Ultra保留持久分阶段编排。未知效果仍须核查，取消不等于回滚。

使用说明：[连续工作与上下文](context-and-harness.md)、[任务监督与插话](task-monitoring.md)。
CLI、网关/Web和Android分别升级，本轮没有发布公共网关镜像或升级生产/演示。
本版工程检查不代表真实模型长期任务已全部通过；原R12—R16结果与未解除的未知操作保持原样。
