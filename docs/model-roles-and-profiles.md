# 职责模型与能力档案（1.0.5 Preview）

## 默认沿用实际会话模型

规划、实现、审查、压缩和标题默认使用当前会话选择的渠道和模型，不因为设置了 `models.fast`、修改了默认渠道或模型名字包含供应商前缀而静默切换。

需要明确分工时，配置：

```yaml
models:
  roles:
    planning: { provider: enterprise, model: planning-model }
    implementation: { provider: local-vllm, model: local-coding-model }
    review: { provider: enterprise, model: review-model }
    compaction: { provider: local-vllm, model: summary-model }
    title: null
```

`provider` 是已配置的渠道名称，不是协议名称；`provider` 与 `model` 都必须明确填写。此位置不能嵌入 URL、API Key 或自动降级模型。`null`／缺省表示沿用会话。

原有 `models.main/fast/subagent/ultra` 保持兼容。新职责解析器接收旧阶段模型时，优先级为：显式职责配置 → 显式旧阶段覆盖 → 当前会话；`fast` 仍只为明确依赖它的旧可选功能服务，不自动成为审查或标题模型。

## 权限与失败行为

- 跨渠道选择清除原会话临时 Base URL／凭据环境变量覆盖，使用新渠道自己的连接配置。
- 每次请求仍经过中央路由、工作区信任、凭据传输检查和项目出域策略。
- 未信任项目不能通过 `models.roles` 偷换到用户另外配置的渠道；先审阅并信任配置。
- 指定职责模型不可用或被出域策略拒绝时，不自动发送给其他模型。自动安全审查退回人工确认，标题保留原名，压缩保留原历史。
- Auto 审查的默认模型仍是会话模型；只有明确的 `models.roles.review` 才覆盖。审查结论不能覆盖硬权限或组织规则。

## 能力档案接口

```sh
kkcode model profile --provider enterprise --model MODEL_ID --json
kkcode model route review --provider current-channel --model CURRENT_MODEL --json
```

Node SDK 子路径：`@kkelly-offical/kkcode/sdk/models`。`profile`、`route` 与 SDK 对应方法都不会自动刷新目录或调用付费模型。

内核导出 `resolveProviderProfile(configState, providerName, modelId)`，这是只读操作：不会发现新模型、发送测试提示或产生推理费用。

档案包含协议、公开 endpoint origin、模型、作用域指纹、上下文／输出预算，以及每个能力值的来源：

- `configuration`：显式或当前有效配置；不是端点实测证明。
- `catalog`：该渠道目录缓存声明的能力。
- `inference`：模型名称等启发式推断。
- `unknown`：没有充分信息。
- `adapter`：KK 适配器的编码能力，不代表对面端点一定实现。

作用域指纹使用凭据相关 HMAC，绑定完整端点、协议、模型和凭据；不会公开路径、查询参数、API Key 或原始凭据。换端点、模型或凭据会得到不同作用域。数据来自当前配置与匹配缓存，不按模型同名跨渠道复用目录声明。

`compatibility.endpointTested` 当前明确为 `false`：受控 HTTP fixture 验证适配器代码，不等于用户配置的生产端点通过了真实推理验收。模型列表成功也不等于工具、媒体、原生压缩或推理状态全部兼容。没有授权预算时不会自动进行付费探测。

预算中的目录值和有效配置可能已经合并，因此同时保留可用的目录窗口值供对照；不能把估算或配置值宣传成实测上限。

## 宿主接入

`resolveTaskModel(configState, { role, providerType, model, baseUrl, apiKeyEnv, legacyModel })` 返回所选路由、来源和是否显式覆盖。规划／实施协调器应将返回的渠道、模型和覆盖参数整体传递给中央请求接口，不能只替换模型名字。

标题、客户端压缩、Ultra 阶段上下文摘要、Auto 审查和独立审查已经直接使用该解析器。普通受控任务选择 implementation；Ultra 的预览／蓝图／重规划选择 planning，实际编码／修复选择 implementation，每个阶段均以原会话路由为默认基线。临时阶段选择不会覆盖父会话保存的模型；子任务收到完整渠道参数。

实际请求用量由内部请求账本按 provider/model 分组，流式累计帧只更新同一请求，不重复计费；最终费用逐组计算后相加。异步标题按自身模型另行记账，嵌入回合内的客户端压缩不重复入账。

私密用量存储包含 `modelTotals` 分账；对外 headless JSONL 的原有 turn/session/global 用量对象结构不变。无上游用量或只能使用回退价格时，仍标记估算，不能将其当成供应商结算凭证。
