# 版本、升级与发行状态

[文档导航](README.md) · 最后核查：2026-09-26

## 源码版本与已发布版本是两回事

| 层次 | 版本 | 状态 |
| --- | --- | --- |
| 当前源码／维护目标 | **1.1.6** | **仅源码更新，尚未发布**；不创建tag、npm发行或公开APK |
| 已发布稳定渠道 | 1.0.4 | npm `latest` / GitHub stable；Android10008 |
| 已发布预览渠道 | 1.0.5-preview.0 | npm `preview` / GitHub prerelease；Android10009 |
| 下次Android正式版预留 | 1.1.6 / 10010 | 仅源码配置，沿用原证书；不是已签名或已上线证明 |

用户明确将本轮源码目标调整为1.1.6，替代此前1.0.5准备／1.0.6维护的版本安排，但不授权发布。
旧渠道和成熟度验收要求不变，待办不会自动完成。实际可下载版本以
[GitHub Releases](https://github.com/kkelly-offical/kkcode/releases)和npm为准；
本轮范围见[源码整合记录](implementation-1.1.6.md)。

## CLI 升级

```sh
kkcode update --check
kkcode update --install --channel latest
# 明确选择预览渠道才使用：
kkcode update --install --channel preview
```

首次安装见[快速开始](getting-started.md)。暂时不要使用 `@1.1.6` 作为已存在的
npm安装版本；如需本次准备版本，请运行经核对的源码。

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

Android 在个人资料的版本入口检查更新，Preview渠道才接收预发布。下载校验后仍须
Android系统确认安装，不提供静默安装。源码版本码10010预留给下一次正式发行，
不能据此声称已有新APK；详见[App更新](android-app-updates.md)与[签名流程](android-release.md)。

CLI、网关/Web、Android分别部署，升级其中一个不会自动替换另外两个。
升级前备份私密状态和数据库，保留账号、OIDC设置、加密及签名身份。
网关继续从源码构建；**公共网关镜像发布暂缓**，不存在本次自动推送镜像或生产升级。

## 发行与验证边界

- 已发布的1.0.5-preview.0通过了发行工程门禁和匿名下载校验，不能作为尚未发行1.1.6的最终回执。
- C04真实重连未覆盖，完整修订版模型评测、GitLab实测等仍待补齐；改版本号不关闭这些Issue。
- 已发布tag、npm版本和APK不可覆盖；后续公开APK递增版本码并保留项目证书。
- 本次维护不触发发布。正式发版仍须单独确认、冻结候选并执行对应门禁。
- 版本策略只增加精确的1.1.6源码例外；误推同名tag也会在发布元数据阶段拒绝。其他1.1.x／大版本不因此获准。

[已知边界](capabilities.md) · [当前Issues](https://github.com/kkelly-offical/kkcode/issues) ·
[历史发行证据](history.md)
