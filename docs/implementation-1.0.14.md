# 1.0.14 实施与验收

用户先要求完成优化并交付最终候选，随后明确授权正式发布，并要求 Windows 同时以未签名实验版发布。目标 **1.0.14 / Android10021 / Windows x64 实验版**。候选准备与正式发行证据分别保留；正式发行事实见文末与[版本页](versions.md)。本轮未部署其他网关。

## 范围与修复

- 纳入 PR#70 的存量缺陷修复，原 HEAD `75fbf72` 的审查与失败证据保留在[1.0.13 实施记录](implementation-1.0.13.md)与 `/tmp/kkcode-pr70-review-evidence/`。
- Android 新回归改用 Robolectric 4.17 的 Android 35 环境及真实 Application / SharedPreferences，移除直接引用 `sun.misc.Unsafe`、修改静态 SDK 字段和错误的可空 Map 键夹具。配置依据[官方测试接入说明](https://robolectric.org/getting-started/)，仅作为测试依赖。
- 两份 Web 草稿隔离 / 状态恢复专项纳入 `test:web`；新增 Android 恢复草稿仪器测试纳入完整 UI 套件。浏览器专项保持 Chromium 沙箱。
- 所有工作区、锁文件与 Android 版本同步为 1.0.14 / 10021；重新生成并提交 Web 分发资源，密钥扫描保留原校验强度。

## 候选检查

| 检查 | 当前结果 |
| --- | --- |
| 版本与文档入口 | 版本一致性及 19 项文档 / 发行策略 / SDK 类型专项通过 |
| 跨平台发行检查 / 覆盖率 / e2e / 打包 | 代码候选 `a80d72e` 四组矩阵通过；本机 4373 项中 4216 通过、157 跳过、0 失败；行 / 分支 / 函数覆盖率 83.91% / 81.40% / 82.25%；独立 e2e 36 项与包安装往返通过 |
| Web 全部专项 | 14 份浏览器 smoke 与 9 项 Web 单元全部通过，包括新草稿 / 重连专项与真实子代理租约释放；专用非 root 账号，Chromium 沙箱开启 |
| CodeQL 三种语言与完整告警核对 | 候选三种语言通过；另行完整扫描通过，Preview 开放告警 0 项 |
| Android JVM / UI / 原证书升级 | 109 项 JVM / 93 项界面通过；原证书 v2 / v3、非调试 APK、10020→10021、首次安装时间与浅色偏好保留、正常启动及 run-as 拒绝通过 |
| Windows 原生安装与退出 | 代码候选原生构建、安装 / 重装 / 卸载数据保留与桌面 smoke 通过；实际签名状态附候选回执 |
| npm 包 / 最低 Node22.12 安装 | Node22.12.0 的真实安装、877 个分发文件扫描、SDK / 持久化 / SQLite 往返通过；官方 Node 二进制 SHA-256 已核对 |

代码候选 `a80d72e` 的 [跨平台与 Web 检查](https://github.com/kkelly-offical/kkcode/actions/runs/38378923712)、[Windows 原生检查](https://github.com/kkelly-offical/kkcode/actions/runs/38378923722)、[PR CodeQL](https://github.com/kkelly-offical/kkcode/actions/runs/38378923725)和[完整 CodeQL](https://github.com/kkelly-offical/kkcode/actions/runs/38379016076)均已通过。后续说明与回执更新保留上述实际提交与运行，不冒称批准 review；最终候选的提交、检查和不可变产物哈希以随包 `release-verification.json` / `SHA256SUMS` 为准。

候选源码在 `/tmp/kkcode-114/source`，日志与失败原证据在 `/tmp/kkcode-114/evidence/`。本机非 root 浏览器初次遇到公开依赖的读 / 执行权限与测试账号默认 home 不存在问题；改用本任务专用的真实私密 home 并补齐公开依赖的必要权限后接续完整套件，保留原失败日志，没有修改断言、放宽存储所有者检查、关闭沙箱或更改全局 userns。Node / APK 下载失败与后续哈希验证也分别保留。

## 交付与发布边界

- 交付 CLI / 网关 npm 归档、原证书 Android APK、Windows x64 安装器、源码归档、版本说明、更新清单、校验回执与 SHA256SUMS。
- 初次交付候选时没有创建发行标签、发布 npm / GitHub Release 或部署网关；用户随后授权正式发布。Preview 与其他现网网关保持原状态，正式发行独立记录。
- 157 项跳过检查不计为通过；模拟器覆盖升级不代替实体设备长期验收。未新增真实模型调用，不重启已冻结评测。

## 最终合入与正式发行

用户于2026-10-13明确“可以的，发版吧”，并要求 Windows 一起提供实验版、不配置证书。最终发行提交 `53577ccebdc5bcade5a457261e9aa965b2630e8b`（PR#70）与候选 `ffd4f021da0a8c0819fe702703d4f9329bcea5f0` 同树；候选 / 主线跨平台、Web、Windows 原生和完整 CodeQL 通过，主线开放告警0。主线首次 Windows 既有 doctor 测试15秒超时，代码、断言及时限均未修改，同提交完整重跑通过；失败与重跑原记录保留在1.0.13实施记录与候选回执。

- `v1.0.14` 指向上述发行提交，旧tag未移动。[正式发行流水线38420874406](https://github.com/kkelly-offical/kkcode/actions/runs/38420874406)全部通过；Windows Node22矩阵4373项中4124通过、249跳过、0失败。跳过项不计为通过。
- npm latest已切换为1.0.14，Preview仍为1.0.6-preview.1。[GitHub Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.14)已提供原证书Android10021和未签名Windows x64实验版，以及源码、npm归档、SBOM、更新清单与哈希回执。
- npm归档由正式流水线重新构建、验证并发布；Windows来自同一发行源码的正式流水线新构建，已通过实际安装 / 网关 / 重装 / 卸载数据保留检查，签名状态为NotSigned。Android使用原候选APK，原证书与10020→10021升级 / 偏好保留不变。候选文件与候选回执完整保留，未把新Windows哈希冒称为旧候选哈希。
- 公开npm归档完整下载及registry完整性验证通过；最低Node22.12.0配合npm11.12.1的官方registry全新安装及公开tar缓存安装、SDK replay.gap默认失败、重试校验、SQLite与附件往返通过，无模型调用。Android和Windows匿名完整下载SHA-256核对通过，公开更新清单与APK大小 / 证书 / 哈希一致。

发行产物SHA-256：npm `1aef194f5288084f39fda291246a40d74fada52c8c6f261d2764d1212a3c1767`；APK `96611d8b13f82257d1da1e9706423a686a3335e82faa000579f3ae1af22c9966`；Windows `10789ed256b8c9a6b445f6fd1235601fe9b2793ca5249b258c9215da69cae28a`。正式回执与原始证据在 `/tmp/kkcode-114-stable/`，持久交付目录为 `test-results/1.0.14-release/`，公开事实入口为 [release-verification.json](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.14/release-verification.json)。

最低Node检查采用npm11.12.1；npm10.9联网及缓存安装在依赖解析阶段未完成，主动中止的原记录保留，不宣称通过或擅自确定原因。

本轮没有部署其他生产 / 演示网关、升级运行中的remote或新增真实模型调用；SDK深度扫描M11仍暂停，Apple应用、C04 / GitLab / 长期实际使用门禁仍未宣称完成。Windows安装器未配置Authenticode，按用户要求以实验版发行。
