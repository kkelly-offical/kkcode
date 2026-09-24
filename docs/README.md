# 文档导航：稳定版 1.0.4 / 预发布 1.0.5-preview.0

公开稳定版仍是 **1.0.4**；**1.0.5-preview.0 已公开预发布**，但没有自动部署
生产网关或更新设备。源码接口、本地验收和已公开发版是三种不同状态。

## 开发中：1.0.5 Preview → 1.1.0

- [剩余维护待办（源码文档）](backlog/1.0.5/README.md)：15项按缺陷／能力／验收分组，分别记录范围、验收标准和后续提交建议；登记不代表已修复。
- [批准的完整开发计划](plan-1.0.5.md)：W01–W13 范围、产品决策、Preview与成熟版门禁。
- [实际实施账本](implementation-1.0.5.md)：公开发行和验证回执；完整模型质量验收明确后补，不代表生产已经升级。
- [新增 CodeQL 告警核查](codeql-triage-1.0.5.md)：64–71 的逐项证据与修复；扫描成功不等于没有告警，不关闭规则掩盖问题。
- [持久账本与产物 SDK](sdk-storage.md)、[SDK总览](sdk-guide.md)：可信宿主写接口与增量远程读/控制接口的边界。
- [离线 npm 依赖环境](dependency-environments.md)：`kkcode environments inspect/prepare/verify`、`sdk/environments`、独立安装脚本批准和严格任务只读挂载；不支持所有包管理器／workspaces。
- [项目数据出域基础](data-policy.md)：受管理模型/网页工具的目标交集策略，不能替代执行沙箱。
- [严格委托隔离](strict-isolation.md)、[独立验收](independent-review.md)、[任务图](task-graphs.md)：独立工作区、候选证据、审批与恢复。
- [持久预算](durable-budgets.md)、[跨端任务监控](task-monitoring.md)：父子总额度、未知计费、状态与停止回执。
- [严格任务使用流程](trusted-runs.md)：合同示例、预览确认、独立工作树、恢复、验收与交付。
- [Forge交付](forge-delivery.md)：GitHub PR/GitLab MR，外部授权与未知操作核查。
- [记忆管理](scoped-memory.md)、[职责模型与能力档案](model-roles-and-profiles.md)。
- [Browser工作流](browser-workflows.md)、[本机浏览器桥接](browser-bridge.md)：受控上传下载；Bridge 主 frame、无全局按键、截图另行授权，非像素级 origin 数据隔离。
- [Chrome/Edge 三系统验收](browser-bridge-branded-acceptance.md)：临时 CI profile 的官方扩展安装调试，不访问个人浏览器，不等同商店安装 UI 验收。
- [真实Chromium沙箱验收](browser-strict-acceptance.md)：非root实机证据；受阻不是通过，禁止降级安全设置。
- [实验网站操作配方](browser-recipes.md)：主动录制、审核、隔离验证、固定版本及逐叶治理。
- [60任务独立验收](evaluation-suite.md)：40开发/20封存、真实模型与零推理自检分离、双轮结果门禁。
- [Office/PDF/Markdown](office-tools.md)、[语言服务](language-services.md)、[宿主服务配置](host-services.md)。
- [MCP/ACP/Skills](protocol-extensions.md)、[插件完整性与升级](plugin-integrity.md)、[实验受控工具组合](tool-program.md)。
- 下面的1.0.4章节是已发布稳定版记录，不用新版本号覆盖历史验收。

专用验收分支已推送，仍未合入 main。真实 GitHub SDK 工程往返已形成
[草稿 PR #5](https://github.com/kkelly-offical/kkcode/pull/5)，无人工批准，不能称 merge-ready；
GitLab 尚缺验收资源。本机 vLLM 真实模型 120 轮、Chrome/Edge 三系统矩阵、
新版 CI 全绿与七天试用仍未完成；本地 fixture、自检、条件跳过或历史结果不能替代。
新版 CI 的真实失败／受阻已记入实施账本，不是“尚未运行”。`1.1.0` 是后续成熟度目标。

## 安装包与源码文档

npm 的运行时与 SDK 入口由 `package.json` 的 `exports` 定义，使用文档按 `files`
清单打包。新分域接口只能在包含它们的源码／后续发行包中使用，不能假定已发布的
1.0.4 已有所有入口。完整测试、`scripts/`、`evaluation/`、Android/Web 开发工程和
部分历史资料只在 [源码仓库](https://github.com/kkelly-offical/kkcode) 中；文档里提及的
源码验收命令应在仓库运行，而不是在全局 npm 安装目录执行。镜像构建目录
`containers/office/`、`containers/lsp/` 随当前包清单提供，镜像本身不自动安装。

## 1.0.4 正式版本

- [正式版说明](release-1.0.4.md)、[实际验收与发布账本](stable-1.0.4-worklog.md)。
- [Responses API](responses-api.md)：渠道配置、流式/工具/思考续接、隐私与支持边界。
- [安全复核](security-review-1.0.4.md)：新增协议的数据隔离、静态告警口径与发行安全。
- [SSH 与账号设备](ssh-account-devices.md)：中文故障检查、并列导航与后台重连。
- 是否公开发布以实施账本回执为准；不另发第二个预览版，也不自动部署生产环境。

## 保留的历史预览渠道：1.0.4 Preview

- [Preview 说明](release-1.0.4-preview.0.md)、[实施与验收/发布回执](implementation-1.0.4.md)：自愿选择预览渠道，稳定标签不变。
- [SSH 与账号设备](ssh-account-devices.md)：Android 直连、仅元数据同步、断线排空任务。
- [上下文与 Harness](context-and-harness.md)：完整预算、提示诊断、受控组合、未知结果恢复与无进展保护。
- [MCP OAuth / ACP](protocol-adapters.md)、[SDK 使用](sdk-guide.md)。

## 先前稳定版与登录专题

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
