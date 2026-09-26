# 配置与模型渠道

[文档导航](README.md) · 适用源码：1.1.6；完整字段见[配置参考](config.example.yaml)

## 配置放在哪里

- 用户级：`~/.kkcode/config.yaml`。
- 项目级：`./kkcode.config.yaml` 或 `./.kkcode/config.yaml`；可以用 `kkcode init -y` 初始化。
- 项目控制的端点、凭据来源和可执行扩展需要工作区信任。先检查再授权，不把
  “能读取目录”当成“信任这个目录中的配置”。
- 优先通过环境变量／私密用户配置提供密钥；不要把真实凭据提交到Git或贴到Issue。

## 从 Base URL 发现模型

使用 `/provider`、`/model` 或客户端设置选择渠道与模型。KK Code优先读取服务返回
的模型目录，不在发现失败时静默代换成内置模型。

一个服务提供多种兼容协议时，可配置统一入口：

```yaml
provider:
  default: company-models
  company-models:
    type: gateway
    protocol: openai # 或 responses / anthropic
    base_url: https://models.example.com
    endpoints:
      openai: /v1
      responses: /v1
      anthropic: /anthropic/v1
      models: /v1/models
    api_key_env: KK_MODEL_API_KEY
    default_model: your-model-id
```

地址和模型ID是占位示例，替换为你有权使用的服务。这里的模型gateway不是企业远控
中继网关。HTTPS、同来源凭据限制、目录分页／缓存规则见[模型发现](gateway-model-discovery.md)。
带认证的普通连接不能靠关闭TLS检查来兼容本地HTTP；严格宿主的有界本地免费
授权是另一项能力，见[预算](durable-budgets.md)，不是全局关闭认证／预算的开关。

```sh
kkcode model list --provider company-models --refresh
kkcode model test --provider company-models --model your-model-id
```

`model test --probe` 才增加推理探测，可能计费，不要为“检查配置”默认执行它。
目录没有标准接口时可以显式填写 `models` 或模型ID；不要把未发现解释成该服务一定没有模型。

## 协议与模型职责

[Responses适配](responses-api.md)、[渠道发现](gateway-model-discovery.md)描述实际协议边界；
`configs/` 中模板是配置样例，不保证某个厂商的型号、价格或地区可用性永远不变。
具体模型以你的服务目录和当前账号权限为准。

不同职责默认沿用实际对话模型，可按[职责路由](model-roles-and-profiles.md)显式配置。
工具敏感操作的Auto审查与独立代码审查是不同流程；前者使用当前对话模型，失败或
不确定时转人工。模型配置不自动授予付费额度、网络来源或发布权限。

## 常用设置入口

| 设置 | 参考 |
| --- | --- |
| 模式、审批、项目信任 | [模式与权限](modes-and-permissions.md) |
| 原生／本地压缩、上下文计数 | [上下文](context-and-harness.md) |
| 项目经验、需确认的个人偏好 | [记忆](scoped-memory.md) |
| 网络目标与项目数据出域 | [数据策略](data-policy.md) |
| 严格任务费用、token和期限 | [持久预算](durable-budgets.md) |
| MCP、Skills和插件 | [协议扩展](protocol-extensions.md) · [插件](plugin-integrity.md) |
| 主题、提示、终端鼠标 | [CLI参考](cli-reference.md) · `ui`字段 |
| SSO、中继、目录授权 | [企业部署](enterprise-deployment.md) |

不要把多层配置的有效结果等同于某一个文件；检查错误提示、`/status`、审计和
对应SDK诊断。涉及私密状态、迁移、解绑或未知动作时，先备份并按专门流程操作。
