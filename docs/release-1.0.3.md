# KK Code 1.0.2 Fix

技术版本 **1.0.3**，Android **10006**，使用现有正式签名。
发布状态与验收证据以 [实施账本](implementation-1.0.3.md) 为准。

本次只修复 Android／网关登录体验，不改变 1.0.2 的模式、会话操作、工具协议
或终端布局；CLI headless JSONL 契约保持不变。

- 网关识别新版 Android 登录，确认后尝试回到 App，并提供可点击的返回按钮，
  不再让这类登录只显示 Open WebUI。
- App 使用系统浏览器标签页；待完成登录加密保存，可在后台进程重建后恢复。
- 重复回跳不重复创建登录；支持取消、重新打开浏览器、网络退避和慢轮询处理。
- 新原生事务增加固定回跳地址、随机 state 和 S256 proof；令牌不进入回跳 URL。
- 保留旧 App／CLI／Web 登录兼容。新版 App 连接旧网关会提示手动返回与升级要求。

## 升级

1. 从本版源码构建并更新企业网关/Web 镜像，保留数据库、组织和 OIDC 配置。
2. Android 在个人资料的版本入口检查 GitHub 稳定版，下载后按系统提示覆盖安装。
3. 用真实手机完成一次 SSO → 确认 → App 返回；再测试取消及后台恢复。

已有 npm 1.0.2 与 Git 标签不可覆盖；旧 App 也不识别 `1.0.2-fix.1` 格式。因此
本修复经用户确认使用 1.0.3，GitHub 展示标题保留「KK Code 1.0.2 Fix」。
不需要卸载 App、不需要重新绑定被控电脑、不需要改变企业 SSO 的 callback URL。

网关构建：`docker build -f deploy/Dockerfile -t kkcode-gateway:1.0.3 .`。
CLI/npm 如需统一版本：`npm install -g @kkelly-offical/kkcode@1.0.3`。
GitHub 发布并不自动重启企业云服务器；公网部署由网关运维方单独完成。
详细流程、安全边界和兼容说明见 [Android 网关登录](android-gateway-login.md)。
