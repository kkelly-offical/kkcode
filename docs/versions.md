# 版本、升级与发行状态

[文档导航](README.md) · 更新：2026-10-04

## 当前版本

公开稳定版 **1.0.7 / Android10014**（npm latest），公开Preview **1.0.6-preview.1 / Android10012**。
CLI、四个工作区、Web和Android源码目标为 **1.0.8 / Android10015**，即1.0.7的页面增强正式版候选，尚未公开发行。
用户已授权完成验证后正式发行（非Preview）；[增强范围](release-1.0.8.md)与[实施记录](implementation-1.0.8.md)。
以下1.0.7为当前公开版本。发行提交`a04bf10`（PR#40），与验收候选同树。
源码版本、流水线启动都不等于已公开下载。本次已核对官方npm与GitHub实际下载、CI包一致性、
原证书签名和10013→10014覆盖升级；精确提交、CI、SHA-256和限制见
[正式版release-verification.json](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.7/release-verification.json)。
从未公开发行过1.1.6，旧源码标记仅用于历史追溯。

| 层次 | 版本 | 渠道与证据 |
| --- | --- | --- |
| 已发布稳定渠道 | **1.0.7 / Android10014** | npm latest；[稳定Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.7)；匿名下载、签名与升级已核验 |
| 已发布预览渠道 | **1.0.6-preview.1 / Android10012** | npm preview；[GitHub prerelease](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6-preview.1)；原包、tag及签名保持 |
| 上一已核实稳定版 | 1.0.6 / Android10013 | [稳定1.0.6](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.6/release-verification.json) |
| 上一已核实预览版 | 1.0.6-preview.0 / Android10011 | 原tag、包与[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.6-preview.0/release-verification.json)保持 |
| 更早稳定版 | 1.0.5 / Android10010 | [稳定1.0.5](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.5)；更早记录见[历史导航](history.md) |
| 历史预览 | 1.0.5-preview.0 / Android10009 | 原tag和APK保持 |

[本轮正式版发行范围](release-1.0.7.md) · [实施与验证](implementation-1.0.7.md)

## CLI 升级

```sh
kkcode update --check
kkcode update --install --channel latest
# 明确选择预览渠道才使用：
kkcode update --install --channel preview
```

首次安装见[快速开始](getting-started.md)。固定安装公开稳定版可使用
`npm install -g @kkelly-offical/kkcode@1.0.7`；已发布Preview可选择
`npm install -g @kkelly-offical/kkcode@1.0.6-preview.1`，不会替换稳定渠道`latest`。
启动更新检查默认只通知，不自动改全局安装；缓存位于用户私密状态目录。

```yaml
update:
  enabled: true
  notify_on_startup: true
  auto_install: false
  channel: latest
  check_interval_hours: 12
```

## Android、设备与网关

Android在个人资料的版本入口检查更新。1.0.7稳定APK可被稳定与Preview两种更新渠道接收；
下载校验后仍须Android系统确认安装，不提供静默安装。详见[App更新](android-app-updates.md)
与[签名流程](android-release.md)。版本码10014高于稳定10013和Preview10012，证书不变。
已在隔离模拟器验证10013→10014覆盖升级、实际主页和非调试属性；这不代替实体设备长期验收。

CLI、网关/Web、Android分别部署，升级其中一个不会自动替换另外两个。
升级前备份私密状态和数据库，保留账号、OIDC设置、加密及签名身份。
网关继续从源码构建；**公共网关镜像发布暂缓**，本轮不推送镜像或升级生产环境。

## 验证边界

用户于2026-10-03授权发布1.0.7正式版，npm latest、GitHub稳定Release和原证书APK已发布并核验。
PR#34已按用户管理员合入授权集成；本轮PR#40沿用同一授权，保护规则不变，不冒称批准审核。

- 本版跨平台、Web、CodeQL、Android、发行流水线和公开包安装检查已完成；未新增真实模型调用。
- R12—R16保持关闭，原成绩与未知操作不改写；真实模型长期流畅度、C04、GitLab等仍需后续实测。
- 已发布tag、npm版本和APK不可覆盖；后续公开APK继续递增版本码并保留项目证书。
- 1.0.7正式版命名不代表1.1.0成熟度门禁已通过，生产部署与新模型调用不包含在本轮发行中。

[已知边界](capabilities.md) · [当前Issues](https://github.com/kkelly-offical/kkcode/issues) · [历史证据](history.md)
