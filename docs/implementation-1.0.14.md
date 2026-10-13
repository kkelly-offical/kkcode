# 1.0.14 候选实施与验收

用户要求直接完成优化并交付新的最终候选，由用户决定是否发布。目标 **1.0.14 / Android10021 / Windows x64**；当前公开稳定版仍为 1.0.13，未创建发行标签、发布 npm / GitHub Release 或部署网关。

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
- 所有产物准备完成后仍不创建发行标签或发布 npm / GitHub Release。公开 stable / Preview 与其他现网网关保持原状态，正式发布由用户决定。
- 157 项跳过检查不计为通过；模拟器覆盖升级不代替实体设备长期验收。未新增真实模型调用，不重启已冻结评测。
