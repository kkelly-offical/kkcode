# 版本、升级与发行状态

[文档导航](README.md) · 源码状态更新：2026-10-02

## 当前版本

公开稳定版 **1.0.6 / Android10013**（npm latest），公开Preview **1.0.6-preview.1 / Android10012**。
CLI、四个工作区、Web和Android源码已进入1.0.7 / Android10014开发；尚未发布，公开渠道保持上述版本。
源码版本、流水线启动都不等于已公开下载。本次已核对官方npm与GitHub实际下载、CI包一致性、
产物哈希、同证书签名和10012→10013升级；精确提交、CI、SHA-256和限制见
[正式版release-verification.json](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.6/release-verification.json)。
从未公开发行过1.1.6，旧源码标记仅用于历史追溯。

| 层次 | 版本 | 渠道与证据 |
| --- | --- | --- |
| 已发布稳定渠道 | **1.0.6 / Android10013** | npm latest；[稳定Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6)；匿名下载、签名与升级已核验 |
| 开发中源码 | **1.0.7 / Android10014** | 八项智能体体验优化；[实施与验证](implementation-1.0.7.md)，尚未发行 |
| 已发布预览渠道 | **1.0.6-preview.1 / Android10012** | npm preview；[GitHub prerelease](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.6-preview.1)；匿名下载与原证书已核验 |
| 上一已核实预览版 | 1.0.6-preview.0 / Android10011 | 原tag、包与[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.6-preview.0/release-verification.json)保持 |
| 上一已核实稳定版 | 1.0.5 / Android10010 | [稳定1.0.5](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.5)；[更早1.0.4回执](stable-1.0.4-worklog.md) |
| 历史预览 | 1.0.5-preview.0 / Android10009 | 原tag和APK保持 |

[本轮正式版发行范围](release-1.0.6.md) · [实施与验证](implementation-1.0.6.md) · [原Preview实测](implementation-1.0.6-preview.1.md)

## CLI 升级

```sh
kkcode update --check
kkcode update --install --channel latest
# 明确选择预览渠道才使用：
kkcode update --install --channel preview
```

首次安装见[快速开始](getting-started.md)。固定安装公开稳定版可使用
`npm install -g @kkelly-offical/kkcode@1.0.6`；已发布Preview可选择
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

Android在个人资料的版本入口检查更新。1.0.6稳定APK可被稳定与Preview两种更新渠道接收；
下载校验后仍须Android系统确认安装，不提供静默安装。详见[App更新](android-app-updates.md)
与[签名流程](android-release.md)。版本码10013高于已发布Preview10012及稳定10010，证书不变。
已验证10012→10013覆盖升级和真实主页。原Preview10012的tag与APK保留，不覆盖旧产物。

CLI、网关/Web、Android分别部署，升级其中一个不会自动替换另外两个。
升级前备份私密状态和数据库，保留账号、OIDC设置、加密及签名身份。
网关继续从源码构建；**公共网关镜像发布暂缓**，本轮不推送镜像或升级生产环境。

## 验证边界

用户2026-10-02最新要求修复后发布1.0.6正式版，允许更新npm latest与GitHub稳定Release。本轮工程、安全、安装包及公开下载检查已完成；旧五场景失败保留，不把修复回归改写成整批模型通过。

- 新发行候选需要自己的跨平台、Web、Android、打包与安全门禁，不能复用旧版本的成功状态。
- C04真实重连、完整修订版模型质量、GitLab实测与长期使用等仍在Issues中，旧失败成绩保留。
- 已发布tag、npm版本和APK不可覆盖；后续公开APK继续递增版本码并保留项目证书。
- PR#34已按用户管理员合入授权集成；本轮PR#37使用同一有效授权。保护规则不变，没有冒称批准审核。发布策略保持1.0.x；旧的未发行1.1.6标记不复活，既有发行tag不移动。
- 1.0.6正式版命名不是1.1.0成熟度门禁已通过的证明；生产部署与新的模型调用仍需独立授权。

[已知边界](capabilities.md) · [当前Issues](https://github.com/kkelly-offical/kkcode/issues) · [历史证据](history.md)
