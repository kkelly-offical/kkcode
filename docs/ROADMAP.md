# 路线图与维护入口

[文档导航](README.md) · 源码目标1.1.6（正式版准备中，尚未发布）· [版本状态](versions.md)

剩余问题以[GitHub Issues](https://github.com/kkelly-offical/kkcode/issues)为准。
本页负责按主题导航，不再复制一份会过期的“已完成／未完成”长表；关闭Issue需修复和验收证据。

## 当前推进方向

| 方向 | 跟踪入口 | 处理原则 |
| --- | --- | --- |
| 恢复与模型行为 | [C04补验 #7](https://github.com/kkelly-offical/kkcode/issues/7)、[C11驱动 #8](https://github.com/kkelly-offical/kkcode/issues/8)、[空输出／失败恢复 #9](https://github.com/kkelly-offical/kkcode/issues/9) | 已确认缺陷与未覆盖验证分开，不能改旧分数制造通过 |
| 严格依赖环境 | [workspaces #10](https://github.com/kkelly-offical/kkcode/issues/10)、[其他生态 #11](https://github.com/kkelly-offical/kkcode/issues/11)、[环境维护 #12](https://github.com/kkelly-offical/kkcode/issues/12) | 保持来源、脚本、凭据和离线边界 |
| 资源与安全 | [磁盘／inode #13](https://github.com/kkelly-offical/kkcode/issues/13)、[历史告警 #14](https://github.com/kkelly-offical/kkcode/issues/14) | 不把已有内存限制当磁盘配额，不把告警全称为漏洞或全称为误报 |
| 真实任务与设备验收 | [质量／Ultra #15](https://github.com/kkelly-offical/kkcode/issues/15)、[跨平台／真机 #16](https://github.com/kkelly-offical/kkcode/issues/16)、[GitLab #17](https://github.com/kkelly-offical/kkcode/issues/17)、[长期观察 #18](https://github.com/kkelly-offical/kkcode/issues/18) | 工程测试不代替模型、平台或生产实测；长期观察不是收费试用期 |
| 文档与发布治理 | [当前／历史分离 #19](https://github.com/kkelly-offical/kkcode/issues/19)、[npm分发验证 #20](https://github.com/kkelly-offical/kkcode/issues/20)、[rulesets #21](https://github.com/kkelly-offical/kkcode/issues/21) | 当前指南统一，发行与分发状态核实，不旁路分支审核 |

本次1.1.6整合文档与已验收的运行时／安全修复，统一源码版本，不自动关闭以上Issue，
不重启过期的模型测试授权。实际范围见[本轮记录](implementation-1.1.6.md)。
具体复现、验收清单与讨论留在各Issue，避免文档和Issue互相矛盾。

## 保持的产品方向

- 终端优先，多端连接同一工作电脑；Android原生客户端，不在手机内嵌Agent运行时。
- 默认沿用会话模型，允许明确的职责路由；敏感动作保留用户、策略和预算边界。
- 大任务以独立工作区、可核查产物和独立验收推进；目标是可审查的PR/MR，不自动合并发布。
- MCP、Skills、插件和分域SDK按真实支持子集发展，不把“有入口”当完整协议认证。

## 暂缓与不自动扩展的范围

公共网关镜像继续暂缓，部署采用源码构建。不新增Web SSH代理、跨设备浏览器调度、
桌面远控或浏览器直播控制面板。企业更新源、静默安装、签名轮换等需要独立需求与设计。
任何生产部署、付费模型测试或新账号／仓库操作均需独立授权。

原[1.0.5→1.1.0计划](plan-1.0.5.md)仍作为成熟度目标保留；观察周期可重新商定，
但不能把尚未完成的验收写成完成。用户指定1.1.6源码不代表这些门槛已达到；正式发布仍需独立授权。
