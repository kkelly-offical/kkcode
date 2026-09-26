# KK Code

**从终端出发，把模型、工具和远程设备连成一个可控的编码工作台。**

![KK Code 产品概念图：对讲机与编码伙伴连接工作区](docs/assets/brand/kkcode-product-banner.jpg)

[![npm](https://img.shields.io/npm/v/@kkelly-offical/kkcode?label=stable)](https://www.npmjs.com/package/@kkelly-offical/kkcode)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22.12-green)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)

源码版本 **1.0.5 · 正式版准备中，尚未发布**。已发布稳定版为 1.0.4，预览版为
1.0.5-preview.0；[版本与升级](docs/versions.md)区分源码、发行渠道与部署状态。
上图为品牌概念图，不是实际界面截图。

## 产品特色

- **模型由你选择**：通过自己的 Base URL 发现模型；支持 OpenAI 兼容、Responses、Anthropic 等协议，按需切换模型与职责。
- **终端、网页、手机协同**：本地 WebUI、自托管 OIDC/SSO 中继网关和原生 Android 客户端，共享设备上的会话与审批；SSH 仅 Android 直连。
- **从日常助手到长任务**：Plan、Agent、Auto、Ultra、Yolo 五种模式；规划、编辑、工具调用、后台任务与独立工作树各有清楚的入口。
- **执行有边界，结果可核查**：权限、出域策略、审计、持久预算和证据产物；严格任务通过宿主合同、隔离副本与独立验收交付，不靠模型自称完成。
- **把开发工具接进来**：MCP、Skills、插件、分域 SDK，以及按需配置的 Browser/WebBridge、语言服务、Office/PDF 工具。
- **对话保持清爽**：Markdown、可展开的思考与工具过程、红绿差异、上下文用量和临时提示；Web/Android 保持紧凑的设备／会话布局。

上述能力有明确适用范围，尤其严格任务不等于普通聊天的默认隔离等级。
请先看[能力与边界](docs/capabilities.md)，不要把版本号更新视为所有成熟度验收已经完成。

<a id="installation"></a>
<a id="quick-start"></a>
## 快速开始

需要 Node.js **22.12+** 和 `ripgrep`。下面安装的是**已经发布的稳定渠道**，不是尚未发布的 1.0.5：

```sh
npm install -g @kkelly-offical/kkcode@latest
kkcode
```

首次启动后配置自己的模型服务，再选择工作目录开始对话。
[安装与首次配置](docs/getting-started.md)包含系统依赖、源码运行和故障排查。

```sh
kkcode -web       # 本机 WebUI，默认 18271
kkcode remote     # 工作电脑上的远控入口，首次登录并确认目录范围
```

远程使用需要你自己的网关／SSO，详见[企业自托管](docs/enterprise-deployment.md)。
安装包不会自动部署服务器、开放公网端口或授权访问全部目录。

## 文档导航

| 你想做什么 | 从这里开始 |
| --- | --- |
| 安装、配置模型、开始第一次对话 | [快速开始](docs/getting-started.md) · [配置与模型](docs/configuration.md) |
| 选择模式、使用命令与快捷键 | [模式与权限](docs/modes-and-permissions.md) · [CLI 参考](docs/cli-reference.md) |
| 使用 Web、Android 与企业远控 | [部署指南](docs/enterprise-deployment.md) · [Android 更新](docs/android-app-updates.md) · [SSH 设备](docs/ssh-account-devices.md) |
| 运行可恢复、可审查的大任务 | [严格任务](docs/trusted-runs.md) · [上下文与记忆](docs/context-and-harness.md) |
| 接入工具、扩展或自己的客户端 | [协议与 Skills](docs/protocol-extensions.md) · [插件](docs/plugin-integrity.md) · [SDK](docs/sdk-guide.md) |
| 查支持范围、升级状态与开发计划 | [能力边界](docs/capabilities.md) · [版本与升级](docs/versions.md) · [路线图](docs/ROADMAP.md) |

[全部文档](docs/README.md) · [历史发布与验收](docs/history.md) · [更新日志](CHANGELOG.md)

## 参与开发

欢迎提交可复现的问题和小步、可验证的改进：[Issues](https://github.com/kkelly-offical/kkcode/issues) ·
[贡献与验证](docs/contributing.md)。剩余事项以 Issues 为准，不把登记待办写成已修复。

KK Code 使用 [GPL-3.0](LICENSE) 许可证。
