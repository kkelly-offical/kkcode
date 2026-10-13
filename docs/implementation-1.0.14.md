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
| 版本与文档入口 | 待最终复验 |
| 跨平台发行检查 / 覆盖率 / e2e / 打包 | 待最终复验 |
| Web 全部专项 | 待最终复验 |
| CodeQL 三种语言与完整告警核对 | 待最终复验 |
| Android JVM / UI / 原证书升级 | 待最终复验 |
| Windows 原生安装与退出 | 待最终复验 |
| 不可变 npm 包 / 最低 Node22.12 安装 | 待最终复验 |

候选源码在 `/tmp/kkcode-114/source`，日志与失败原证据在 `/tmp/kkcode-114/evidence/`。跳过项不计为通过，失败不改写为成功；最终产物、提交、哈希和检查结果将在候选完成时填写。
