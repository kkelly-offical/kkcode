# Android 应用更新

[文档导航](README.md) · 适用源码：1.0.5；[当前发行渠道](versions.md)。
源码已为1.0.5预留版本码10010，但尚无该正式版公开APK。已发布预览版为
1.0.5-preview.0/10009，稳定版为1.0.4/10008，均沿用项目证书；发行与匿名下载
回执见[版本状态](versions.md)。正常同签名升级保留本机SSH凭据与网关账号，不需要卸载。

历史迁移注意：1.0.2 Fix使用技术版本 **1.0.3 / 10006**，沿用正式证书，可由已有1.0.1/1.0.2
稳定渠道更新器发现。发布标题与技术版本可以不同；不要把修复包命名成旧 App
不识别的 `1.0.2-fix.1`。实际发布状态见 [1.0.3 台账](implementation-1.0.3.md)。

## 用户怎么使用

打开左下角个人资料／设置，点击原位置的版本号，进入“应用更新”。这里可以手动
检查、选择稳定／预览渠道、查看版本说明、下载或取消，以及发起安装。首页不会
自动展开配置表单；前台自动检查最多每 12 小时一次，失败后至少间隔 30 分钟，
新版本仅给出短提示，进行中的聊天不受打断。

下载完成不等于安装完成。首次安装需要在 Android 系统设置中允许 KK Code
“安装未知应用”，返回后再次点击“安装更新”，最后在系统界面确认。系统覆盖
安装会关闭当前 App，重新打开即可；正常同签名升级保留连接、设置和加密凭据。
取消或失败可以重试，不需要卸载，不会为了更新而清空数据。

`1.0.1-preview.2` 及更早 APK **没有这个更新器**。请先从本项目 GitHub Release 手动
下载并覆盖安装同证书正式版，后续版本才能在 App 内检查安装。调试 APK 与正式证书
不同，不能覆盖升级；不要直接卸载含有重要配置的调试安装，应先准备迁移。

## 是否需要另部署服务器

不需要。当前固定读取 `kkelly-offical/kkcode` 的公开 GitHub Releases，随后从该
仓库对应 tag 的资产下载 APK。没有企业更新接口，也不要求在中继网关增加服务。
模型 API key、SSO cookie 和 Relay token 不会附带到 GitHub 更新请求中。

GitHub 无法访问、限流或返回不合规资产时，会明确报告检查失败或没有兼容发行版，
不会谎称“已经是最新版”。可稍后重试或手动下载官方 APK。更换更新仓库／证书
不是普通设置项；企业托管更新源和设备管理策略暂未实现。

稳定渠道只接受正式发行版；预览渠道也接受比预览版更新的稳定版。排序使用
Android `versionCode`，不做版本字符串的大小猜测；不支持回滚或降级。

## 发布方需要提供什么

每个 GitHub Release 同时上传：

- `kkcode-android-<版本>.apk`：非 debuggable、项目正式证书签名的 APK。
- `android-update.json`：由签名校验后的同一个 APK 生成的机器清单。

先运行项目签名脚本，再生成清单：

```sh
ANDROID_HOME=/path/to/android-sdk KKCODE_GRADLE=/path/to/gradle \
  node scripts/android-release.mjs
node scripts/android-update-manifest.mjs
```

产物分别位于 `android/app/build/outputs/apk/release/app-release.apk` 和
`test-results/android-update.json`。上传时把 APK 改为约定资产名，不能重新构建
或修改 APK 后继续使用旧清单。签名脚本及密钥保管见 [Android 签名](android-release.md)。

清单 schema 1 包含 applicationId、versionName、递增 versionCode、渠道、minSdk、
协议版本，以及 APK 的文件名、字节大小、SHA-256 与证书 SHA-256。
清单缺失的历史 Release 不会被作为 App 内升级候选。

## 校验与权限边界

- 更新请求使用独立无凭据客户端；仅 HTTPS，限制 GitHub 必需的重定向域名，
  绑定仓库、tag、资产名，拒绝跨仓库或任意下载 URL。
- 有 JSON 长度／嵌套深度、分页、超时、下载大小上限（256 MiB）；校验精确大小
  和 SHA-256，失败／取消删除本次不完整下载，避免累积无限缓存。
- 安装前再次核对 APK 本身的包名、版本、非调试属性、真实签名，要求签名同时
  匹配内置项目证书与当前已安装应用。清单不是签名验证的替代品。
- 通过 Android `PackageInstaller` 和系统用户确认安装；回调接收器不对外导出，
  绑定安装 session。没有静默安装、root 安装或绕过系统授权。
- GitHub 仓库是受信任的发布渠道；私钥仍应加密异地备份。当前不提供签名轮换、
  应用商店分发或企业强制升级。

验收分为更新策略／传输单元测试、Compose 状态交互测试，以及专用模拟器上的
同签名真实系统升级。最后一项使用仓库外的私有递增版本号 APK，绝不发布测试
升级产物；当时的实际结果见[1.0.1历史验收账本](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/stable-1.0.1-worklog.md)。
