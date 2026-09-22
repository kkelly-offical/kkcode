# 文档导航（1.0.1-preview.2）

## 当前使用与部署

- [项目首页](../README.md)：安装、模式、命令及稳定/预览渠道。
- [第三预览版](release-1.0.1-preview.2.md)：本轮变化、升级步骤、验收边界。
- [配置参考](config.example.yaml)：这是示例，不是自动注入的模型清单；模型以用户 Base URL 返回的目录和用户手动配置为准。
- [媒体输入](media-input.md)：CLI/Web/Android、协议、格式、大小和剪贴板差异。
- [工具发现与技能](tool-discovery-and-skills.md)：tool_search、兼容别名、task brief、分层指令与 skill 标志。
- [企业部署](enterprise-deployment.md)：云端网关、PostgreSQL、OIDC、HTTPS 与设备端的职责。
- [高可用与恢复](enterprise-ha-recovery.md)：多网关部署、备份恢复和实际演练。
- [Android 发布](android-release.md)：签名、升级版本码、模拟器和实体机边界。
- [远端 SSE](remote-sse-contract.md)、[文件夹浏览](remote-folder-browsing.md)、[命令契约](remote-command-contract.md)、[容量管理](device-retention.md)。
- [协议兼容矩阵](protocol-compatibility-1.0.1.md)：实际实现的 MCP/Skills/插件范围，不等同于兼容所有第三方运行时。
- [内核/SDK 架构](architecture-kernel-sdk-1.0.0.md)、[headless JSONL](headless-jsonl-contract.md)。

## 实施与验收记录

- [1.0.1 实施记录](implementation-1.0.1.md)：按轮次记录代码与证据。
- [preview.2 工作台账](preview.2-worklog.md)：本轮门禁、失败和修复过程。
- [M28 复核与收尾](agent-workflow-instruction-tools-compat-1.0.1.md)。
- [路线图](ROADMAP.md)：未承诺的后续方向与明确的支持边界。

## 历史文档如何阅读

文件名含旧版本号的发布说明、对比报告与阶段计划是当时记录，不代表当前能力。
`release-1.0.1-preview.0.md`、`release-1.0.1-preview.1.md` 中的版本码、测试数量和
当时的待办应保留，不能改成新版本来冒充重新验收。当前行为以本导航中的使用
指南、对应源码和最新实施台账为准。

不要把“接口存在”“单元测试通过”“实验部署通过”“当前企业生产验收通过”混为一谈。
生产环境的租户、域名证书、备份介质与设备策略必须按部署手册逐项确认。
