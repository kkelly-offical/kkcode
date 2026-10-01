# 版本、升级与发行状态

[文档导航](README.md) · 源码状态更新：2026-10-01

## 当前准备版本：1.0.6-preview.1

本轮按用户确认先修复真实冒烟中的验证反馈，准备 **1.0.6-preview.1**。
根包、四个工作区、锁文件、CLI/Web和Android源码标记一致；Android预留版本码10012，
保留原项目证书。当前尚未发布新版本；上一轮 **1.0.6-preview.0/Android10011**
已经公开发行并完成匿名下载校验。**源码标记不是公开下载成功的回执**。
本轮不自动部署生产服务或推送网关镜像。
从未公开发行过1.1.6；此前源码标记修正的历史事实不变。
详细范围见[修复说明](release-1.0.6-preview.1.md)，实际验证见[实施记录](implementation-1.0.6-preview.1.md)。

| 层次 | 版本／目标 | 渠道与身份 |
| --- | --- | --- |
| 本轮准备目标 | **1.0.6-preview.1 / Android10012** | 未发布；需完成本轮门禁及发行批准 |
| 已发布预览渠道 | **1.0.6-preview.0 / Android10011** | npm `preview`；GitHub prerelease；匿名下载哈希及同证书APK已核实 |
| 已发布稳定渠道 | **1.0.5 / Android10010** | npm `latest`；Git标签 `v1.0.5`；原项目证书APK及更新清单 |
| 上一已核实稳定版 | 1.0.4 / Android10008 | [历史发行回执](stable-1.0.4-worklog.md) |
| 历史预览 | 1.0.5-preview.0 / Android10009 | 原tag和APK保留 |

源码版本、流水线启动都不等于已公开下载。稳定版公开入口为
[1.0.5 Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.5)、
[npm](https://www.npmjs.com/package/@kkelly-offical/kkcode)及Release内的校验回执；本页不把本轮源码标记当作新的公开下载验证。
[发行说明](release-1.0.5.md)列出范围与已知边界。
已发布Preview入口为[1.0.6-preview.0 Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6-preview.0)。
以其中`release-verification.json`、公开下载哈希及npm实际版本核实完成状态；发行前缺少这些
产物时不能认定发布成功。下一Preview尚未发行，不用准备状态替代公开核验。

## CLI 升级

```sh
kkcode update --check
kkcode update --install --channel latest
# 明确选择预览渠道才使用：
kkcode update --install --channel preview
```

首次安装见[快速开始](getting-started.md)。固定安装公开稳定版可使用
`npm install -g @kkelly-offical/kkcode@1.0.5`；已发布Preview可选择
`npm install -g @kkelly-offical/kkcode@1.0.6-preview.0`，不会替换稳定渠道`latest`。
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

Android在个人资料的版本入口检查更新。1.0.5稳定APK可被稳定与Preview两种更新渠道接收；
下载校验后仍须Android系统确认安装，不提供静默安装。详见[App更新](android-app-updates.md)
与[签名流程](android-release.md)。版本码10010高于已公开的10008／10009，证书不变。
10011是已发布Preview，10012预留给准备中的下一Preview；新APK必须完成同证书验签、安装及公开下载校验后才算发行。
App须选择Preview更新渠道才会接收该预览；稳定更新渠道不会被切换。

CLI、网关/Web、Android分别部署，升级其中一个不会自动替换另外两个。
升级前备份私密状态和数据库，保留账号、OIDC设置、加密及签名身份。
网关继续从源码构建；**公共网关镜像发布暂缓**，本轮不推送镜像或升级生产环境。

## 验证边界

- 新发行候选需要自己的跨平台、Web、Android、打包与安全门禁，不能复用旧版本的成功状态。
- C04真实重连、完整修订版模型质量、GitLab实测与长期使用等仍在Issues中，旧失败成绩保留。
- 已发布tag、npm版本和APK不可覆盖；后续公开APK继续递增版本码并保留项目证书。
- 本轮仅准备1.0.6-preview.1，尚无新的管理员例外或公开发行批准。发布策略保持1.0.x；旧的未发行1.1.6标记不复活，既有发行tag不移动。
- 1.0.5不是1.1.0成熟度门禁已通过的证明；生产部署与新的模型调用仍需独立授权。

[已知边界](capabilities.md) · [当前Issues](https://github.com/kkelly-offical/kkcode/issues) · [历史证据](history.md)
