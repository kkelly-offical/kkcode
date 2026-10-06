# 版本、升级与发行状态

[文档导航](README.md) · 更新：2026-10-06

## 当前版本

源码正在准备 **1.0.13 / Android10020** 发行候选，尚未公开发布；见 [1.0.13 实施记录](implementation-1.0.13.md)。

公开稳定版 **1.0.12 / Android10019 / Windows x64**（npm latest），公开 Preview **1.0.6-preview.1 / Android10012**。
1.0.12 发行提交 `00e573c`（PR#54），与最终候选 `caf7073` 同树。
候选与主线跨平台、Web、CodeQL、Windows 安装和正式发行流水线均已通过；Android 沿用原证书。
源码版本、流水线启动都不等于已公开下载。实际产物、哈希与验证范围以
[正式版 release-verification.json](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.12/release-verification.json) 为准。
最低 Node22.12 实际安装、Windows 安装／HTTPS 网关／重装／卸载数据保留、Android10018→10019 与浅色偏好保留均已核验。
从未公开发行过1.1.6，旧源码标记仅用于历史追溯。

| 层次 | 版本 | 渠道与证据 |
| --- | --- | --- |
| 已发布稳定渠道 | **1.0.12 / Android10019 / Windows x64** | npm latest；[稳定 Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.12)；[本轮回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.12/release-verification.json) |
| 已发布预览渠道 | **1.0.6-preview.1 / Android10012** | npm preview；[原GitHub prerelease](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6-preview.1)保持 |
| 上一已核实稳定版 | 1.0.11 / Android10018 | [稳定1.0.11](release-1.0.11.md)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.11/release-verification.json) |
| 更早已核实稳定版 | 1.0.10 / Android10017 | [稳定1.0.10](release-1.0.10.md)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.10/release-verification.json) |
| 更早已核实稳定版 | 1.0.9 / Android10016 | [稳定1.0.9](release-1.0.9.md)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.9/release-verification.json) |
| 更早已核实稳定版 | 1.0.8 / Android10015 | [Pixel Studio稳定版](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.8)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.8/release-verification.json) |
| 更早已核实稳定版 | 1.0.7 / Android10014 | [稳定1.0.7](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.7)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.7/release-verification.json) |
| 更早已核实稳定版 | 1.0.6 / Android10013 | [稳定1.0.6](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6)；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.6/release-verification.json) |
| 上一已核实预览版 | 1.0.6-preview.0 / Android10011 | 原tag、包与[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.6-preview.0/release-verification.json)保持 |
| 更早稳定版 | 1.0.5 / Android10010 | [稳定1.0.5](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.5)；更早记录见[历史导航](history.md) |
| 历史预览 | 1.0.5-preview.0 / Android10009 | 原tag和APK保持 |

[发行范围](release-1.0.12.md) · [逐项实施与验证](implementation-1.0.12.md)

## 独立 Web 显示补丁

**1.0.11-display.1** 已发布：[独立Release](https://github.com/kkelly-offical/kkcode/releases/tag/web-1.0.11-display.1) · [改动与检查](web-display-1.0.11.md) · [安装／回退](web-display-install.md)。
该历史补丁仅更新1.0.11的网页静态资源，没有改变当时的 npm 或 Android 渠道。1.0.12 已包含后续界面增强；旧补丁继续保留。
现网尚未部署，需取得实际部署位置后应用。

## CLI 升级

```sh
kkcode update --check
kkcode update --install --channel latest
# 明确选择预览渠道才使用：
kkcode update --install --channel preview
```

首次安装见[快速开始](getting-started.md)。固定安装公开稳定版可使用
`npm install -g @kkelly-offical/kkcode@1.0.12`；Preview仍为1.0.6-preview.1。
启动更新检查默认只通知，不自动改全局安装；缓存位于用户私密状态目录。

```yaml
update:
  enabled: true
  notify_on_startup: true
  auto_install: false
  channel: latest
  check_interval_hours: 12
```

## Windows 客户端

[下载 1.0.12 x64 安装器](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.12/kkcode-windows-1.0.12-x64-setup.exe) · [使用指南](windows-client.md)。
支持本机工作区、HTTPS 网关、原生项目选择、托盘和任务退出确认。随包 Node 与搜索工具均有来源和哈希记录。
本版安装器未配置 Authenticode 签名；同版本重装和卸载保留数据已经验证，不据此承诺未来跨版本升级。
macOS / iOS 应用暂缓。

## Android、设备与网关

Android在设置的“关于 KK Code”入口检查更新。1.0.12稳定APK可被稳定与Preview两种渠道接收；
下载校验后仍须Android系统确认安装。详见[App更新](android-app-updates.md)与[原证书签名流程](android-release.md)。
版本码10019高于10018与10012；专用发行模拟器中的10018→10019覆盖升级、安装时间与浅色偏好保留、真实主页和非调试属性已核验。
这不代替实体设备长期验收。

CLI、网关/Web和Android分别部署。已有网关需升级其源码构建后才能使用新页面；
升级CLI或App不会自动替换网关。子代理自动汇报需要新版remote；停止单个子代理需要新版网关。升级前备份私密状态和数据库，保留账号、OIDC、加密及签名身份。
**公共网关镜像发布暂缓**，本轮没有推送镜像或升级其他生产／演示网关。本机已按授权从`/root`在`tmux kkcode-coding`运行1.0.11 remote，保留all-folders、原设备身份与配置；切换前确认空闲并备份。

## 验证边界

用户授权完成设计复现、Android / Web 体验优化及 Windows 应用后发布1.0.12；PR#54沿用已授权的管理员合入流程，保护规则不变。
PR#34已按用户管理员合入授权集成，旧记录保持；不冒称批准审核。

- 跨平台、Web、CodeQL、Android、发行流水线与公开包安装验证通过，未新增真实模型调用。
- R12—R16保持关闭，原失败与unknown不改写；C04、GitLab和长期实际使用仍待后续验收。
- 已发布tag、npm版本和APK不可覆盖；后续公开APK继续递增版本码并沿用项目证书。
- 1.0.12正式版不代表1.1.0成熟度门禁已通过。

[能力边界](capabilities.md) · [当前Issues](https://github.com/kkelly-offical/kkcode/issues) · [历史证据](history.md)
