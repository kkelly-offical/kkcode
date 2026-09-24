# 持久多代理任务图（1.0.5 Preview）

这是宿主控制面，不是让模型在 JSON 里声明一个权限等级。普通 `task`／`task_group` 的旧会话行为保持兼容；严格委托只接受真实 `TaskGraphHost` 能力，缺少它时明确拒绝，不回落为宿主子进程。

## 范围与执行语义

- 每个图 1–32 个逻辑节点、最多 8 路并发；依赖必须为 DAG。图级总预算包含全部节点预留预算，期限不超过七天，重启不延长。
- 默认节点是只读评审，仅可读取已允许的文件／产物。写入必须显式指定，并且父契约已经允许写整个独立副本。
- 每个子任务拥有独立 strict Docker 工作树，包括只读评审。内容来自父任务当前封存候选，包含已跟踪的脏改动和未忽略的新文件；不共享用户索引、凭据目录、未封存的依赖目录或运行环境。
- 子任务不能自行扩展父合同的工具、网络和外部操作。首版子任务不出网、不推送、不发布，也不能继续递归委派；不会把 `mode: yolo` 等模型参数当作授权。
- 子任务运行完是 `needs_review`，不是完成。宿主必须查看真实执行证据，并对准确候选和图版本确认，才能成为 `accepted`、允许依赖它的节点启动。
- 图级核准、每个子契约、敏感工具请求和结果确认相互独立。UI 可以把多个请求放在一张列表里，但一个 `allow` 不能扩展成所有子任务授权。

依赖表示执行顺序和核准前置条件，不代表自动把上游补丁合并到下游。所有节点绑定同一父候选。宿主将最小结果投影（回复、工具结果摘要、来源和候选哈希）保存到父任务可读的产物；已核准依赖再复制到下游任务自己的产物范围，并以不可信参考数据及 `artifact_read` 引用交付，不复制审批、凭据、provider state 或私密配置。补丁集成仍经过独立的受控交付／冲突检查；父候选改变后不能复用旧图的验收。

## 持久身份与恢复

SQLite 保存固定逻辑子任务 ID、实际 `childRunId`、会话、工作树、租约代次、费用和证据引用。创建意图先持久化，再准备工作树和执行模型。重复调用同一工具调用 ID 返回原图；参数变化则拒绝。

进程重启或宿主接管后，`recover()` 只查看原 child：旧 `preparing`／`running` 先成为未知结果，不重复创建工作树或重复执行。只有已经可靠保存的执行结束记录，才可恢复为待核准结果。没有记录、未知工具副作用、未知计费或候选变化，均保留阻断供人工检查。首版不自动重试失败子任务，也不假装可以安全续跑未落回执的调用。

取消会中止在途容器并等待收束；如果副作用结果不明，保留 `unknown`，不能显示成已经无事发生。工作树保留供核查，不自动删掉未交付成果。

## USD 预算

严格图缺省预算为零，表示未授权新的付费模型请求。实际产品使用用户明确配置的额度。

每个请求前按已配置 `context_limit`、最大输出上限以及对应渠道／模型完整 USD 单价，预留保守的最大费用；返回后按真实用量分账。多个节点预留额之和不能超过图总额。

此处故意不把本地 token 估算当作任意模型分词器的证明。上下文窗口过大时，预留可能偏保守，用户可以缩小窗口／输出上限或提高授权额度。缺少明确窗口、单价未知／过期，或者上次响应缺少可信用量时停止后续请求。该 scope 禁用底层自动重试，避免未知收费被重复请求放大；普通会话的既有重试机制不变。

本地计算不是供应商账单，供应商如果突破声明的 token 上限或返回错误用量，宿主会标记不确定并停止，不能承诺消除外部系统本身的计费错误。

## 宿主接入

```js
import { createTaskGraphHost } from '@kkelly-offical/kkcode/sdk/tasks'

const taskGraph = createTaskGraphHost({
  store, artifacts, actor, configState,
  image: 'sha256:已在本机验收的完整镜像摘要',
  authorize: request => showExactHostConfirmation(request)
})
```

把真实 `taskGraph` 传给 `createRunCoordinator`，并使用 `createDockerExecutionBackend({ image, delegationEnabled: true })`；父契约须明确允许 `task`／`task_group`。结果处理使用 `inspect` → 展示候选和证据 → `approveResult`，不能将审批回调暴露为模型工具。

Node SDK 提供 `propose / inspect / execute / recover / approveResult / cancel / close`。读取图不发模型请求；`approveResult` 使用当前图 revision 和 candidateHash 防止确认旧版本。图数据复用带迁移、写入代次和 SQLite CAS 的私密运行账本，不另建一套不受管的调度数据库。

## CLI

在 `runs start --contract` 的 JSON 中额外加入 `taskGraph`，并在父合同 `allowedTools` 明确加入 `task` 或 `task_group`：

```json
{
  "taskGraph": { "budgetUsd": 5, "deadlineAt": 1800000000000, "maxConcurrency": 2 }
}
```

这里仅展示新增字段，原来的 `contract`／`acceptance` 仍然必需；把示例期限替换成实际的未来绝对毫秒时间。总额度是父任务所有图累计预留的上限，不能通过创建新图重复扩额。默认不开启。

```sh
kkcode runs graph inspect RUN_ID
kkcode runs graph inspect RUN_ID GRAPH_ID --json
kkcode runs graph approve RUN_ID GRAPH_ID NODE_ID
kkcode runs graph execute RUN_ID GRAPH_ID
kkcode runs graph recover RUN_ID GRAPH_ID
kkcode runs graph cancel RUN_ID GRAPH_ID
```

有副作用的命令首次只打印当前 owner／图版本／候选／证据绑定的确认哈希。核对后原样加 `--confirm HASH`；不使用宽泛的 `--yes`。`approve` 每次只核准一个节点。`execute/recover` 先取得父任务执行锁并明确接管新的 owner epoch；有未知父操作时不能继续发模型。执行期间新的子契约和敏感动作仍分别在 TTY 询问；非交互终端不会自动同意。
