# KK Code 企业自托管组件与实验部署（1.0.1）

这是开发版的部署说明，不是生产安全或正式发布认证。所有版本仍为 `1.0.1`。

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
默认浏览范围是 OS 用户 home，敏感凭据路径仍受保护；`--trust` 会扩大当前工作区的扩展信任，
不要对陌生目录无意使用。

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
本轮真实验证了 Keycloak 和 Dex，包含可配置 scope／claim、PKCE、JWKS 和浏览器会话。
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
Windows/macOS 的最终 CI 状态以 [实施账本](implementation-1.0.1.md) 为准。
仅使用专用验收分支测试；没有发布 npm 包、GitHub Release 或应用商店版本。
