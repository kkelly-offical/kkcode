# MCP OAuth 与 ACP 编辑器入口

[文档导航](README.md) · 适用源码：1.1.6；表单及协议子集见[实际支持范围](protocol-extensions.md)。

## MCP OAuth

配置真实 HTTP/SSE MCP 服务后，在工作电脑上执行：

```sh
kkcode mcp auth --server company-tools
kkcode mcp logout --server company-tools
```

服务示例（地址需替换，不是默认预载服务）：

```yaml
mcp:
  servers:
    company-tools:
      transport: streamable-http
      url: https://mcp.example.com/mcp
```

CLI 打印授权链接，浏览器完成授权后回到本机随机回环端口。需要在控制该 CLI 的
电脑上打开浏览器；本版不声称提供 Web/App 内 MCP OAuth 回调代理。
远程无浏览器服务器应由管理员按其环境配置固定凭据或安排安全回环转发。

使用官方 MCP SDK 的资源/授权服务器发现和动态客户端注册流程、PKCE、
回调 state 与 issuer 校验，并持久化 SDK issuer stamp。HTTPS 是默认要求，
HTTP 只用于回环测试。已存储令牌可以自动刷新，不会在后台静默打开登录页。
项目来源 MCP 仍受工作区信任控制。

令牌、客户端信息与 verifier 保存在私密 `credentials/` 下，AES-256-GCM 加密，
不同服务器名/URL 分隔 namespace，文件 0600。主密钥也保存在同一 OS 账号私密目录；
这是本地加密存储，不是硬件密钥库，不能防止已控制该 OS 账号的攻击者。
备份必须同时保护密钥与密文；不要把 credentials 目录纳入 Git 或诊断日志。

`logout` 清除本机授权并断开已发现工具；**不等于远端授权服务器撤销同意**。
需要彻底撤销时还应到服务商/企业授权中心取消授权。
固定认证头、stdio MCP 和现有发现机制继续工作。

## ACP：编辑器的本地智能体入口

```sh
kkcode acp
# 工作区已核对后才使用：
kkcode acp --trust
```

编辑器配置命令为 `kkcode`，参数 `acp`，工作目录由 `session/new` 或
`session/load` 的绝对 cwd 提供。模型和渠道沿用该电脑的 KK Code 配置，
不会要求编辑器上传网关登录信息来运行本地智能体。

官方 `@agentclientprotocol/sdk` 的稳定 ACP v1 stdio；stdout 只传协议帧。
已实现 initialize、session/new/load/prompt/cancel/set_mode、流式文本/工具状态、
逐次权限确认、文本/图片输入与 editor-provided MCP。项目未信任时拒绝编辑器
要求启动的 MCP 服务。每连接最多 32 个会话，同一会话不接受并发回合。

边界：不宣称支持音频、所有 resource 类型、实验 v2、后台 ACP 会话管理、
IDE 未保存缓冲区代理或完整 model/config picker。表单仅在编辑器明确协商
`clientCapabilities.elicitation.form`后通过正式接口请求；旧端不被当成已确认。
具体限制见[表单与取消](protocol-extensions.md)。加载向编辑器重播最近200条文字消息（每条最多20k字符），
设备上的规范历史仍然完整保留。断开 ACP 连接会关闭此连接的内核；它不是 SSH
后台任务宿主，不能混用生命周期承诺。
