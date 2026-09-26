# CLI、终端交互与扩展入口

[文档导航](README.md) · 适用源码：1.1.6；[模式与权限](modes-and-permissions.md)

## 常用对话命令

| 操作 | 命令 |
| --- | --- |
| 帮助／运行状态 | `/help`、`/status` |
| 开始、恢复、浏览会话 | `/new`、`/resume`、`/history` |
| 渠道与模型 | `/provider`、`/model`（含服务支持的思考档位） |
| 模式选择 | `/mode`、`/mode auto`、`/plan`、`/ultra` |
| 权限规则维护 | `/permission list`、`/permission forget <n|all>` |
| 工具与扩展目录 | `/commands`、`/reload` |
| 外观 | `/theme`（dark/light/auto） |
| 个人偏好 | `/profile`、`/like` |
| 只读旁问 | `/btw <问题>`：可看对话，不运行工具、不改主记录；本次推理仍可能计费 |
| 本地扩展 | `/create-skill`、`/create-agent`、`$<skill> [参数]` |
| 用户shell直通 | `!<命令>`；不进模型审批／沙箱，输出可能被下一轮模型看到 |

完整目录以当前安装的 `kkcode --help`、`kkcode <command> --help` 和 `/help` 为准。
Web/Android使用界面控件和支持的slash命令，不需要学习或显示终端键盘快捷键。

<a id="terminal"></a>
## 终端交互

- `Shift+Tab` 切模式；`Esc` 可中断当前turn，或关闭当前交互。
- 忙碌时 `Enter` 排队；空输入再按 `Enter` 可升级为插话，在步骤边界注入，
  不在assistant/tool配对之间拼接消息。
- 鼠标滚轮查看历史，点击输入框定位光标；拖动选择文字，点击Thinking／工具行展开详情。
- `Ctrl+T` 展开最近Thinking，`Ctrl+E` 展开最近可展开块，`Ctrl+Y` 切换选中后复制。
  Unix的 `Ctrl+Z` 会恢复终端状态再挂起，`fg` 后重绘。
- 如终端拦截鼠标，可用其原生选择修饰键（常见为Shift），或设置
  `ui.terminal.mouse: never`；此时用 `Ctrl+Up/Down`、`Ctrl+Home/End` 浏览应用历史。

剪贴板和中文输入法受具体终端／桌面权限影响；SSH不会自动把手机或本机剪贴板
传给服务器。[终端细节与平台回退](terminal-experience-0.3.3.md)保留实现沿革和排查矩阵。
Markdown、灰色工具过程、红绿差异、可展开思考和短暂toast是当前显示方式，
自动协议测试不等同于每款GUI终端／输入法的实测。

## 宿主命令分组

| 方向 | 入口 | 说明 |
| --- | --- | --- |
| 对话与会话 | `chat`、`session` | 终端、脚本和持久对话 |
| 后台与长任务 | `background`、`agent`、`ultra` | 查询、取消、分组、独立工作树成果处理 |
| 严格任务 | `runs`、`runs backup` | 合同、执行、恢复、诊断和备份；见[严格任务](trusted-runs.md) |
| 产物与依赖 | `artifacts`、`environments` | 显式受控维护；见[依赖环境](dependency-environments.md) |
| 浏览器 | `browser install/status`、`browser bridge`、`browser recipe` | 引擎在工作电脑准备；个人浏览器需另行授权 |
| 文档与语言服务 | `services`、`office`、`lsp` | 固定镜像与私密配置；见[宿主服务](host-services.md) |
| 模型与费用 | `model`、`usage` | 目录、能力与使用记录；`--probe`可能调用收费模型 |
| 协议与扩展 | `mcp`、`skill`、`plugin`、`acp` | MCP/ACP及本地扩展 |
| 检查与审查 | `doctor`、`preflight`、`review`、`audit` | 环境、候选审查与审计链 |
| 多端 | `-web`、`remote` | 本机Web、Host及登录绑定；不是在云端启动工作电脑内核 |

严格任务等管理入口属于受信任宿主，不因为名称像工具就可以原样开放给模型或共享访客。
参数、确认哈希和未知结果核查要求以对应专题为准。`review` 的模型审查可能计费；
`--publish` 会产生外部写入，须先核对目标和授权。

## 扩展目录

项目扩展位于 `.kkcode/commands/`、`.kkcode/skills/`、`.kkcode/agents/`、
`.kkcode/tools/`、`.kkcode/plugins/`、`.kkcode/hooks/`；插件清单可用
`.kkcode-plugin/plugin.json`。加载项目代码前先核对工作区信任。

MCP服务、可执行插件和Hooks不自动成为安全沙箱。托管插件锁定来源和内容，
新增代码／能力需重新批准，详见[插件完整性](plugin-integrity.md)与[协议和Skills](protocol-extensions.md)。
需要机器消费的输出请使用[headless JSONL契约](headless-jsonl-contract.md)，不要解析TUI文字。
