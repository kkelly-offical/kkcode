# KK Code 文档

当前指南统一按 **1.1.6源码**维护；仅更新源码，**尚未发布**。
已发布渠道、Android版本码与升级入口只在[版本与升级](versions.md)集中维护。
历史材料保留原始版本和证据，不作为当前使用说明。

## 开始使用

| 目标 | 指南 |
| --- | --- |
| 安装、第一次启动、常见排查 | [快速开始](getting-started.md) |
| 配置Base URL、模型、凭据和职责 | [配置与模型](configuration.md) · [模型发现](gateway-model-discovery.md) · [Responses](responses-api.md) |
| 理解Plan/Agent/Auto/Ultra/Yolo | [模式与权限](modes-and-permissions.md) |
| 找命令、快捷键、终端回退方案 | [CLI参考](cli-reference.md) |
| 确认哪些能力支持、哪些尚未验证 | [能力与边界](capabilities.md) |

## Web、Android 与企业自托管

- [网关、OIDC/SSO与部署](enterprise-deployment.md) · [高可用与备份恢复](enterprise-ha-recovery.md)
- [Android更新](android-app-updates.md) · [Android签名与发行](android-release.md) · [登录回跳](android-gateway-login.md)
- [Android SSH与账号设备](ssh-account-devices.md) · [目录范围与信任](remote-folder-browsing.md)
- [跨端任务监督](task-monitoring.md) · [命令契约](remote-command-contract.md) · [SSE与同步](remote-sse-contract.md)
- [设备事件与容量维护](device-retention.md)

App、设备CLI和网关分别升级。公共网关镜像发布暂缓，继续从源码构建；没有自动生产部署。

## 可信任务、上下文与交付

- [严格任务流程](trusted-runs.md) · [隔离与范围授权](strict-isolation.md) · [项目数据出域](data-policy.md)
- [上下文与Harness](context-and-harness.md) · [项目／个人记忆](scoped-memory.md) · [账本与产物](sdk-storage.md)
- [持久预算](durable-budgets.md) · [职责模型](model-roles-and-profiles.md) · [任务图](task-graphs.md)
- [独立审查](independent-review.md) · [GitHub/GitLab交付](forge-delivery.md)
- [离线依赖环境](dependency-environments.md) · [评测定义与证据口径](evaluation-suite.md)

## 工具与扩展

- [Browser工作流](browser-workflows.md) · [本机Chrome/Edge桥接](browser-bridge.md) · [实验站点配方](browser-recipes.md)
- [Office/PDF](office-tools.md) · [语言服务](language-services.md) · [宿主服务配置](host-services.md) · [媒体输入](media-input.md)
- [MCP/ACP/Skills支持范围](protocol-extensions.md) · [OAuth与编辑器入口](protocol-adapters.md)
- [工具发现与Skills](tool-discovery-and-skills.md) · [插件来源与升级](plugin-integrity.md) · [受限工具组合](tool-program.md)

## SDK 与贡献

- [分域SDK总览](sdk-guide.md) · [headless JSONL契约](headless-jsonl-contract.md)
- [配置字段参考](config.example.yaml) · [贡献与验证](contributing.md)
- [路线图与Issues](ROADMAP.md) · [1.1.6源码整合与验证](implementation-1.1.6.md)

## 历史与发行证据

[历史导航](history.md)集中保存旧版本发布、设计契约和试验记录；
[本轮实施记录](implementation-1.1.6.md)与[1.0.5历史账本](implementation-1.0.5.md)分开，保留各候选的真实结果。
新用户无需从旧版契约逐层寻找当前模式或配置。

源码中的测试、`scripts/`、`evaluation/` 和Android/Web开发工程不随全局npm包完整安装；
开发命令请在Git checkout执行。当前用户指南随包提供，历史研究和源码专用资料可在
对应GitHub链接阅读。任何验收回执都必须核对提交、环境和实际范围。
