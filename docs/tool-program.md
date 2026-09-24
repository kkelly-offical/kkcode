# 受限工具组合（实验）

`tool_program` 把少量相互依赖的工具操作放进一次有界组合：读取前一步的文本结果、解析 JSON、筛选，再决定下一步调用。它不是任意 JavaScript 执行器，也不是一个操作系统沙箱。

默认关闭。由用户在可信配置中启用：

```json
{
  "tool": {
    "program": {
      "enabled": true,
      "limits": {
        "max_steps": 2000,
        "max_calls": 8,
        "max_value_bytes": 262144,
        "max_total_bytes": 1048576,
        "timeout_ms": 60000
      }
    }
  }
}
```

配置不会赋予额外权限。工具自身仍需出现在当前工具目录与 Agent 允许列表中；只读任务不能借助组合写文件。严格任务中的每个叶工具仍交由严格执行后端处理。没有受控叶工具桥接的宿主会拒绝执行，而不会调用任意宿主函数。

## 支持的语法

模型只提供 `code` 字符串，最多 16 KiB。解释器先验证整段 AST；出现不支持的语法时，不会执行此前写在代码中的工具调用。

- 简单名称的 `const` / `let`、普通 JSON 对象、数组、标量、自有属性读取。
- `if`、条件表达式、有限数字运算、严格相等比较、逻辑表达式。
- `for (const item of array)` / `for (let item of array)`，单个数组最多 128 项，支持 `break` / `continue`。
- `return`、`emit(value)`、`await tools.call("工具名", 参数对象)`。
- `JSON.parse` / `JSON.stringify`，`Object.keys` / `values` / `entries`。
- 字符串 `slice`、`includes`、`startsWith`、`endsWith`、`split`、`trim`、大小写转换；数组 `slice`、`includes`、仅含标量的 `join`。

不支持函数、回调、类、解构、展开、正则、BigInt、对象属性修改、`while`、普通 `for`、动态导入、`eval`、`vm`、宿主全局、文件系统、环境变量、网络 API 或 Promise。原型、构造器、getter 与可执行转换属性全部禁止。工具调用本身的网络／文件权限仍由原工具管理，不能绕过该边界。

```js
const response = await tools.call("read", { path: "tasks.json" });
const tasks = JSON.parse(response.output);
for (const item of tasks.items.slice(0, 3)) {
  if (item.enabled) {
    const result = await tools.call("read", { path: item.path });
    emit({ path: item.path, text: result.output.trim() });
  }
}
```

叶工具只返回 `{ name, status, output }` 这三个字段，`output` 为文本。解释器看不到授权对象、宿主私密 metadata、回调或媒体二进制数据。只有工具明确返回 JSON 文本时才使用 `JSON.parse`；不要假设任意工具输出都是 JSON。

## 权限、意图与部分完成

每次 `tools.call` 都重新进入同一个真实工具循环，独立经过参数 schema、模式、能力／工具允许列表、Skill 策略、写入范围、审批、审计，以及已启用的持久化 Run 意图记录。稳定叶调用 ID 从父工具调用 ID 和序号生成，不会借一个外层审批批准全部后续行为。

禁止嵌套 `tool_program` / `tool_batch`，也不能在组合内委派子任务、加载 Skill、切换模式或启动后台工具。组合是顺序执行，不是并行调度器。

任一叶工具被拒绝、失败、取消或结果未知，后续操作立即停止。先前已完成的编辑不会自动回滚；超时或断开不能证明在途外部写入没有发生。结果包含已经观察到的 `calls`、累计 `steps` / `bytes`、`atomic: false`，必要时标记 `outcomeUnknown: true`。应检查持久化意图和真实状态，不要整段重试。

运行时错误可能发生在前面的叶工具完成之后。例如，读取的数据包含被禁止的属性，或输出超过配额时，已执行动作仍保留在部分结果中。静态语法失败与运行时部分完成不能混为一谈。

## 资源限制

| 配额 | 默认 | 宿主允许的最大值 |
| --- | ---: | ---: |
| 解释器步数 | 2,000 | 10,000 |
| 叶工具调用 | 8 | 16 |
| 单个值 | 256 KiB | 512 KiB |
| 累计数据（含中间副本） | 1 MiB | 4 MiB |
| 总时间 | 60 秒 | 120 秒 |

此外限制 AST 深度／节点数、纯数据深度／节点数，并在大字符串拼接分配前检查字节额度。宿主可以调整配额，模型不能在源码里关闭它们。大文件应通过单独的分页、检索或制品读取工具访问。

## 已验证范围与后续治理

`test/tool-program.test.mjs` 检查语法、安全属性、资源限制、部分完成和取消；`test/tool-program-loop.test.mjs` 使用真实内核循环验证独立审批、工具允许列表、只读范围和每叶持久化意图。设置 `KKCODE_STRICT_TEST_IMAGE` 为本机已有的不可变镜像摘要时，后者还运行真实 Docker 组合：外层解释器不会与串行叶执行器自锁，写入／读取分别产生严格容器执行回执；未设置时明确跳过此项，不能算作隔离验收通过。

这项功能不替代子代理调度。设备服务已有按父会话聚合的子代理审批和控制者租约检查；旧 stage scheduler 的文件所有权锁仍属于内存调度，不等同于持久化、独立严格工作树的多写者租约。并行写子任务应分别拥有严格工作树、RunRecord 和 owner epoch，再由宿主验证整合候选；不能因本工具上线而把旧并行模式标记为严格隔离。
