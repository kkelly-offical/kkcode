# 企业网关高可用、SSO 适配与恢复验收（1.0.1）

## 已实现的网关 HA 边界

多个网关实例共享一个 PostgreSQL 数据库和同一个 public origin / OIDC 配置。
设备仍只向一个实例建立出站 WSS；浏览器、Android 和 SDK 请求可以落到任意实例，
不要求粘性会话。

数据库只保存在线路由的节点地址、连接 fencing ID 和到期时间，不保存 RPC 请求、
回复、对话正文、附件或模型密钥。节点之间通过独立私网 HTTP(S) 监听器即时转发，
每条消息采用 AES-256-GCM 认证加密、随机 nonce、60 秒时效和一次性重放检查。
即使内网使用 HTTP，正文也不会以明文经过节点间网络；仍建议限制为私网并用防火墙
只允许网关节点互通，不要发布 18274 到公网。

- 设备连接每 5 秒心跳；路由租约 15 秒，每 5 秒续租。
- 同一设备重连生成新的 fencing ID，旧节点不能继续接收新请求或删除新路由。
- 网关崩溃不会转移一个已经存在的 WebSocket；终端自动连接负载均衡器后重新注册。
- 中断期间可能返回 503。重试必须保留协议 request ID；被控电脑负责去重。
- 不能将“未收到响应”视为“工具没有执行”。跨节点转发不会擅自重新执行任务。
- 凭据撤销立即阻止后续 RPC；其他节点持有的连接最多在下一个心跳关闭。
- 所有节点应同步时间。数据库故障时续租失败，系统关闭过期路由而不是绕过鉴权。
- 单节点最多保留 256 个在途 RPC、每设备最多 64 个、请求正文合计最多 64 MiB；
  WS 发送缓冲超过 8 MiB 时返回 429 背压，避免离线／慢设备无限累积正文。
  跨节点转发也限制为 128 个在途请求和 64 MiB 正文，失效节点不会形成无限等待队列。

部署配置：

| 环境变量 | 含义 |
| --- | --- |
| `KKCODE_CLUSTER_ADDRESS` | 本节点可被其他网关访问的私网 origin，例如 `http://gateway-a:18274` |
| `KKCODE_CLUSTER_HOST` / `KKCODE_CLUSTER_PORT` | 私网监听地址与端口；默认端口 18274 |
| `KKCODE_CLUSTER_SECRET` | 所有节点共享的随机 32 字节十六进制密钥；必须放入 secret 管理或私密环境文件 |
| `KKCODE_CLUSTER_NODE_ID` | 节点唯一名称；省略时每次启动生成 UUID，不可让两个存活节点同名 |
| `KKCODE_TRUST_PROXY` | 可选的可信反向代理 IP/CIDR 列表，逗号分隔；默认不信任客户端伪造的 X-Forwarded-For |

