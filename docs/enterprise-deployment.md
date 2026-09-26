# 企业自托管与多端连接

[文档导航](README.md) · 适用源码：1.0.5（正式版准备中，尚未发布）· [版本状态](versions.md)

部署方控制网关、身份认证和数据存储，工作电脑运行内核与工具。手机和网页是客户端，
不是另一个云端Agent。发布软件包不自动部署企业服务器，也不代表任意生产环境已验收。

## 各组件负责什么

```text
Web / Android ── HTTPS ── 企业网关 ── OIDC / PKCE ── 企业 SSO
                              │
                         WSS Relay
                              │
                      工作电脑 DeviceService
                              │
                 内核 / 模型 / 工作区 / 会话历史
```

| 组件 | 源码／配置 | 职责 |
| --- | --- | --- |
| 网关与Web | `apps/gateway/main.mjs`、`apps/web/`、`src/remote/` | 登录、组织／设备／共享权限、中继、网页入口 |
| 工作电脑 | `src/device/`、`src/kernel/` | 模型配置、工具执行、目录、会话与审批 |
| Android | `android/` | 原生Kotlin/Compose客户端；Relay及直接SSH |
| SDK／协议 | `src/sdk/`、`src/protocol/`、`packages/*` | 应用集成；公开导出随CLI npm包提供，工作区不是独立npm发行 |
| 部署编排 | `deploy/Dockerfile`、`deploy/compose.yaml`、`deploy/compose.ha.yaml` | 从源码构建网关/Web，连接PostgreSQL和企业IdP |

PostgreSQL、Keycloak／其他IdP和反向代理是独立服务，不是把其源码复制进KK Code。

## 信任与数据边界

- Web/Android配置网关地址，由网关引导SSO登录；工作电脑使用 `kkcode remote` 绑定。
- 设备主动建立中继连接，不要求给每台电脑直接开放公网服务。
- 对话、工作区和模型配置保存在工作电脑；网关默认不持久化对话正文。
- **企业网关是可信转发方，不是零知识中继。** 转发期间可见内容，包括远程保存配置时
  发送的密钥。不要把网关交给不信任的第三方。
- 设备／会话默认私有；组织管理员身份不自动授予读取所有会话或文件的权限。
- 显式分享可限制只读或控制；共享控制不等于可以修改模型／权限或建立永久放行规则。
- SSH仅Android直接连接，先核验主机指纹；网关只同步连接元数据，不接收SSH密码／私钥，
  Web不增加SSH代理。生命周期见[SSH设备](ssh-account-devices.md)。

## 部署准备与启动

选择经核对的源码提交或已公开版本；不要在1.0.5正式发行前假定已有 `v1.0.5` tag。
准备Docker/Compose、数据库持久卷、HTTPS反向代理、正式域名和企业OIDC客户端。
把配置放在仓库外的私密环境文件中，保留数据库密码和网关加密身份，不写入Git。

| 配置 | 用途 |
| --- | --- |
| `POSTGRES_PASSWORD` | Compose示例数据库密码；必须自行安全提供 |
| `DATABASE_URL` | 直接运行网关时的数据库连接；Compose示例按配置生成 |
| `KKCODE_GATEWAY_ORIGIN` | 浏览器和设备访问的唯一HTTPS origin |
| `KKCODE_OIDC_ISSUER` | OIDC issuer，不是任意OAuth2 token URL |
| `KKCODE_OIDC_CLIENT_ID` / `KKCODE_OIDC_CLIENT_SECRET` | 网关机密客户端 |
| `KKCODE_OIDC_SCOPES` | 登录scope，按企业IdP配置 |
| `KKCODE_OIDC_ROLES_CLAIM` | 已验证ID token的角色路径，默认 `realm_access.roles` |
| `KKCODE_OIDC_ADMIN_ROLE` | 组织管理员角色，默认 `kkcode-admin` |
| `KKCODE_ORGANIZATION` | 所属组织的显示名称 |

SSO回调登记为 `${KKCODE_GATEWAY_ORIGIN}/auth/callback`，使用Authorization Code + PKCE。
网关验证issuer、audience、签名、state和nonce；角色来自已验证ID token。
Android原生回跳需要匹配的网关能力，见[登录回跳](android-gateway-login.md)。

以下是部署者已完成配置并明确授权后的命令示例，不是本次文档维护执行的操作：

```sh
docker compose --env-file /secure/path/kkcode-gateway.env \
  -f deploy/compose.yaml up -d --build
```

Compose默认仅将网关18272绑定到127.0.0.1，应在前方配置HTTPS入口；数据库不直接公开。
如自行管理镜像，可在当前核对过的源码目录构建本地tag：

```sh
docker build -f deploy/Dockerfile -t kkcode-gateway:1.0.5 .
```

这里的1.0.5是本地构建名称，不是公共registry地址。**公共网关镜像发布暂缓**，
不要根据此命令推断存在官方 `docker pull` 入口。停止／升级服务时保留数据库卷和密钥。

## 绑定工作电脑

```sh
kkcode remote                # 前台运行；首次登录并询问普通目录范围
kkcode remote --home-only    # 明确限制home
kkcode remote --root /path/to/project
kkcode remote --all-folders  # 仅在明确同意所有普通目录时选择
kkcode remote status
```

终端退出或 `remote stop` 后停止该前台远控暴露；Android SSH任务宿主的后台排空
语义是另一条路径，不能混用。首次绑定会把该OS用户的本地历史归属到当前账号。
解绑／转移须先停止远控并明确确认设备与历史范围，见[设备生命周期](device-lifecycle-1.0.1.md)。

`--trust` 是项目配置／扩展信任，不是目录许可；目录同意也不会取消工具审批或私密路径保护。
请先使用专用OS账号／工作目录验证，具体浏览起点与保护路径见[目录授权](remote-folder-browsing.md)。

## 升级、恢复与实际验收

网关/Web、设备CLI和App分别升级；只升级APK不会让旧设备拥有新任务、记忆或地址簿接口。
升级前备份数据库与设备私密状态，核对账号、OIDC、加密密钥和原签名证书；不要删卷重建来“修复登录”。
Android从GitHub检查更新，不需要企业网关另建更新服务，详见[App更新](android-app-updates.md)。

PostgreSQL共享租约、连接fencing、多节点转发和隔离备份恢复已有工程实现与历史验收；
配置及演练范围见[HA与恢复](enterprise-ha-recovery.md)。这些记录不替代企业自己的数据库HA、
异地备份、证书管理、告警和租户验收。历史IdP覆盖不代表已登录任意Entra／Okta租户。

1.0.5正式版尚未发布；历史预览证据与本次准备状态见[版本与升级](versions.md)。
测试应在专用环境进行，不自动升级生产域名或示范VM，也不自动迁移签名私钥到CI。

过去的本机WireGuard／SSO实验地址仅是当时的验收配置，不是用户的默认服务。
需要复现实验时查[历史实验记录](https://github.com/kkelly-offical/kkcode/blob/v1.0.5-preview.0/docs/enterprise-lab-progress.md)，
不要复制其中的私密目录、账号或地址当作通用生产配置，不关闭TLS校验。
