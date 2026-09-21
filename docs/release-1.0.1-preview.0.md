# KK Code 1.0.1-preview.0

这是面向主动试用者的预览版，不是 `1.0.1` 稳定版。npm 使用 `preview` 标签，
GitHub Release 标为 prerelease；稳定 `latest` 保持 `1.0.0`。

## 安装与试用

需要 Node.js 22.12.0 或更新版本：

```sh
npm install -g @kkelly-offical/kkcode@preview
# 固定本次不可变版本：
npm install -g @kkelly-offical/kkcode@1.0.1-preview.0
kkcode --version
kkcode -web
```

只想临时试用时可使用 `npx @kkelly-offical/kkcode@1.0.1-preview.0 -web`。
包内含 CLI、kernel/DeviceClient SDK、WebUI、网关进程入口和企业部署指导；
四个私有 workspace 不单独发布到 npm。

Android 签名 APK 从该版本的 GitHub prerelease 附件获取。应用 ID 为
`cn.kkcode.remote`，版本名 `1.0.1-preview.0`，版本码 `10001`。仅安装可信来源
且证书指纹符合 [Android 签名说明](android-release.md) 的 APK。debug APK 与正式
签名 APK 不能相互覆盖；如果卸载旧 debug 客户端，先备份其连接信息。

release APK 不信任仅安装到用户证书库的实验 CA；企业环境应使用正常有效证书，
或通过设备管理配置系统信任。不要关闭 TLS 校验。

## 企业网关与 SSO

容器编排、SSO 示例和 HA 文件从同版本源码获取，不假设 npm 包包含完整构建工作区：

```sh
git clone --branch v1.0.1-preview.0 --depth 1 https://github.com/kkelly-offical/kkcode.git
cd kkcode
```

随后按 [企业部署说明](enterprise-deployment.md) 配置 PostgreSQL、HTTPS origin、
OIDC issuer/client、回调和组织角色，再构建 `deploy/Dockerfile`。已有企业 OIDC
可以直接对接；Keycloak/Dex 已实测，但其他租户仍须验证其实际 claim 和回调配置。
Web/Android 只需填写网关地址，由网关导向 SSO 登录。

```sh
kkcode remote login --gateway https://your-gateway.example
kkcode remote
kkcode remote status
kkcode remote stop
```

Remote 是前台服务：退出终端就停止远程暴露。默认设备与会话私有，组织管理员不会
自动获得对话读取权限。企业网关是可信转发服务，不是端到端零知识系统；转发时可见
请求内容，但不持久化对话正文、附件和模型密钥。

## 升级、归属与回退

- 升级前先停止旧 CLI/Remote 进程，备份当前 OS 用户的 KK Code 配置与会话目录；首次试用推荐专用 OS 用户
  或单独 `KKCODE_HOME`，避免把日常历史直接绑定给实验账号。
- 首次 Remote 绑定会确定本地历史的账号归属。解绑/移交须在本机停止远控，输入
  精确设备 ID；账号移交需要 `--include-history`，新账号可使用保留历史、目录和
  模型配置。请先阅读 [设备生命周期](device-lifecycle-1.0.1.md)。
- 共享控制权不等于设备所有权；共享用户不能改模型密钥、权限配置或永久放行规则。
- 回退 CLI 可执行 `npm install -g @kkelly-offical/kkcode@latest`。稳定版不包含新增
  Web/Relay 功能；回退程序不等于逆向迁移数据，请保留升级前备份，不要期待旧版
  正确维护预览版新增状态。
- 若希望自动更新检查继续关注预览渠道，显式设置 `update.channel: preview`；
  预览版安装不会替用户修改个人更新配置。

## 验收与已知边界

此前功能验收为本机 2,600 项（2,599 通过、1 项平台跳过）以及四组真实托管系统
Linux Node 22/24、Windows、macOS 全部通过。Android 14 项 UI、14 项 JVM、3 项
真实网络检查通过；预发布版本另行经过版本一致性、签名安装和发布工作流验证。
详细平台跳过项及证据见源码中的 `docs/implementation-1.0.1.md`。

已完成双网关进程故障转移、数据库连接恢复和两套数据库加密备份/隔离恢复；这不是
PostgreSQL 主从选举或异地灾备承诺。生产域名/证书、数据库自身 HA、真实企业租户、
异地备份、Android 实体机兼容与应用商店审核仍需部署方验收。

长期事件/去重/附件/历史预览都有容量限制，详见 [容量管理](device-retention.md)。
保留范围外的重试会明确报过期，不应重建 request ID 猜测执行结果。
新版 SDK/客户端会保留原始 request ID 与 issuedAt；混用旧客户端时不能假设其具备
相同的重试保障。MCP/Skills/插件的具体协议支持范围见
[兼容性说明](protocol-compatibility-1.0.1.md)，不包含所有第三方插件运行时或交互式 MCP OAuth 登录。