`deploy/compose.ha.yaml` 是 `deploy/compose.yaml` 的可选叠加配置，包含两个网关和 Caddy
轮询／健康检查入口。设置 `KKCODE_GATEWAY_HOST` 为唯一 public origin 的 host（含非默认
端口），前置企业 HTTPS 代理转发到 `127.0.0.1:18275` 并保留 Host。不要把内部 HTTP
入口当作用户登录地址。该 Compose 示例让两副本网关运行在同一主机；需要主机级容灾时，
应将副本、入口和 PostgreSQL 放到相应独立故障域，数据库采用企业管理的 HA 部署。

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.ha.yaml up -d --build
```

这不是 PostgreSQL 自动主从选举实现，也不替代企业的 DNS／证书／负载均衡／数据库
监控和灾备策略。网关本身已支持多副本，数据库 HA 由 PostgreSQL 运维层提供。
健康检查会验证数据库可读性。无效 bearer token 按来源 IP 限流，不能通过不断更换随机
token 绕过限流；有效 token 按稳定登录会话限流。部署在企业代理后时，应精确配置可信
代理地址，不能无条件信任全网代理头。限流是单节点防护；公网入口还应配置集中限流／WAF。

## 企业 SSO 配置

除 Keycloak 的 `realm_access.roles` 外，支持 `KKCODE_OIDC_ROLES_CLAIM=groups` 或其他
ID token 数组路径，并以 `KKCODE_OIDC_ADMIN_ROLE` 指定管理员组。角色只取自已验证的
ID token，不信任浏览器传来的角色。`KKCODE_OIDC_SCOPES` 默认 `openid profile email`；
Dex 等需要显式 groups scope 的供应商可设为 `openid profile email groups`。

2026-09-21 已真实验收：

- Keycloak 26.6 + PostgreSQL：PKCE、JWKS、组织管理员映射、刷新轮换、登出。
- Dex 2.44.0 容器 + 独立 SQLite 身份库 + PostgreSQL 网关库：通过 WireGuard HTTPS
  完成密码登录、PKCE/JWKS、groups scope、浏览器 HttpOnly 会话交换、刷新和登出。
  Dex 静态测试用户不带管理员组，因此实际验证普通成员不被提升为管理员。
- 可配置 groups 管理员映射另有单元测试。没有声称已经登录真实 Entra ID / Okta 企业
  租户；此类租户还需管理员配置客户端、回调和角色声明。

参考 [Dex 的 scope 与 claim 文档](https://dexidp.io/docs/configuration/custom-scopes-claims-clients/)
和 [官方 v2.44 配置示例](https://github.com/dexidp/dex/blob/v2.44.0/examples/config-dev.yaml)。

## 备份、恢复与长期元数据

网关默认每分钟清理过期 access/refresh token、登录流、身份会话、路由租约和解绑回执。
解绑 tombstone 永久保留，防止旧设备 UUID 再次复活。审计只含操作、主体、资源 ID、
结果和时间，不含正文；默认保留 90 天且最多 100,000 条，可配置：

- `KKCODE_AUDIT_RETENTION_DAYS`：1–3650 天。
- `KKCODE_AUDIT_MAX_RECORDS`：100–10,000,000 条。

本机恢复演练使用 `scripts/lab-database-drill.mjs`：

1. 对网关和 Keycloak 两套数据库分别运行 PostgreSQL 17 `pg_dump --format=custom`。
2. AES-256-GCM 加密备份，0600 保存在实验目录 `backups/`，不提交 Git。
3. 校验解密后 SHA-256 与原始 dump 一致。
4. 每份备份恢复到新生成的隔离数据库，执行 `pg_restore --exit-on-error` 并校验关键表。
5. 仅删除本脚本明确创建的两个恢复验证数据库，保留加密备份，原数据库不改写。

实际结果：网关恢复 822 条元数据；Keycloak 恢复 4 个用户。该数字是当次快照，不是容量
指标。私密结果记录在实验目录 `backups/last-drill.json`。

生产应定时执行同样的 dump／加密／恢复演练，并按企业 RPO/RTO 选择 WAL 连续归档。
备份密钥与备份文件必须分开保管；本机实验将二者放在同一个 0700 私密目录，方便重复
调试，不能直接等同于异地密钥托管。恢复操作只能指向新数据库，验证后再由管理员安排切换。

## 可重复验收命令

```sh
node --test test/gateway-ha.test.mjs test/gateway-identity.test.mjs
node scripts/lab-ha-smoke.mjs
node scripts/lab-database-drill.mjs
NODE_EXTRA_CA_CERTS=/root/.local/share/kkcode-enterprise-lab/ca.crt \
  KKCODE_CHROMIUM=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  node scripts/lab-dex-smoke.mjs
```

HA 实测不是纯 mock：启动两个独立网关 Node 进程和真正 PostgreSQL 隔离库，执行跨节点
RPC，SIGKILL 承载设备的节点，再连接存活节点、重启另一节点、校验路由、跨节点刷新
single-use 和撤权，并确认数据库没有测试对话正文。还会只终止专用验收数据库的连接，
验证连接池能重新连接、网关不会因 idle connection error 崩溃。该验收的设备 WS 是受控协议端点，
用于精确故障注入；真实 CLI/Web/Android 链路由 `lab-enterprise-smoke.mjs` 另行验收。

Dex 测试临时使用 18481/18482，结束后关闭；HA 使用随机本机端口。不会停止或更改原有
18471/18472 实验服务。测试完成后只清理自己创建的容器／进程／数据库，私密诊断材料
仍保留在仓库外。测试不等于发布，不会推送、打 tag 或执行 npm publish。
