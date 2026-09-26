# 历史发布与验收资料

[文档导航](README.md) · 当前使用指南按1.1.6源码维护，发行状态见[版本与升级](versions.md)。

历史文件保留当时版本、失败和收据，不全局替换成1.1.6，也不冒充新的重新验收。

未发行的[1.0.5准备记录](release-1.0.5.md)、[1.0.6维护](maintenance-1.0.6.md)和
[安全复核](security-review-1.0.6.md)现纳入[1.1.6源码整合](implementation-1.1.6.md)，不是历史发行。
文件路径保留以兼容外部链接；新用户先读当前指南，排查迁移时再查本页。

## 已公开发行

| 版本 | 说明与证据 |
| --- | --- |
| 1.0.5-preview.0 | [预发布说明](release-1.0.5-preview.0.md) · [完整实施过程](history/implementation-1.0.5-preview.0.md) · [公开Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.5-preview.0) |
| 1.0.4 | [正式版说明](release-1.0.4.md) · [实际发行回执](stable-1.0.4-worklog.md) |
| 1.0.4-preview.0 | [预发布说明](release-1.0.4-preview.0.md) · [实施记录](implementation-1.0.4.md) |
| 1.0.3（1.0.2 Fix） | [说明](release-1.0.3.md) · [回执](implementation-1.0.3.md) |
| 1.0.2 | [说明](release-1.0.2.md) · [实施记录](implementation-1.0.2.md) |
| 1.0.1 | [说明](release-1.0.1.md) · [实施记录](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/implementation-1.0.1.md) · [正式版工作账本](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/stable-1.0.1-worklog.md) |
| 1.0.1预览系列 | [preview.0](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/release-1.0.1-preview.0.md) · [preview.1](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/release-1.0.1-preview.1.md) · [preview.2](release-1.0.1-preview.2.md) |

完整历史也保留在[更新日志](../CHANGELOG.md)和[发布列表](https://github.com/kkelly-offical/kkcode/releases)。
重组前的长README可查看[已发布提交的快照](https://github.com/kkelly-offical/kkcode/blob/8efcb34d09db5b96693f3322661229a8b5fd84b4/README.md)，没有通过精简首页抹除沿革。

## 设计、兼容与旧验收

| 类别 | 保留资料 | 当前入口 |
| --- | --- | --- |
| 模式与权限沿革 | [0.4模式契约](kkcode-0.4.0-mode-contract.md)、[0.1.13航道](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/kkcode-0.1.13-mode-lane-contract.md)、[旧能力矩阵](cli-general-assistant-capability-matrix.md) | [当前模式](modes-and-permissions.md)、[当前能力](capabilities.md) |
| 长任务与委派 | [目标契约](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/kkcode-0.5.0-ultra-goal-contract.md)、[委派矩阵](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/task-delegation-contract-matrix.md)、[扩展指南](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/agent-longagent-compat-extension-guide.md) | [严格任务](trusted-runs.md)、[任务图](task-graphs.md) |
| 终端与UI | [终端演进](terminal-experience-0.3.3.md)、[移动端设计](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/mobile-ui-1.0.1.md)、[旧REPL路线图](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/repl-roadmap-0.1.27-0.1.36.md) | [CLI参考](cli-reference.md)、[任务监督](task-monitoring.md) |
| 架构与协议 | [内核/SDK拆分](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/architecture-kernel-sdk-1.0.0.md)、[旧协议矩阵](protocol-compatibility-1.0.1.md)、[工具复核](agent-workflow-instruction-tools-compat-1.0.1.md) | [SDK](sdk-guide.md)、[协议扩展](protocol-extensions.md) |
| 安全核查 | [1.0.4](security-review-1.0.4.md)、[1.0.2](security-review-1.0.2.md)、[1.0.1](security-review-1.0.1.md) | [当前告警核查](codeql-triage-1.0.5.md)、[数据策略](data-policy.md) |
| 实验与研究 | [企业实验记录](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/enterprise-lab-progress.md)、[旧插件兼容研究](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/plugin-skill-compat-0.2.4.md)、[旧竞对报告](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/kkcode-vs-claudenext-private-agent-longagent-report.md) | [部署](enterprise-deployment.md)、[插件](plugin-integrity.md)、[路线图](ROADMAP.md) |

旧记录中的“尚未发布”“测试进行中”只描述当时的提交；最新结论看有明确日期的
发行回执与当前Issue。不可删失败、改旧分数，或把旧CI冒充正式版准备分支的新验收。
