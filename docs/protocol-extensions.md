# MCP、ACP 与 Skills 的实际支持范围

[文档导航](README.md) · 适用源码：1.0.5；[发行状态](versions.md)。本页描述实际支持子集，不表示通过全部协议一致性认证。插件来源锁与升级审批由独立安装链负责；MCP服务声明不等于KK Code用户授权。

## MCP 连接与可用能力

| 连接配置 | 工具/结构化结果 | prompts/resources | 用户表单 |
| --- | --- | --- | --- |
| `streamable-http` | 官方 SDK v2；自动协商现代/旧协议 | 分页目录、读取、进度回调、取消 | 现代多轮 MRTR；旧协议由 SDK 适配 |
| `legacy-sse` | 官方 SDK v2 旧 SSE 传输 | 同上，受服务端实际能力限制 | 经 SDK 的旧协议请求 |
| `stdio` | 现有进程、熔断及 framing 兼容路径 | 分页目录、读取、进度回调、取消 | 2025 协议表单请求，兼容官方 v2 服务端适配 |
| 历史 `http` / `sse` | 保留旧 KK Code REST / 自写 SSE 兼容 | 保留原有子集；没有 reader 时明确不支持 | 不广告表单能力；不声称完整标准协议 |

现代 HTTP 使用官方 SDK 的 `versionNegotiation: auto`，让 SDK 处理 2026-07-28 的 `inputRequests`、`inputResponses` 和不透明 `requestState`，不是自行拼装多轮状态协议。旧 stdio 继续使用已验收的进程管理，不借升级偷偷改变 shell、重启或授权边界。标准来源：[SDK 迁移说明](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)。

`mcp_resource` 提供当前已连接服务的目录、模板与读取；`mcp_prompt` 提供提示词目录和取回。它们不安装服务、不接受凭据、不执行返回的提示词；返回内容标记为外部数据，仍经现有工具权限、Skill 工具限制与输出预算。资源 URI 是 MCP 标识符，不会在本地被解释为文件路径。接口依据：[资源规范](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)。

工具的 `outputSchema` 与 `annotations` 保留在注册信息中；annotations 仅是服务端声明，不能自动降低审批级别。结构化结果在注册表验证，不符合 schema 时明确报错。已发出的工具请求遇到服务崩溃，不因为错误码是 500 就自动重做；只有明确证明操作尚未开始才有资格重试，避免重复写入/提交。

目录读取保留游标循环检测和数量上限，官方 SDK 还对自动翻页设置自身页数上限。输出量很大仍走既有截断/产物归档流程，不绕开预算。

## 表单不是自动授权

一次 MCP 表单需要三个用户操作阶段：

1. 显示请求服务名和正在执行的操作；用户选择填写、拒绝或取消。
2. 填写字段。仅接受有界扁平 primitive/枚举表单，值由 JSON Schema 验证；不自动把默认值当答案。
3. 显示实际即将发送的内容，再由用户确认提交。

表单限制为最多 16 个字段、100 个枚举项、32 KiB schema；允许有界字符串/数字/布尔和简单字符串枚举数组。`pattern`、`$ref`、任意组合/嵌套 schema 与未知 format 在提问前拒绝，避免服务端正则拖住进程。暂不支持的复杂表单不会被悄悄解释成自由文本。旧 stdio 的服务端 `notifications/cancelled` 同样会取消其对应表单，而不仅是取消整个工具调用。

无宿主提问界面、未回答、表单无效、超时/取消，均不产生 `accept`。密码、API Key、令牌、私钥等敏感字段直接拒绝。这里不会读取设备身份、企业 SSO token 或模型配置来填表，也不会更改工具审批、工作区信任或文件访问范围。

同一服务的交互调用绑定当前 kernel/session 的提问通道并顺序执行；同一轮里的多个输入表单也顺序展示。取消排队调用不会让后续调用抢占前一个交互范围。等待用户纳入服务 `timeout_ms`，较慢的人工工作流需明确设置足够的超时；用户取消会传播至请求。

当前只广告 `elicitation.form`，不广告 URL 模式。URL 请求不会自动打开网页，不降级为收集 OAuth 密码的普通表单；第三方 OAuth 仍使用现有独立授权入口。本轮并未新增 URL 完成通知、模型 sampling、roots 自动共享或服务器自动授权。安全要求依据：[MCP elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)。

`onprogress` 回调支持工具、提示词及资源读取；内核 `mcp.progress` 仅发数值计数，避免把任意服务端文字写入遥测。没有新增 headless JSONL 顶层事件格式，也不承诺旧 Web/Android 界面会展示新的进度计数。

## 隔离的工具 Schema 校验

