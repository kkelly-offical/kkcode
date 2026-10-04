# 版本、升级与发行状态

[文档导航](README.md) · 更新：2026-10-04

## 当前版本

公开稳定版 **1.0.10 / Android10017**（npm latest），公开Preview **1.0.6-preview.1 / Android10012**。
1.0.10发行提交`da25fd1`（PR#46），与最终候选`303d0f4`同树。
候选与主线的跨平台／Web／CodeQL检查及正式发行流水线通过，Android沿用原证书。
源码版本、流水线启动都不等于已公开下载。本次已核对匿名npm／GitHub下载、CI包一致性、
最低Node22.12安装及原证书Android10016→10017覆盖升级；发布后本机remote因思考入口问题升级至1.0.10，后续本机补丁见[实施记录](implementation-1.0.10.md#发布后思考入口修复2026-10-04)。
精确哈希与验证范围见[正式版release-verification.json](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.10/release-verification.json)。
从未公开发行过1.1.6，旧源码标记仅用于历史追溯。

| 层次 | 版本 | 渠道与证据 |
| --- | --- | --- |
| 已发布稳定渠道 | **1.0.10 / Android10017** | npm latest；[稳定Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.10)；匿名下载、原证书与覆盖升级已核验 |
| 已发布预览渠道 | **1.0.6-preview.1 / Android10012** | npm preview；[原GitHub prerelease](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6-preview.1)保持 |
| 上一已核实稳定版 | 1.0.9 / Android10016 | [稳定1.0.9](release-1.0.9.md)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.9/release-verification.json) |
| 更早已核实稳定版 | 1.0.8 / Android10015 | [Pixel Studio稳定版](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.8)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.8/release-verification.json) |
| 更早已核实稳定版 | 1.0.7 / Android10014 | [稳定1.0.7](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.7)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.7/release-verification.json) |
| 更早已核实稳定版 | 1.0.6 / Android10013 | [稳定1.0.6](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.6/release-verification.json) |
| 上一已核实预览版 | 1.0.6-preview.0 / Android10011 | 原tag、包与[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.6-preview.0/release-verification.json)保持 |
| 更早稳定版 | 1.0.5 / Android10010 | [稳定1.0.5](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.5)；更早记录见[历史导航](history.md) |
| 历史预览 | 1.0.5-preview.0 / Android10009 | 原tag和APK保持 |

[发行范围](release-1.0.10.md) · [逐项实施与验证](implementation-1.0.10.md)

## CLI 升级

```sh
kkcode update --check
kkcode update --install --channel latest
# 明确选择预览渠道才使用：
kkcode update --install --channel preview
```

首次安装见[快速开始](getting-started.md)。固定安装公开稳定版可使用
`npm install -g @kkelly-offical/kkcode@1.0.10`；Preview仍为1.0.6-preview.1。
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

Android在个人资料的版本入口检查更新。1.0.10稳定APK可被稳定与Preview两种渠道接收；
下载校验后仍须Android系统确认安装。详见[App更新](android-app-updates.md)与[原证书签名流程](android-release.md)。
版本码10017高于10016与10012；隔离只读模拟器中的10016→10017覆盖升级、真实主页和非调试属性已核验。
这不代替实体设备长期验收。

CLI、网关/Web和Android分别部署。已有网关需升级其源码构建后才能使用新页面；
升级CLI或App不会自动替换网关。升级前备份私密状态和数据库，保留账号、OIDC、加密及签名身份。
**公共网关镜像发布暂缓**，本轮没有推送镜像或升级其他生产／演示网关。本机已按授权从`/root`在`tmux kkcode-coding`运行1.0.10 remote，保留all-folders、原设备身份与配置；未公开发行的本机补丁单独记录，不覆盖正式包。

## 验证边界

用户于2026-10-04授权直接发布1.0.10；PR#46沿用已授权的管理员合入流程，保护规则不变。
PR#34已按用户管理员合入授权集成，旧记录保持；不冒称批准审核。

- 跨平台、Web、CodeQL、Android、发行流水线与公开包安装验证通过，未新增真实模型调用。
- R12—R16保持关闭，原失败与unknown不改写；C04、GitLab和长期实际使用仍待后续验收。
- 已发布tag、npm版本和APK不可覆盖；后续公开APK继续递增版本码并沿用项目证书。
- 1.0.10正式版不代表1.1.0成熟度门禁已通过。

[能力边界](capabilities.md) · [当前Issues](https://github.com/kkelly-offical/kkcode/issues) · [历史证据](history.md)
