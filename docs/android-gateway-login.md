# Android 与企业网关登录回跳

适用补丁：**1.0.3（发布名称：KK Code 1.0.2 Fix）**。
Android 包名和签名不变，公开 `versionCode` 从 10005 增加到 10006。

## 用户看到的流程

`App → 系统浏览器标签页 → 企业 SSO → 网关确认连接 → 返回 App`

App 只填写企业网关地址。认证使用系统浏览器的 Custom Tab，保留浏览器的 SSO
登录状态，不把企业密码交给 App 的嵌入式 WebView。确认连接后，页面尝试打开
KK Code，并提供 **返回 KK Code App** 按钮。浏览器要求额外确认或拦截自动打开时，
点击该按钮或手动切回 App 都可以继续。无法保证所有浏览器均允许无点击跳转。

登录未结束时，App 的原有网关设置面板显示登录码、**重新打开浏览器**与
**取消登录**。首页仍为紧凑会话列表，不会为本次修复自动弹出大型配置表单。
登录等待期间网关地址锁定；换网关前先取消当前登录，避免两个组织的事务混用。

## 为什么需要两个回调层次

企业 IdP 的 OIDC 回调仍然是：

```text
https://你的网关/auth/callback
```

网关校验 IdP 的签名、issuer、audience、state、nonce 和 PKCE，完成账号认证与
用户确认后，再用固定地址唤回原生 App：

```text
cn.kkcode.remote://auth/complete?state=<本次登录的随机状态>
```

第二个地址仅用于唤醒 App，**不携带企业授权码、access token、refresh token、
device code 或 PKCE verifier**。不要把企业 IdP 的回调改成这个地址，也不要把
统一认证的 client secret 放进 APK。企业部署不需要额外架设 App 回跳服务器。

这是现有设备授权流程的原生回跳扩展，不是新实现了一整套通用 OAuth 授权服务器。
CLI/Web 继续使用原有设备授权／浏览器 Cookie 协议，协议版本仍为 1。

## 事务与安全边界

- `/api/v1/discovery` 的 `authentication.nativeLogin` 声明版本 1、Android 平台、
  固定回跳 URI 与 `S256`。App 仅在能力匹配时启用原生回跳。
- App 为每次登录生成独立的随机 state 与 verifier。`/auth/device` 的 `native`
  参数提交平台、state、`code_challenge` 和 `code_challenge_method: S256`。
  网关不接受调用方自定义的 return URL／redirect URI。
- 网关 `/auth/token` 验证原生事务的 `code_verifier` 后才换发凭据；错误 proof
  不消耗授权。原生 grant 不能通过 `browser: true` 绕过验证。
- Android 只接收指定 scheme、host、path，以及唯一的 state 参数；必须匹配
  本机尚未过期的待完成事务。外部链接不能指定网关、写入凭据或直接宣告登录成功。
- 回跳使用反向域名私有 scheme，以支持企业自定义网关域名。它不是经过域名
  验证的 HTTPS App Link；其他 App 即使声明同名 scheme，也无法仅凭回跳 state
  换取凭据。系统可能显示应用选择／打开确认。
- 待完成事务保存在 Android Keystore 加密的私有存储。获取凭据后，凭据保存与
  待完成事务删除一起提交。取消会清理本地事务，并尽力撤销网关 grant；网络
  不通时，远端未领取 grant 到期失效。取消后重放旧链接不会重新登录。
- 登录页面禁止缓存与嵌入；有表单的页面使用 `Referrer-Policy: same-origin`，
  防止 Chromium 把合法 POST 变为 `Origin: null`。最终回跳页使用 `no-referrer`
  和 nonce 脚本策略。不放宽网关的同源／CSRF 校验。

## 后台恢复、网络与旧网关

App 切到浏览器后仍轮询原事务。进程被系统回收，重新打开或收到回跳时会从加密
存储恢复；不会自动重新创建一笔授权。配置变化、重复点击、重复回跳不创建并行
轮询。已过期事务要求重新登录。
关闭“自动恢复远程连接”后，普通冷启动仍会保留已完成的组织登录态和设备列表，
但不会自动选择或连接电脑；主动发起／续接的登录仍完成该次连接流程。该选项
不等于退出 SSO。登录成功提示约 5 秒后自动隐去。

轮询遵守网关 interval；收到 `slow_down` 后将后续间隔增加 5 秒。网络异常以及
429/502/503/504 使用退避，首次失败后最多重试 5 次。暂时不可用时保留登录进度，
返回前台或点击继续可重试。拒绝授权、过期、proof 失败属于终止条件，不无限重试。
如果凭据交换响应在网络中丢失、网关已经消费一次性 grant，可能仍需重新登录，
不会用不受验证的回跳参数代替凭据交换。

新版 App 连接旧网关时保留设备授权轮询，明确提示授权后手动切回 App。**只升级
App 不会让旧网关出现回跳按钮**。旧 App 连接新版网关仍按旧协议工作。

## 部署与验收

从 `v1.0.3` 源码构建网关镜像：

```sh
docker build -f deploy/Dockerfile -t kkcode-gateway:1.0.3 .
```

沿用现有数据库卷、网关 origin、OIDC 配置和密钥，只更新网关/Web 容器。HA 部署
应先升级全部网关副本再开放新版原生回跳，避免登录过程切到旧副本。App 通过
GitHub 稳定渠道检查 1.0.3 并由用户确认覆盖安装；不要卸载已有 App。

验收必须包含真实 Android 浏览器，不只调用后台 token API：

```sh
npx playwright install android
ANDROID_HOME=/path/to/android-sdk KKCODE_ANDROID_SERIAL=emulator-5554 \
  NODE_EXTRA_CA_CERTS=/path/to/lab/ca.crt \
  node scripts/android-login-browser-smoke.mjs
```

该脚本严格限制在专用 `kkcode_101_api36` 实验模拟器、固定实验 SSO/网关上，
检查正常回跳、浏览器授权期间 App 进程被杀后的恢复，以及禁用自动脚本时的按钮
回跳。实验浏览器忽略自签证书仅为测试设置，不改变生产 App TLS 策略。
实际运行结果见 [1.0.3 验收账本](implementation-1.0.3.md)。

参考：[Android Deep Links](https://developer.android.com/training/app-links/create-deeplinks)、
[OAuth 原生应用规范](https://www.rfc-editor.org/rfc/rfc8252.html)、
[设备授权轮询规范](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.5)。
