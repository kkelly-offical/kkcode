# 模式、权限与任务恢复

[文档导航](README.md) · 适用源码：1.0.5；[发行状态](versions.md)

## 五种公开模式

`agent` 是默认统一助手。CLI用 `Shift+Tab` 循环模式，也可用 `/mode` 选择；
Web/Android用一个模式选择器，不再并列独立权限档或终端快捷键提示。

| 模式 | 适用工作 | 默认行为 |
| --- | --- | --- |
| `plan` | 先梳理需求与实施步骤 | `/plan` 只读编写开发计划；可保存规划记录，不执行工作代码修改 |
| `agent` | 日常问答、修改、审查与测试 | 编辑等操作按策略确认 |
| `auto` | 在明确范围内自动推进 | 常规编辑自动执行，敏感操作由当前对话模型作有界审查；不确定则问用户 |
| `ultra` | 明确重型任务、跨文件多阶段交付 | 用 `/ultra` 显式进入，配合目标、步骤、预算、检查点和验收 |
| `yolo` | 用户明确授权范围内的自主执行 | 跳过常规确认，但不越过硬拒绝、范围限制和严格任务合同 |

Plan结束后选择 Build / Ultra Build / compact 执行路径才开始执行。
默认先在内部 `assistant` 航道处理普通终端事务和编码小闭环，重型任务再使用Ultra；
路由理由可见，模式切换不是绕过权限的办法。

普通Ultra和[严格任务](trusted-runs.md)不是相同的隔离等级。后者需宿主确认合同、
独立工作区、严格后端、持久账本与独立验收；不会因为点了Ultra就自动取得这些保护。

## 授权边界

目录访问许可、项目配置／扩展信任、工具审批、网络出域、浏览器授权和预算各自独立。
`--trust` 不等于允许访问所有目录；远控目录同意不等于跳过工具审批。

审批支持 Allow Once、Allow Session、Always Allow、Deny。Always Allow保存到
用户配置，并用 `workspace` 限定项目；使用 `/permission list` 查看，
`/permission forget <n|all>` 撤销。共享访客不能借控制会话创建永久授权。

高级CLI配置仍有 `permission.level: readonly | manual | accept-edits | yolo`。
它是模式与治理规则的底层策略，不是要求Web/Android再显示一套权限选择器。
Auto的模型审查失败／不确定时转人工；硬拒绝、受保护路径和显式人工规则不可由模型放行。
挂机提问超时可以跳过普通问题，但**不会自动批准已发给用户的权限请求**。

## 沙箱不是审批的同义词

普通聊天的可选OS沙箱由 `permission.sandbox.mode` 配置，默认关闭；Linux使用
bubblewrap、macOS使用sandbox-exec。有效后端在 `/status` 和 `kkcode doctor` 可见；
后端不可用不表示隔离成功。`writable_dirs` 和网络选项应按工具链需要明确设置。

`!命令` 是用户自己的shell直通，不经模型审批，也不进入上述沙箱；输出可能进入
下一轮模型上下文，避免用它打印密钥。独立Docker严格任务另见[隔离指南](strict-isolation.md)。

## 委派、后台任务与中断

- 有边界的子任务通过 `task`／`task_group` 观察；`fresh_agent` 用于独立实现，
  `fork_context` 用于只读研究／核验；任务和预算范围不能被提示词扩大。
- `background_output` 查看输出，`background_cancel` 取消任务；兼容名称分别对应
  `task_output`／`task_stop`。终态为 `completed` / `cancelled` / `error` / `interrupted`。
- CLI的 `Esc` 中断当前 turn，或按当前界面关闭弹层／拒绝请求；中断不是撤销已发生的副作用。
- `isolation="worktree"` 的成果不会自动覆盖当前工作区；先查看差异，使用
  `kkcode background apply --id <task_id> --dry-run` 预检后再决定是否回收。
- 未知副作用先核查，不能为“恢复成功”而盲目重放。长期任务的真实可靠性仍需[独立验收](independent-review.md)。

## 兼容旧配置

| 输入／名称 | 当前处理 |
| --- | --- |
| `agent-auto` | 兼容别名，当前公开名称为 `auto` |
| `assistant` / `agent` / `code` / `coding` / `ask` | 兼容别名，归一为 `agent` |
| `/longagent` | 兼容 `/ultra`；内部 `longagent` 航道标识仍保留 |
| `permission.mode` / `permission.default_policy` | 已过时的配置键，需迁移到 `permission.level`，不能期待静默兼容 |
| 旧权限等级 `review` / `auto` | 配置需迁移为 `manual`；不是当前公开的Auto模式 |
| 旧权限等级 `edit` / `full-auto` | 配置需迁移为 `accept-edits` |

内部 `assistant` / `plan` / `longagent` 标识用于会话和规则，与公开模式名不是同一层。
旧契约仅供迁移参考，见[历史资料](history.md)。
