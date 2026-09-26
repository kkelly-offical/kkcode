# OpenAI Responses API

[文档导航](README.md) · 适用源码：1.1.6；该适配器首次随1.0.4发行。

KK Code 有独立的 `openai-responses` 适配器，发送 `POST /responses`，不是把
Chat Completions 的 `messages` 换一个路径。CLI、内核 SDK、Web 和 Android 共用
被控电脑上的适配器；企业中继只转发设备协议，模型配置保存在设备上。
可信网关转发期间可见内容，不是零知识中继，见[部署边界](enterprise-deployment.md)。模型服务
是否实现 Responses 由供应商决定，不能因为提供 `/models` 就推断支持。

## 最短配置路径

Web/Android：模型渠道 → 添加渠道 → 选择 **OpenAI Responses**，填写 Base URL
与 API Key → 读取模型目录 → 选择返回的模型 → 保存。CLI 使用 `/provider add`
选择 Responses，再用 `/model refresh` 刷新。企业远控网关的登录地址不是模型 API。

只填 Base URL/Key 就能读取目录，不必先猜模型名；保存为默认模型时仍需选择目录项。
若供应商未实现模型目录，可显式配置它实际支持的模型，系统不会伪造一个列表。

用户配置 `~/.kkcode/config.yaml` 示例：

```yaml
provider:
  default: responses-service
  responses-service:
    type: openai-responses
    base_url: https://api.example.com/v1
    api_key_env: RESPONSES_API_KEY
    default_model: model-id-from-your-catalog
    max_tokens: 16384
    retry_attempts: 5
    stream: true
    # 仅在模型支持时启用；off 表示不请求可见思考摘要。
    # reasoning_effort: high
    # reasoning_summary: auto
```

API Key 通过环境变量或现有渠道设置提供，不应提交到 Git。官方 OpenAI 的 API 根地址
是 `https://api.openai.com/v1`；示例中的兼容地址需换成自己的服务。
`/v1` 和完整 `/v1/responses` 都可作为 Base URL，后者不会重复追加路径；模型目录
默认对应 `/v1/models`。自定义协议路径可用 `endpoints.responses`，目录另设
`endpoints.models`。例如一个服务同时提供三种协议：

```yaml
provider:
  default: company
  company:
    type: gateway
    protocol: responses       # openai | responses | anthropic
    base_url: https://models.example.com
    endpoints:
      openai: /v1
      responses: /v1
      anthropic: /anthropic/v1
      models: /v1/models
    api_key_env: COMPANY_MODEL_KEY
    default_model: model-id-from-your-catalog
```

这里的 `gateway` 是**模型服务渠道类型**，不等同于 KK Code 企业远控中继。
原有 `openai` / `openai-compatible` 渠道也可显式指定 `protocol: responses`；
不指定时仍走 Chat Completions，升级不会替用户静默换协议。推理不会在协议报错后
擅自改走其他渠道、重复执行或更换 API Key。

## 已支持的链路与边界

| 能力 | 当前适配行为 |
| --- | --- |
| 文本与图片输入 | `input_text` / `input_image`；图片继续走格式验证和模型能力检查 |
| 非流式 / SSE | JSON 结果、语义事件流，以及请求流式但服务返回 JSON 的兼容情况 |
| 工具调用 | 扁平 function schema；`call_id` 关联调用和结果；参数完整并收到完成标记才交给内核执行 |
| 可见思考 | 显示供应商返回的摘要/文本；生成中可展开，不解密或虚构私有推理 |
| 来源 | 将安全的 URL citation 转为可点击链接；不自动访问来源站点 |
| 用量 | 输入、输出、缓存读取和推理计数；上下文窗口区分估算与供应商实际用量 |
| 音视频、托管工具 | 本适配器未实现；不把不支持的内容冒充文本成功发送 |
| Background / WebSocket / 服务端会话 | 未实现；不创建托管对话或后台轮询任务 |

`max_tokens` 映射为 `max_output_tokens`；可见文本和推理都可能消耗预算。
不把其他协议的 `cache_control`、`stream_options`、`max_tokens` 原样塞进请求。
Function 工具显式使用 `strict: false`，保留现有可选参数契约；参数仍由 KK Code
执行前验证。权限、同模型敏感操作审查、工具审计和取消机制不被绕过。
未知的服务端托管工具调用明确失败，不作为本地成功执行的工具记录。

没有独立计数 API 时采用本地预算估算，绝不偷偷发起收费补全模拟 token 计数。
长工具结果用完整内容估算，不再用前 100 字符的缓存预览低估；图片参与预算。

## 续接、恢复与数据边界

- 每次请求 `store: false`，发送本地历史，不使用 `previous_response_id`。这不替代
  供应商自己的日志/保留政策，企业仍需按合同核验数据处理。
- 原生 reasoning 加密续接字段和 assistant `phase` 保存在设备私密会话历史。
  仅同 Base URL、同模型、同凭据且可见内容未改写时重放。改模型/渠道、回退改写、
  hook 修改工具参数后不会夹带旧加密状态；Web/App 会话投影不暴露该字段。
- 加密内容不是可读 thinking，不按密文字节数估算 token；尽量使用服务端推理计数。
- 临时网络/服务端错误在**首个可见输出之前**最多重连 5 次（共最多 6 次请求）。
  收到部分文本或思考后不自动重放；401、无效请求、取消不无意义地重试。
  缺少完成标记、截断的工具调用不执行，避免把半段参数变成真实操作。
- 连接、读流有超时及容量限制。API Key 不进入错误文案或审计正文；HTTPS、
  工作区信任、Host/Origin 与原有凭据保护照常生效。无认证本地 HTTP 服务可用
  `api_key_env: ""` 显式声明，带凭据的连接仍要求 HTTPS。

## 故障检查与验收口径

404：确认供应商支持 `/responses`，核对 API 根路径，而不是网页首页。
401/403：检查所选渠道的 Key/权限。目录成功但推理失败：目录存在不代表每个模型
支持 Responses、图片、工具或思考参数；可关闭 `reasoning_summary` 并选择支持的模型。
SSH 下的模型请求在 SSH 目标电脑执行，`localhost` 不是手机或网关。

回归包含真实本地 HTTP 服务、流式/非流式、完整内核工具循环与历史续接、交错工具、
错误参数、截断、重试/取消/超时、内容改写后隔离、跨协议和客户端投影。
这些是受控服务契约测试，不冒充已在你的 OpenAI/第三方生产账号上验证。
首次发行的测试和公开下载回执见[1.0.4历史账本](stable-1.0.4-worklog.md)；
新正式候选的状态另见[版本与升级](versions.md)。

实现依据：OpenAI 官方 [Responses 创建接口](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)、
[流式事件](https://developers.openai.com/api/docs/guides/streaming-responses)、
[Function calling](https://developers.openai.com/api/docs/guides/function-calling) 与
[Reasoning](https://developers.openai.com/api/docs/guides/reasoning)。兼容服务扩展字段
并不自动成为本适配器承诺支持的协议面。
