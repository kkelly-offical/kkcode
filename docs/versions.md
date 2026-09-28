# 版本、升级与发行状态

[文档导航](README.md) · 版本安排核查：2026-09-28

## 本次正式版本：1.0.5

用户已将未公开的1.1.6源码标记纠正为 **1.0.5正式版**，并授权通过验收后发布。
这不是覆盖已发布版本，也不是将公开的1.1.6降级；从未公开发行过1.1.6。
根包、四个工作区、锁文件、CLI/Web和Android统一为1.0.5。

| 层次 | 版本／目标 | 渠道与身份 |
| --- | --- | --- |
| 当前源码与正式发行目标 | **1.0.5** | npm `latest`；Git标签 `v1.0.5`；GitHub非预发布 |
| Android正式发行目标 | **1.0.5 / 10010** | 原项目证书，`kkcode-android-1.0.5.apk` 配套 `android-update.json` |
| 上一已核实稳定版 | 1.0.4 / Android10008 | [历史发行回执](stable-1.0.4-worklog.md) |
| 已发布预览渠道 | 1.0.5-preview.0 / Android10009 | `preview`仍保留原预览，不覆盖原tag或APK |

源码版本、流水线启动都不等于已公开下载。实际发行是否完成，以
[1.0.5 Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.5)、
[npm](https://www.npmjs.com/package/@kkelly-offical/kkcode)及Release内的校验回执为准。
[发行说明](release-1.0.5.md)列出范围与已知边界。

## CLI 升级

```sh
kkcode update --check
kkcode update --install --channel latest
# 明确选择预览渠道才使用：
kkcode update --install --channel preview
```

首次安装见[快速开始](getting-started.md)。固定安装本次公开产物时可使用
`npm install -g @kkelly-offical/kkcode@1.0.5`；尚在发布中的候选不能当作可下载产物。
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

CLI、网关/Web、Android分别部署，升级其中一个不会自动替换另外两个。
升级前备份私密状态和数据库，保留账号、OIDC设置、加密及签名身份。
网关继续从源码构建；**公共网关镜像发布暂缓**，此次发行不自动推送镜像或升级生产环境。

## 验证边界

- 新发行候选需要自己的跨平台、Web、Android、打包与安全门禁，不能复用旧版本的成功状态。
- C04真实重连、完整修订版模型质量、GitLab实测与长期使用等仍在Issues中，旧失败成绩保留。
- 已发布tag、npm版本和APK不可覆盖；后续公开APK继续递增版本码并保留项目证书。
- 本次仅授权1.0.5正式发行。发布策略重新限制为1.0.x，拒绝旧的1.1.6标记及其他未经授权的大／中版本。
- 1.0.5不是1.1.0成熟度门禁已通过的证明；生产部署与新的模型调用仍需独立授权。

[已知边界](capabilities.md) · [当前Issues](https://github.com/kkelly-offical/kkcode/issues) · [历史证据](history.md)
