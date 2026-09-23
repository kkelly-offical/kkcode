# KK Code 企业自托管组件与实验部署（1.0.4）

本文面向 `1.0.4` 部署，版本发布本身不等于生产安全认证。
根包、网关/Web/SDK 工作区与 Android 版本名一致；APK 版本码为 `10008`。
实际发布/验收状态见 [本版说明](release-1.0.4.md) 与 [验收账本](stable-1.0.4-worklog.md)。

## 1.0.4 部署差异

沿用既有数据库、域名和 OIDC；无需新建另一套身份系统。
新增账号 SSH 地址簿 API `/api/v1/connections/ssh`，数据存于现有账号隔离 store，
不需要单独 SSH 服务、新监听端口或给网关配 SSH 私钥。**网关不代连 SSH，Web
本轮不提供 SSH；Android 直接连接工作电脑。** 多节点沿用 store 的原子修订检查。
网关/Web、设备 CLI 与 Android 都需更新才能启用所有新功能；只升级 APK 不会让
旧网关拥有新地址簿接口。OIDC/Android 回跳配置不因地址簿而改变。
SSH 生命周期详见 [账号设备指南](ssh-account-devices.md)。本机验收不自动更新
企业生产域名、OIDC 平台或已有示范虚拟机。
本次专项修复需要网关与 App 同步升级；SSO 的 `/auth/callback` 注册地址不变。
详见 [Android 回跳、后台恢复与兼容边界](android-gateway-login.md)。
Responses 是工作电脑上的模型适配，不是新增网关微服务；在设备模型渠道选择
协议和 Base URL 即可。网关/Web 本轮还修复 HTTP 错误封装与会话呈现，不能只更新 APK。

升级前备份 PostgreSQL 与设备本地状态，不重建组织/OIDC client、网关密钥或
Android 证书。先更新实验网关与一台设备，验证登录、会话流、模型目录、审批和
附件，再滚动更新其余设备。媒体协议与大小限制见 [媒体输入](media-input.md)；
新增设备级 MCP 摘要不包含 MCP stderr/命令，只对设备所有者发送。

## 配套服务属于哪个项目

组件都在本仓库中维护，但可以部署在不同机器、容器或网络区域，不要求企业把网关装在每台开发电脑上。

```text
kkcode/
├── apps/gateway/       网关进程入口
├── src/remote/         OIDC 身份、组织、共享权限、Relay 与数据库适配
├── src/device/         被控电脑服务：会话、目录、审批、控制权、配置
├── src/kernel/         Agent 执行内核
├── src/sdk/            对外内核 SDK 和浏览器安全的 DeviceClient
├── packages/sdk/      仓库内 SDK 工作区入口
├── packages/protocol/ 仓库内协议工作区入口
├── apps/web/          同一套本地／Host／Relay WebUI 源码
├── android/           原生 Kotlin / Compose 手机客户端（Relay + SSH）
└── deploy/            网关镜像、数据库／SSO 编排和本机实验编排
```

Keycloak、PostgreSQL、Caddy 是使用官方镜像独立部署的配套服务，源码没有复制进仓库。
现阶段可安装的公开 SDK 入口随 CLI npm 包提供：
`@kkelly-offical/kkcode/sdk`、`@kkelly-offical/kkcode/sdk/client` 和
`@kkelly-offical/kkcode/protocol`。`packages/*` 是私有工作区，不应误称已经分别发布到 npm。

## 运行边界

```text
Web / Android ── HTTPS ── 企业网关 ── OIDC / PKCE ── 企业 SSO
                              │
                       出站建立的 WSS Relay
                              │
                      电脑 DeviceService
                              │
                 内核 / 模型 / 本地文件 / 会话历史
```

