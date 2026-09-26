# 1.0.5 实施与验收状态

> 历史账本：当前源码目标已由用户调整为[1.1.6](implementation-1.1.6.md)，仍未发行。以下保留1.0.5阶段的实施／准备状态与原始成绩，不覆盖当前版本状态。

[文档导航](README.md) · [版本与升级](versions.md) · 更新日期：2026-09-25

## 1.0.5阶段结论（2026-09-25）

源码已调整为 **1.0.5**，用于正式版准备，**尚未发布1.0.5正式版**。
已公开的是1.0.5-preview.0；稳定渠道仍为1.0.4。此次维护不打tag、不发npm或APK，
不推公共网关镜像、不升级生产设备，也不重新运行模型测试。

当前工作是README精简、专题导航和版本一致性维护，不是修复所有运行时问题。
未完成事项以[GitHub Issues](https://github.com/kkelly-offical/kkcode/issues)为准。
历史失败、版本和成绩保留在[预览阶段完整归档](history/implementation-1.0.5-preview.0.md)。

## 当前工作包概览

| 范围 | 已有实现／证据 | 仍需注意 |
| --- | --- | --- |
| W01–W03 契约、账本、产物 | 受控HTTP、持久执行、迁移备份、归档与跨端受权访问已有工程回归 | 工程回归不是所有真实任务恢复均已验证 |
| W04–W05 上下文、记忆、模型 | 完整请求预算、压缩保护、来源记忆、职责档案和计费已接入 | 完整修订版模型评测与同模型A/B待补 |
| W06–W07 严格执行与独立验收 | Linux Docker、宿主合同、独立副本、候选绑定与验收链已实现 | 普通聊天不自动受此保护；Docker Desktop与硬磁盘配额有缺口 |
| W08 Forge | 真实GitHub专用草稿PR往返已做；无人工批准时正确阻断 | GitLab真实MR尚待资源，不自动合并／发布 |
| W09 任务图、依赖与LSP | 持久任务图、父子预算、五语言专项、离线npm环境已接 | workspaces及其他包管理器不属于已支持的严格离线范围 |
| W10 Browser/WebBridge | 六格Chrome/Edge与Linux严格Browser有真实工程证据 | 不是桌面远控／商店安装UI验收；Bridge主frame、截图另行授权 |
| W11 Office/PDF | 固定镜像里的解析、渲染、重算、OCR与产物交付已测 | 格式边界与实际平台支持仍需遵守 |
| W12–W13 协议、SDK、多端 | MCP/ACP子集、插件锁、SDK安装、Web/Android及SSH工程回归已有证据 | 不等于所有企业IdP、实体手机、模型或生产部署已验收 |

上表归纳已有代码和历史预览证据，不将它们冒充新的1.0.5正式候选验收。
具体约束见[能力与边界](capabilities.md)，操作入口见[文档导航](README.md)。

## 已发布预览版的回执

- 版本1.0.5-preview.0，提交 `8efcb34d09db5b96693f3322661229a8b5fd84b4`；
  标签对象 `225d602cba278de978614e89dfb53582a42dc4a1`，已公开且不可移动。
- [发行CI](https://github.com/kkelly-offical/kkcode/actions/runs/36002075645)、
  [main验证](https://github.com/kkelly-offical/kkcode/actions/runs/36001404815)、
  [完整工程验收](https://github.com/kkelly-offical/kkcode/actions/runs/36001401771)和
  [CodeQL](https://github.com/kkelly-offical/kkcode/actions/runs/36001404854)成功；17条历史告警继续跟踪。
- 匿名npm／GitHub CLI包与CI包SHA-256一致：
  `a3eceafb7c7b66e471fae8512eaa0246ea7866cde422628a3d2b1b599a97a99b`；
  最低Node22.12干净安装、16个公开入口、SQLite worker和产物存储通过。
- Android10009沿用正式证书；公开APK SHA-256：
  `8ba22e0290cf113dcacb4c843ec18a660ad116cc4d07478169fc685e98eb0fec`。
  匿名下载、v2/v3验签、非调试属性和实际更新策略通过，不冒充实体手机UI实测。
- 网关镜像仅本地构建，非root／只读根／network-none回归19/19通过；未推公共registry或自动部署。

公开摘要见[预发布页面](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.5-preview.0)
附带的 `release-verification.json`。此前文档回执[PR #6](https://github.com/kkelly-offical/kkcode/pull/6)
与本次维护有内容重叠；PR存在不等于已合入，也不应再覆盖新指南。

## 真实模型结果与未覆盖项

原v3固定120项：108通过、11失败、1错误（90%），关键恢复未全过，质量门禁为false。
v4六次专项：C10/C13各两次通过，C04两次错误、真实重连边界未覆盖。
这些结果不能拼接成完整新版门禁通过。

C11旧ENOENT已用公开合成对照定位为评测驱动的工具顺序假设，未复现产品隔离失效；
旧结果不补分。完整修订版评测、真实Ultra闭环、同模型A/B、GitLab及长期实际使用观察
继续按Issues推进。旧推理授权已结束，没有后台继续测试；新的测试需新的有限授权。

## 1.0.5 正式版准备记录

- 根包和四个工作区／锁文件统一1.0.5；Android版本名1.0.5、版本码预留10010。
- CLI／Web仍由根包版本派生；仅为版本显示重建Web静态资源，不改变现有界面布局。
- README只保留产品特色、快速开始与文档入口；详细用法移到当前专题指南。
- 文档／版本检查只证明本次维护一致，不自动满足正式发行或1.1.0成熟度门槛。
- 正式发版须单独确认，见[准备说明](release-1.0.5.md)；生产部署仍单独授权。
