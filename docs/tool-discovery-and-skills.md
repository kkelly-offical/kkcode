# 工具发现、分层指令和技能限制

[文档导航](README.md) · 适用源码：1.1.6；[发行状态](versions.md)。

可选内置工具采用按需发现，`tool_search` 返回详细手册；
提示缓存按完整内容指纹、每内核隔离。新增 `tool_batch` 的 1–8 项受控串行组合。
见 [Harness](context-and-harness.md)。以下原有 MCP 阈值和技能限制仍然有效。

内建 `browser`（默认注册、引擎按需安装/启动）、SVG的源代码／栅格
预览双路径，以及内建/插件/MCP 共同的多模态结果处理。详见
[Browser工作流](browser-workflows.md)和[媒体输入](media-input.md)。非法JSON参数在工具执行前返回
明确的修复提示；审查使用 hook 转换后的实际参数，而不是转换前的旧命令。

## 按需 MCP 工具发现

MCP 连接在后台进行，启动对话不等待所有服务器。就绪后工具注册表原子更新；
尚未就绪的工具不会被描述为可调用。

当当前智能体有不少于 24 个可用 MCP 工具且允许 `tool_search` 时，模型请求
默认只携带基础工具和已选中的 MCP schema。模型调用 `tool_search`，通过名称、
描述、参数名进行 BM25 检索（支持中文词片），每次返回 1–10 项，默认 5 项。
命中的完整 schema 出现在下一次模型请求里。搜索本身不执行工具，不批准权限，
不会显示智能体白名单之外的工具。

激活集合只属于当前回合，最多 64 个工具，不跨并发回合共享；下一回合重新发现。
SDK 的 `kernel.tools.list()` 仍返回完整注册清单，`get/call` 保持原有调用契约。
只允许少数 MCP 工具但没有 `tool_search` 的智能体仍直接收到其允许的清单。

```yaml
tool:
  discovery:
    enabled: true
    threshold: 24
  legacy_aliases: false
mcp:
  background_load: true
```

需要旧的完整模型工具列表时，设 `tool.discovery.enabled: false`；需要同步
MCP 启动时，设 `mcp.background_load: false`。这些开关不改变权限规则。

## 统一入口与兼容别名

| 模型默认入口 | 兼容入口／输入 |
| --- | --- |
| `task_output` | `background_output`、`task_get` 保留 |
| `task_stop` | `background_cancel` 保留 |
| `edit` 精确替换 | 原有 `path/before/after/replace_all` |
| `edit` 行范围替换 | `path/start_line/end_line/content`；旧 `patch` 保留 |
| `edit` 原子批量 | `changes: [{path, before, after}]`；旧 `multiedit` 保留 |

三种 edit 形式不能混用。其读前校验、过期内容检查、文件锁、回滚和红绿 diff
元数据仍由原实现提供。别名只从默认模型广告面收起，不从注册表删除；
`tool.legacy_aliases: true` 可恢复完整广告面。原有智能体若只允许某个旧名，
该旧名仍会直接展示。

`task` 默认模型 schema 为 7 个常用字段加 `brief`，详细目标、约束与预算放入
对象中，旧的顶层参数仍被接受：

```json
{
  "prompt": "检查当前改动的测试覆盖",
  "subagent_type": "explore",
  "brief": {
    "write_scope": "read-only",
    "deliverable": "按风险排序的发现清单",
    "budget_usd": 0.5
  }
}
```

同时提供新旧字段时，显式顶层值优先；路由字段不接受藏入 `brief`。

## 项目指令

从最近的 Git 根目录向工作目录逐层读取 `AGENTS.md`、`CLAUDE.md`、`CONTEXT.md`、
`KKCODE.md`、`.kkcode.md`、`kkcode.md`。工作树 `.git` 文件也作为边界；
嵌套仓库不会继承外层仓库指令。非 Git 工作目录保持只读取当前目录。

更深目录的规则仅在该子树内优先。不会读取根目录以上的个人或其他项目规则。
同一物理路径的大小写别名不重复加载；越出项目的指令符号链接明确拒绝。
每文件 128 KiB、累计 512 KiB，超过限制明确报错，不静默截断。
这是**根到当前工作目录**的加载，不宣称自动扫描每个后续访问文件的子目录。

## Skill 标志

| 标志 | 行为 |
| --- | --- |
| `disable-model-invocation: true` | 从模型技能目录隐藏，模型猜名字调用也拒绝 |
| `user-invocable: false` | 用户 `$skill`、兼容 `/skill`、headless 与远端命令拒绝，用户补全不显示 |
| `allowed-tools` | 在当前回合叠加工具限制；多个 skill 取交集，普通审批仍然适用 |
| `context-fork`／`model` | 沿用既有展开与模型选择语义，不等同于复刻其他产品的完整沙箱 |

`allowed-tools` 支持列表或空格分隔名称、通配符和 `Bash(git:*)` 等受限命令形状；
Read/Grep/Bash 等常见可移植名称映射到本项目工具名。受限 shell 模式不接受
串联、重定向或命令替换。限制还传入前台子任务和后台 worker；不会跨并发回合污染。

这不是任意 JavaScript 插件的 OS 沙箱。可编程 `.mjs` 插件本身仍必须受信任并
通过原来的执行权限；服务端采样、所有第三方插件专属运行时不在此兼容声明中。
MCP OAuth范围见[协议适配](protocol-adapters.md)；表单、取消及其他当前子集见
[实际支持范围](protocol-extensions.md)。旧[协议矩阵](protocol-compatibility-1.0.1.md)仅作历史验收参考。