- Web/Android 只需要配置网关地址，由网关引导到企业 SSO。
- `kkcode remote` 必须先登录；终端退出或 `remote stop` 后设备离线。
- 身份、设备归属、分享关系和不含正文的审计记录存入网关 PostgreSQL。
- 对话、工作区和模型配置保存在被控电脑，不在网关持久化。SSO 使用自己的数据库。
- 这里是“企业可信网关”，不是端到端加密的零知识中继。网关转发期间可见请求内容，
  也能看到用户远程保存配置时发送的密钥；不应将网关交给不信任的第三方。
- 设备／会话默认私有；管理员角色仅管理组织身份，不自动获得对话或文件读取权限。
- 分享可指定会话的只读或控制权限；共享控制不能改变模型／权限配置或创建永久放行规则。
- SSH 是另一条直连路线：先核验主机指纹，再在隧道内启动、配对本地 Web 服务。

## 本机已部署的入口

| 入口 | 地址 |
| --- | --- |
| SSO | `https://10.0.0.2:18471` |
| 网关 + WebUI | `https://10.0.0.2:18472` |
| 本机访问 | `https://127.0.0.1:18471` / `https://127.0.0.1:18472`，跳转到上述 WireGuard 地址 |

只绑定 localhost 和本机的 `10.0.0.2`，数据库没有发布宿主端口。
localhost 跳转用于保持统一 OIDC issuer/callback/cookie origin；访问者仍需能路由到
`10.0.0.2`。不要把它误解为一个脱离 WireGuard 地址仍独立工作的第二套 SSO 域名。

配置与随机生成的凭据位于 `/root/.local/share/kkcode-enterprise-lab/`：

- `credentials.json`：实验账户和管理凭据，0600。含 `kkcode-owner`、`kkcode-viewer`、
  `kkcode-administrator` 三个组织用户；Keycloak 管理入口的 bootstrap 用户是 `lab-admin`。
- `lab.env`：Compose 使用的私密环境文件，0600。
- `ca.crt`：可分发的实验 CA 公钥；不要分发同目录下的私钥。
- `public.json`：不含密码的服务地址和路径。

本机没有全局安装这个 CA。Node 调试使用
`NODE_EXTRA_CA_CERTS=/root/.local/share/kkcode-enterprise-lab/ca.crt`；浏览器需显式信任
该实验 CA。专用 Android 模拟器中安装了此 CA，debug APK 支持用户 CA，release APK
仍使用正常系统信任。生产部署应使用正式域名和有效证书／企业管理的受信任 CA，不能关闭 TLS 校验。

## 启动和停止

```sh
node scripts/setup-enterprise-lab.mjs
docker compose --env-file /root/.local/share/kkcode-enterprise-lab/lab.env \
  -f deploy/lab/compose.yaml up -d --build

# 在源码目录执行开发版；不会调用机器上可能仍为旧版的全局 kkcode。
NODE_EXTRA_CA_CERTS=/root/.local/share/kkcode-enterprise-lab/ca.crt \
  node src/index.mjs remote login --gateway https://10.0.0.2:18472
NODE_EXTRA_CA_CERTS=/root/.local/share/kkcode-enterprise-lab/ca.crt \
  node src/index.mjs remote --web
node src/index.mjs remote status
node src/index.mjs remote stop

# 仅停止实验容器，保留数据库卷。
docker compose --env-file /root/.local/share/kkcode-enterprise-lab/lab.env \
  -f deploy/lab/compose.yaml stop
```

首次绑定会把该 OS 用户的本地历史归属到当前账号，不能随意切换到另一个账号。
设备解绑／转移必须在本机停止远控后操作：`remote unbind --confirm <设备ID>`，或
`remote transfer --confirm <设备ID> --include-history --gateway <网关URL>`。
移交会让新账号获得保留历史、允许目录和模型配置的使用权限；旧分享和设备凭据失效。
具体恢复语义见 [设备生命周期说明](device-lifecycle-1.0.1.md)。
首次试用应使用专用 OS 用户或 `KKCODE_HOME`，并可添加 `--root` 限定工作目录。
交互启动先询问是否允许所有普通目录，拒绝或回车仅开放 home；非交互必须显式
传 `--home-only`、`--root <path>` 或 `--all-folders`。敏感凭据／系统私密路径
仍受保护，`remote status` 显示实际范围。`--trust` 只扩大当前工作区的扩展信任，
不代表目录授权，不要对陌生目录无意使用。见 [目录授权](remote-folder-browsing.md)。

