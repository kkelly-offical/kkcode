# 文档导航（1.0.4 Preview / 1.0.3 Stable）

## 本轮预览版：1.0.4 Preview

- [Preview 说明](release-1.0.4-preview.0.md)、[实施与验收/发布回执](implementation-1.0.4.md)：自愿选择预览渠道，稳定标签不变。
- [SSH 与账号设备](ssh-account-devices.md)：Android 直连、仅元数据同步、断线排空任务。
- [上下文与 Harness](context-and-harness.md)：完整预算、提示诊断、受控组合、未知结果恢复与无进展保护。
- [MCP OAuth / ACP](protocol-adapters.md)、[SDK 使用](sdk-guide.md)。

## 当前已发布稳定版

- [1.0.2 Fix 升级说明](release-1.0.3.md)：技术版本 1.0.3，App 与网关登录专项修复。
- [Android 网关登录](android-gateway-login.md)：双层回调、后台恢复、取消、兼容和部署。
- [1.0.3 验收账本](implementation-1.0.3.md)：真实浏览器、生命周期与发布回执。

## 当前使用与部署

- [项目首页](../README.md)：安装、模式、命令及稳定/预览渠道。
- [1.0.2 使用说明](release-1.0.2.md)：会话管理、Auto 审查、Worktree、Browser、媒体修复与升级边界。
- [Android 应用更新](android-app-updates.md)：GitHub 更新源、下载校验和系统安装确认。
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

- [1.0.2 实施记录](implementation-1.0.2.md)：本轮开发、测试及最终发布回执；未完成项不会冒充已发布。
- [1.0.2 安全复核](security-review-1.0.2.md)：媒体、Auto、Browser、Worktree 边界与静态告警处置。
- [1.0.1 实施记录](implementation-1.0.1.md)：按轮次记录代码与证据。
- [正式版工作台账](stable-1.0.1-worklog.md)：本轮门禁、真实模型/安装与发布证据。
- [正式版安全复核](security-review-1.0.1.md)：更新器、目录授权和静态告警口径。
- [preview.2 工作台账](preview.2-worklog.md)：上一轮门禁、失败和修复过程。
- [preview.2 安全复核](security-review-1.0.1-preview.2.md)：真实修复与静态误报依据分开记录。
- [M28 复核与收尾](agent-workflow-instruction-tools-compat-1.0.1.md)。
- [路线图](ROADMAP.md)：未承诺的后续方向与明确的支持边界。

## 历史文档如何阅读

文件名含旧版本号的发布说明、对比报告与阶段计划是当时记录，不代表当前能力。
`release-1.0.1-preview.0.md`、`release-1.0.1-preview.1.md` 中的版本码、测试数量和
当时的待办应保留，不能改成新版本来冒充重新验收。当前行为以本导航中的使用
指南、对应源码和最新实施台账为准。

不要把“接口存在”“单元测试通过”“实验部署通过”“当前企业生产验收通过”混为一谈。
生产环境的租户、域名证书、备份介质与设备策略必须按部署手册逐项确认。