一般工具参数与 MCP 结构化输出不在主事件循环执行 Ajv。编译及校验进入专用 Worker：最多 2 个并发线程、64 个待处理任务；单次含排队最多 3 秒，超时或取消会终止真实线程，不使用同线程 `setTimeout` 假隔离。每线程设置 64 MiB 旧生代／16 MiB 新生代限制，Schema 上限 256 KiB、数据上限 2 MiB，并限制嵌套深度和节点数；不继承宿主环境变量或 Node 启动注入参数。额度不是远程可关闭的选项。

保留 Draft-07、2019-09、2020-12，以及普通 `pattern`、本地 `$ref`、`allOf` 等主流语义。过高复杂度、无效引用、超时、资源耗尽和 `$async` Schema 明确报错，不把失败当作校验通过；不会为了消除超时而静默丢弃约束。校验不会进行类型强转、默认值插入或删除多余字段，也不会为远程 `$ref` 访问网络。

项目使用的官方 MCP SDK v2 的业务输出校验接口是同步的。私有适配层通过正式 `jsonSchemaValidator` 注入点将同步编译／运行替换为有界结构登记，并在发送调用前、返回调用结果前分别执行上述真实 Worker 校验；SDK peer 不对外暴露。调用时固定本次工具定义，SDK 不会因刷新描述而在背后重发同一工具。非 SDK 传输由注册表执行相同校验，受控重连后的返回结果也必须校验。

参数未通过时不会发送工具调用；输出不合规或校验超时时，原操作可能已经完成，错误会明确提示不自动重试。`structuredContent` 为合法的 `false`、`0`、`null` 等 JSON 值时不会误判为缺失。`validateToolArguments` 是内部异步 API；所有使用方必须 `await`，不能用同步 `assert.throws` 或把 Promise 当成通过结果。

`test/schema-validation-isolation.test.mjs` 使用真实官方 MCP HTTP fixture 返回灾难性回溯正则，验证主线程心跳持续、参数阻断发生在副作用之前、输出超时后调用计数仍为一次，以及校验线程被终止后正常请求仍可继续。

## ACP 编辑器交互

现有 ACP stdio 保留会话创建/恢复、模式切换、文本/图片、工具授权和取消。现在编辑器明确广告 `clientCapabilities.elicitation.form` 后，内核问题可通过正式 `elicitation/create` 交给用户，绑定当前 ACP 连接、会话及活动回合；接受值重新验证，拒绝/取消不会被当成确认。

与 MCP 不同，ACP 的 `elicitation: {}` **不代表**支持 form。旧编辑器收到中文说明并安全取消本次提问，不假装已经获得答案。此项使用项目已安装的 ACP SDK，而非自定义 `_` 私有协议。当前未接编辑器文件代理/终端代理、URL elicitation、音频或 embedded context，也不会广告这些能力。依据：[ACP v1 elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)、[ACP 概览](https://agentclientprotocol.com/protocol/v1/overview)。

## Skill 元数据诊断

已有 `allowed-tools`、`disable-model-invocation`、`user-invocable`、`context: fork` 等行为保持。诊断进一步区分：

- 未知字段：`skill_unsupported_field`，说明字段未生效，不输出字段值。
- `agent`：仅元数据，暂不自动切换子代理；`effort` 仅作模板变量，不修改模型推理预算。
- `shell`、内联 `hooks`：不执行；动态命令仍走宿主白名单，插件 hooks 仍受插件信任链控制。
- `paths`：仅元数据，不自动匹配或授予路径权限。
- YAML 错误、缺少 frontmatter 结束符、错误布尔类型或坏的 `allowed-tools`：`skill_invalid_frontmatter`，不加载该技能，不能把损坏限制忽略后作为无限制技能继续执行。

可由 `kernel.extensions.skills.diagnostics()` / 现有兼容诊断命令查看。非法技能留在磁盘，不静默删除文件。

## 验收与边界

本机测试只使用受控官方 SDK fixture，不登录生产 SSO、不安装陌生插件。核心命令：

```sh
node --test test/mcp-*.test.mjs test/skill-*.test.mjs test/acp*.test.mjs
npm run typecheck
```

新增回归覆盖：三种实际传输的两轮表单；先收到进度再取消；提示词/资源取消后继续调用；并发会话回答隔离；并行输入表单顺序呈现；无用户/拒绝/敏感字段/URL 未支持；错误结构化结果与未知副作用不重发；ACP 显式能力协商与提交验证；Skill 安全字段损坏。官方 fixture 的取消信号使用 SDK v2 的 `ctx.mcpReq.signal`，防止原先字段误用导致“因为 TypeError 而误判取消成功”。