## Web 镜像和 Android 升级

网关镜像内含 WebUI。使用本版源码执行
`docker build -f deploy/Dockerfile -t kkcode-gateway:1.0.4 .`，然后由部署方按自己的
Compose／编排配置滚动更新。不要删除数据库卷或重新生成 OIDC/网关密钥；CLI
与 Android 更新不会自动更新服务器镜像。仓库提供 Dockerfile，不宣称已经发布
公共 registry 镜像。

Android 从 1.0.1 开始可以直接检查 GitHub 更新，不需要企业网关新增升级服务。
旧预览 APK 先手动覆盖安装一次正式版，随后在个人资料版本号入口检查和安装；
每次安装仍需 Android 系统确认，详见 [应用更新](android-app-updates.md)。企业
更新源和强制升级策略暂缓，不会把网关登录凭据带到 GitHub。

## 接入企业已有 SSO

使用 `deploy/compose.yaml` 的网关和数据库，前置 HTTPS 反向代理，再配置：

| 配置 | 用途 |
| --- | --- |
| `KKCODE_GATEWAY_ORIGIN` | 浏览器和设备访问的唯一 HTTPS origin |
| `KKCODE_OIDC_ISSUER` | 企业 OIDC issuer（不是普通 OAuth2 token URL） |
| `KKCODE_OIDC_CLIENT_ID` / `KKCODE_OIDC_CLIENT_SECRET` | 网关的机密客户端 |
| `KKCODE_ORGANIZATION` | 部署所属组织显示名称 |
| `KKCODE_OIDC_ROLES_CLAIM` | ID token 角色数组路径，默认 `realm_access.roles`，可改为 `roles` 或 `groups` |
| `KKCODE_OIDC_ADMIN_ROLE` | 组织管理员角色值，默认 `kkcode-admin` |

SSO 注册回调 `${KKCODE_GATEWAY_ORIGIN}/auth/callback`，启用 Authorization Code + PKCE。
网关校验 issuer、audience、签名、state 和 nonce；角色必须来自已验证的 ID token。
既有验收覆盖 Keycloak 和 Dex，包含可配置 scope／claim、PKCE、JWKS 和浏览器会话。
历史 1.0.3 验收在 Keycloak 上复跑完整链路，并额外验证真实 Android Chrome 回跳与进程恢复。
其他企业 IdP 仍需使用其租户的真实客户端配置验收，不会假称已经登录 Entra／Okta 租户。

## 生产部署与验收边界

网关已支持 PostgreSQL 共享租约、连接 fencing 和节点间认证加密转发；
`deploy/compose.ha.yaml` 提供双副本示例，已完成实际进程崩溃和数据库连接中断验收。
两套数据库已完成加密备份、隔离恢复和数据校验。见
[高可用、SSO 与恢复说明](enterprise-ha-recovery.md)。

设备已实现解绑／显式移交、受限事件回放与请求去重存储、跨进程锁；前台／后台子代理
审批、命令一致性、附件和安全分支操作都有自动化及客户端验收。Android 正式签名密钥
已按授权生成在仓库外，正式 APK 完成签名和安装启动检查，见 [签名说明](android-release.md)。

这些实现不代替部署方的公网域名／证书、数据库自身 HA、异地备份及密钥托管。
签名私钥必须另行做加密异地备份，不能遗失，也不会自动上传到 CI。
Windows/macOS 的本版 CI 状态以 [实施账本](stable-1.0.4-worklog.md) 为准。
验收使用专用分支和隔离资源；npm/GitHub 的实际发布状态以版本账本为准。
没有发布到应用商店，也不会把本机签名密钥上传到 CI。
