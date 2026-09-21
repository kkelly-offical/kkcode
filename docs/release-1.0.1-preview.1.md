# KK Code 1.0.1-preview.1

这是面向主动试用者的第二个预览版，不是 `1.0.1` 稳定版。npm 使用 `preview`
标签，GitHub Release 标为 prerelease；稳定 `latest` 保持 `1.0.0`。

如实记录：上一个预览版 `1.0.1-preview.0` 只发布了 GitHub prerelease，并未
真正推送到 npm；npm `preview` 标签此前仍指向历史版本 `0.2.4-preview.1`。
本次发布把 npm `preview` 标签首次移动到 1.0.1 预览线。

## 安装与试用

需要 Node.js 22.12.0 或更新版本：

```sh
npm install -g @kkelly-offical/kkcode@preview
# 固定本次不可变版本：
npm install -g @kkelly-offical/kkcode@1.0.1-preview.1
kkcode --version
kkcode -web
```

只想临时试用时可使用 `npx @kkelly-offical/kkcode@1.0.1-preview.1 -web`。
包内含 CLI、kernel/DeviceClient SDK、WebUI、网关进程入口和企业部署指导；
四个私有 workspace 不单独发布到 npm。

Android 签名 APK 从该版本的 GitHub prerelease 附件获取。应用 ID 为
`cn.kkcode.remote`，版本名 `1.0.1-preview.1`，版本码 `10002`（相对上一
个公开预览 `10001` 递增）。仅安装可信来源且证书指纹符合
[Android 签名说明](android-release.md) 的 APK。debug APK 与正式签名 APK
不能相互覆盖；如果卸载旧 debug 客户端，先备份其连接信息。

release APK 不信任仅安装到用户证书库的实验 CA；企业环境应使用正常有效证书，
或通过设备管理配置系统信任。不要关闭 TLS 校验。

## 本预览新增（相对 1.0.1-preview.0）

- 设备服务器与网关的标准 SSE 事件流：会话流可用 `after=`/Last-Event-ID
  重放，设备流为实时流；撤权/登出/解绑/登录过期即时关流。`events.list`
  轮询、设备 WebSocket、全部 RPC、请求去重与 headless JSONL 契约不变
  （`PROTOCOL_VERSION` 保持 `1`）。契约见
  [remote-sse-contract](remote-sse-contract.md)。
- 文件夹浏览宽容度：无 path 调用打开 home 根，响应携带 `parent` 供向上
  导航，不可读子项跳过而非整列失败；新增 `path_missing` /
  `folder_unreadable` / `not_directory` 错误码。凭证路径保护
  （`path_denied`）不变。见 [remote-folder-browsing](remote-folder-browsing.md)。
- WebUI 作曲家模型/模式/权限选择器（懒加载目录发现、auto/manual 来源标记），
  深浅双主题统一为一套 CSS 令牌；会话页优先 SSE，旧设备自动回退轮询。
- Android 客户端 SSE 流式会话、作曲家选择器与深浅主题。
- 受控终端状态模式：`kkcode remote` 绑定 SSO/网关后终端显示实时连接/会话
  状态面板，不再进入本地交互聊天。
- Agent 工作流/指令遵循/工具兼容性复核与修复（提示词矛盾与重复、插件
  agents 加载、skill 标志执行、MCP 工具 id 安全与防碰撞等），模型目录
  自动发现条目带 `origin: auto|manual` 来源标记，按 Session 路由与多并发
  加固。见
  [兼容性复核](agent-workflow-instruction-tools-compat-1.0.1.md)。

## 企业网关与 SSO

容器编排、SSO 示例和 HA 文件从同版本源码获取，不假设 npm 包包含完整构建工作区：

```sh
git clone --branch v1.0.1-preview.1 --depth 1 https://github.com/kkelly-offical/kkcode.git
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

本轮五个功能任务（M26–M30）各自经过独立 review（M26/M28 两轮、M30 三轮、
M27/M29 一轮，全部 clean 结论）后合并。合并后 `main` 全量 Node 套件 2,710 项
（2,709 通过、0 失败、1 项 macOS 平台跳过）；发布分支在版本号提升后重跑同一
套件结果相同。版本一致性、Web 构建与冒烟、Android 目标版本检查均通过。
详细记录见源码中的 `docs/implementation-1.0.1.md`。

已知边界：SSE 链路目前以进程内/回环 harness 验证，建议在依赖生产前对部署态
网关做一次联合验证；ZCode 对照仅基于其公开文档（闭源 harness 不可审计）。
此前预览版的四平台托管验收（Linux Node 22/24、Windows、macOS）与 Android
UI/JVM/真实网络检查结果仍然适用于其未改动的代码面。

已完成双网关进程故障转移、数据库连接恢复和两套数据库加密备份/隔离恢复；这不是
PostgreSQL 主从选举或异地灾备承诺。生产域名/证书、数据库自身 HA、真实企业租户、
异地备份、Android 实体机兼容与应用商店审核仍需部署方验收。

长期事件/去重/附件/历史预览都有容量限制，详见 [容量管理](device-retention.md)。
保留范围外的重试会明确报过期，不应重建 request ID 猜测执行结果。
新版 SDK/客户端会保留原始 request ID 与 issuedAt；混用旧客户端时不能假设其具备
相同的重试保障。MCP/Skills/插件的具体协议支持范围见
[兼容性说明](protocol-compatibility-1.0.1.md)，不包含所有第三方插件运行时或交互式 MCP OAuth 登录。

发布前另外审阅了 CodeQL 告警并补充边界回归。具体修复、误报判断和威胁前提见
[安全复核记录](security-review-1.0.1-preview.0.md)；扫描任务成功不代表不存在开放告警或未知漏洞。
