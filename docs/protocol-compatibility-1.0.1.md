# 1.0.1 协议与扩展兼容验收

本页矩阵及数字为历史验收。当前1.1.6源码的MCP OAuth、ACP及表单等子集见
[协议适配](protocol-adapters.md)和[实际支持范围](protocol-extensions.md)；
不要将下方旧版“不支持OAuth”等结论套用到当前版本，发行状态见[版本与升级](versions.md)。

本页记录实际支持、实际执行的验收，不把“发现了一个插件文件”写成“兼容该产品全部插件运行时”。测试不访问用户模型，不使用付费推理，不读取或打印用户密钥。

`1.0.1-preview.2` 补齐 M28 的工具按需发现、指令继承和兼容别名整合；
`user-invocable` 现覆盖用户/无头/远端入口，`allowed-tools` 为当前回合的
额外限制，取交集并传入委派任务，不能替代会话审批或为任意插件提供 OS 沙箱。
详见 [工具与技能契约](tool-discovery-and-skills.md)。目录加载、能力解析和
真实推理兼容是不同验收层级；不能用本页的 MCP 测试证明所有模型均支持媒体。

## 执行方式

```sh
npm ci
node scripts/compatibility-acceptance.mjs
```

官方服务端测试依赖锁定为开发依赖 `@modelcontextprotocol/server@2.0.0`，与产品使用的官方客户端/core 2.0.0 对齐；生产安装不需要服务端测试包。服务端工具、提示词、资源和协议处理均由官方 SDK 实现，测试代码仅负责本地 HTTP 请求适配和测试数据。

## 已执行的兼容矩阵

| 范围 | 实现与实际验收 | 边界 |
| --- | --- | --- |
| MCP stdio | 真实子进程、官方 SDK 服务端、标准换行 JSON-RPC、2024-11-05 初始化；工具/提示词/资源/模板列表、资源读取、Unicode、结构化输出、错误、取消、取消后的继续调用 | 保留 Content-Length 兼容回退；不会把 LSP 风格 framing 当作 MCP 默认 |
| MCP Streamable HTTP | 官方 SDK 自动协商 2026-07-28；也实测回退至 2025-11-25 的有状态 SSE/JSON 两种响应；后续请求携带会话信息 | 配置使用 `transport: streamable-http`；普通 `http` 仍指历史 KK Code REST 适配器 |
| MCP 分页与失败 | stdio 四类目录多页完整加载、重复游标拒绝、目录容量上限；已有崩溃重连、熔断、超时和错误分类回归 | 不承诺任意无限大小目录；可选能力缺失与坏分页不是同一种结果 |
| MCP 身份与传输 | HTTP 请求标识 KK Code；保留配置请求头；带凭据的非回环明文 HTTP 在连接前拒绝 | OAuth 交互登录/动态客户端注册不在本轮实现范围；服务的固定认证头仍需用户配置 |
| 工具端到端 | 官方 SDK 工具 → MCP Registry → Tool Registry → 审计执行器；合法可选/nullable 参数执行；非法参数在发出 MCP 调用前阻止 | 不自动把字符串转数字、不填默认值、不悄悄删除额外参数 |
| JSON Schema | Draft-07、2019-09、2020-12 声明按对应校验器处理；实测依赖字段、tuple 类型、额外字段约束 | MCP 未声明 dialect 时按 2020-12；旧本地/内置未声明 schema 保留 Draft-07 兼容；不承诺所有其他草案 |
| Agent Skills | `SKILL.md` YAML、名称/描述、license/compatibility/metadata、空格分隔 allowed-tools；`.agents/skills` 路径发现；激活时展开参数、读取辅助文件 | 系统提示目录只有名称/描述。发现阶段可缓存 Markdown 正文，但不会导入用户 `.mjs` 或把完整正文注入提示词 |
| 可编程技能 | 实测发现时不执行顶层 JS，明确调用后才导入并运行；不可信工作区来源被排除 | 技能声明不能绕过 KK Code 的执行权限；外部产品的权限语法不等于自动授权 |
| 可移植插件 | `.claude-plugin/plugin.json` 本地安装 → 发现 → 命名空间技能调用 → 禁用/启用 → 更新 → 失败更新保留旧版 → 可恢复移除 | 只声明已适配的 manifest/技能组件；不冒充 Claude/Codex/OpenCode 完整宿主运行时 |
| 插件供应链约束 | 禁止浮动 npm 版本、非完整 Git SHA、非法安装名称、符号链接；安装脚本不执行；更新不会重新启用禁用插件 | npm/Git 远程下载成功本身不等于第三方插件安全审计；本轮自动验收使用本地受控包 |

## 本轮验收发现并修复的问题

- stdio 缺少 `resources/read`，资源模板字段错误，目录只读取第一页。
- stdio 自动探测优先发送 Content-Length，给标准 MCP 子进程造成无意义的首次失败/等待；现优先标准换行 framing。
- 官方 SDK 返回 Draft-2020-12 工具 schema 时，原来的单一 Draft-07 校验器会阻止本来合法的真实工具调用。
- `allowed-tools` 只认识逗号，误把 Agent Skills 的空格分隔列表当成一个工具名。
- 可移植插件规范化安装至根目录后丢失默认技能目录；更新还可能意外重新启用已禁用插件。
- 官方 SDK HTTP 适配器未统一 KK Code 请求标识，现与其他 HTTP 适配器一致。

## 不应扩大的兼容声明

旧 SSE 与历史 REST 适配器有回归测试，但本轮官方 SDK 服务端联调覆盖的是 stdio 和 Streamable HTTP。客户端只声明实际具备的 MCP 能力；没有宣称支持服务端主动采样、交互 elicitation、所有 roots/订阅行为、所有 MCP Apps 或第三方插件专属 hooks/LSP/监控运行时。目录刷新仍遵循现有 TTL/显式 reload，不宣称任何外部改动都会立即热生效。可编程插件依赖模块的更新应重启会话，不能把 Node 模块缓存当成完全隔离的插件宿主。

参考规范：[MCP 官方 TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/)、[MCP 官方传输文档](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[Agent Skills 格式](https://agentskills.io/specification)、[Claude Code 插件结构](https://code.claude.com/docs/en/plugins-reference)。这些链接用于确定互操作边界，验收结论来自仓库内可重复运行的测试。
