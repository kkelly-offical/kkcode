# 上下文、提示词与 Harness（1.0.4）

## 上下文数字的含义

当前请求预算 = 系统提示 + 工具 schema + 转换后的历史/媒体 + 输出预留。
原先只估算历史会低估大工具列表、项目规则和插件注入；现在这些都参与压缩判断。
窗口优先使用明确配置的 model_context / provider.context_limit，否则使用内置回退。
本地模型若目录没有准确窗口大小，应显式配置，不应把模型名字猜测当成权威上限。

空对话且尚无有效用量时不显示上下文条。工具结果使用完整内容估算，缓存只保存
内容指纹做一致性检查，不用截短的预览代替计数。Responses 的加密续接不按密文字节数
计算，使用可用的推理 token 用量；未调用独立计数 API 时仍明确标作估算。

Web/Android 显示当前上下文而非累计用量：

- `estimated`：本地启发式估算，图片等采用保守开销，不等同于计费。
- `count-api`：支持时使用模型服务端计数，系统与工具不再重复累加。
- `provider-usage`：最近响应输入及输出形成的已占用上下文。

组成项始终是用于诊断的估算，因此服务端总数可能不等于组成项之和。
下一轮加入新工具输出等后会重新计量。输出预留默认最多 16,384 tokens，
小窗口默认最多窗口四分之一；显式 max_tokens / max_output_tokens 会参与限制。
压缩不能解决超大的固定系统提示或工具声明；仍超窗口时明确报错，不丢弃用户内容
冒充发送成功。原有 CLI/headless `turn.usage.update` 结构不变，新数据在
`session.context.updated` 与 `sessions.get.context`。

## 提示内容与诊断

提示缓存归属单个内核，内容指纹覆盖 Agent 正文、Skill 描述、工具描述/schema、
模式/权限、项目上下文、用户规则及记忆。外部内容标记为参考来源，不成为更高优先级
系统指令。模型配置名不是知识截止时间证明；不要在模板里虚构训练日期。

```sh
kkcode prompt list
kkcode prompt show --type tool --name browser.txt
kkcode prompt inspect --session SESSION_ID
```

`inspect` 输出最后一次真实请求组装的块标签、来源、指纹、估算、广告工具名和预算；
不输出提示正文、工具参数或凭据。没有运行过新版本回合的旧会话会说明尚无记录。
诊断固定模板的位置不依赖当前工作目录。模板来源与运行时能力应保持一致，不能仅
靠抄一份更长的系统提示替代权限、恢复与协议实现。

## 按需工具与组合

`tool_search` 同时查找 MCP 和可选内置工具，并返回完整参数及详细手册。
基础上下文保留紧凑说明；可选 Browser、Web、Git、文件操作等按需激活。
`tool.discovery.enabled: false` 恢复完整声明面；执行期白名单、Skill 限制和审批不变。

`tool_batch` 接收 `calls: [{name,args}, ...]`，1–8 项串行执行：

- 子项逐一走原工具执行路径，并产生独立审计、工具日志和审批。
- 失败/拒绝/取消后不继续后续子项。
- 不允许嵌套 batch、委派、模式切换或 Skill 激活；无任意 JS/循环。
- 非事务，前面成功的更改不会自动回滚。后续参数依赖前面结果时请分开调用。

## 中断恢复与无进展

有副作用的工具执行前，在设备私密 `operations/SESSION_ID.json` 持久化操作元数据。
日志不保存原始参数/凭据；每会话保留最多 256 条已解决记录和 32 条未解决记录，
未解决记录不会被容量轮转悄悄删除。

执行过程中崩溃或异常无法证明结果时，同样参数的新尝试被拦截为
`tool_outcome_unknown`。先用只读工具或人工检查实际文件/远端状态，再由设备所有者：

```sh
kkcode session operations --id SESSION_ID
kkcode session operations --id SESSION_ID --resolve OPERATION_ID --confirm-inspected
```

确认只表示已经检查，既不验证结果，也不撤销或重新执行。仍在执行的操作不能确认。
这减少重复副作用，不宣称跨外部系统 exactly-once。客户端 RPC 的请求 ID 去重是
另一层保护，不能与工具结果恢复混为一谈。

普通回合检测 1–3 项的重复工具序列：同参数、同状态、同结果重复 3 次提醒换方法，
6 次暂停并保留已有工作。输出在变化的正常轮询不触发。Ultra 仍保留自己的阶段、
预算和目标门禁；停滞不是完成。

自动收尾只核对任务状态，不再隐式 `npx` / build / test / lint。需要执行的检查
必须通过常规工具及审批，最终报告要区分已验证、失败和未验证。

## 浏览器开发诊断

```json
{"action":"open","url":"http://127.0.0.1:5173","development":true,"websocketProtocol":"vite-hmr"}
```

`development` 是显式选择，默认 false；WebSocket 只允许当前明确打开的同源页面，
仍校验 DNS 固定地址、禁元数据/链路本地地址、字节和连接数上限。不自动跟随跨域
WebSocket 或升级为私人浏览器权限。非 Vite 服务可省略 websocketProtocol。
`viewport` 支持 320–2560 × 320–1600，`diagnostics` 返回有界控制台/网络状态；
不记录网络正文、请求头或 URL 查询参数。页面控制台本身仍是不可信内容。

## 可重复验收

`node scripts/harness-benchmark.mjs 300` 使用隔离状态、确定性模拟 provider 测
300 回合、提示/schema 大小与监听器泄漏。它不是推理质量、真实模型延迟或竞品排名。
真实 UI、OAuth、ACP、SSH 断线恢复分别有集成用例；实际结果见实施账本。
