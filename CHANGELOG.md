# Changelog / 更新日志

## 0.4.3

Everything here is a repair to Ultra machinery that existed but did not work.
No new features; no configuration changes.

### English

- Make the stage objective check reachable. It read the gate result as
  `gates.results.build` while `runUsabilityGates` returns the gate at
  `gates.gates.build`; both paths yielded `undefined`, and the resulting empty
  object both passed the "gate is decisive" filter and failed the "gate is
  passing" one. A stage with every planned file on disk and every gate green
  still came back unmet with the reason `gates failed: ; `. The escape hatch
  0.4.2 announced was never reachable in production. Gate results now go through
  a single `readGate()` that throws on shape drift instead of reading
  `undefined`, all gate test doubles come from one factory, and a contract test
  compares that factory against the real function key by key.
- Make the degradation chain degrade. It only advanced its level when a strategy
  reported success, and the default `fallback_model: null` made the first
  strategy always fail, so the level never moved off zero, `graceful_stop` was
  unreachable, and the four breaks that waited for it — H4 phase timeout, token
  budget ceiling, max-recoveries abort, H5 phase timeout — were all dead. The
  level now advances unconditionally, skipping strategies that do not apply.
  `degradation.enabled`, previously read by no code at all, now switches the
  chain off. The "degradation applied" notice is only emitted when something was
  actually degraded; under the default config it used to be false.
- Stop a headless run from disabling every quality gate a user has. The gate
  preference prompt ran with no TTY, where the answer is an empty string, which
  parsed as "all five gates off" and was written to the user-level
  `~/.kkcode/gate-preferences.json` — silently, for every project on that
  machine. The prompt is now skipped when the user cannot be reached, an
  unparseable answer writes nothing, and an all-off record without an explicit
  marker is treated as damage from 0.4.x and re-asked once.
- Deliver Ultra's failure diagnosis. `generateRecoverySuggestions` has produced
  a structured post-mortem since 0.3.x — failed tasks with error categories,
  manual investigation steps, a resume hint — and `engine.mjs` dropped it in both
  of the two places that enumerated the result fields. The repo had zero
  consumers. Those two enumerations are now one function, and the REPL and
  `kkcode ultra start` both render the diagnosis.
- Guarantee teardown. The stop-event listener was unsubscribed on three of four
  return paths, and thrown errors skipped teardown entirely, leaving a leaked
  listener and a session pinned at `running-longagent`. A single `finally` now
  owns it, and `runStageBarrier`'s throws for dependency cycles and file-ownership
  overlap are caught as plan defects rather than discarding the whole turn.
- Give alerts a reason. Seven of twelve `LONGAGENT_ALERT` emitters never set the
  field the renderer reads, so the terminal showed a bare `alert [stuck_warning]`
  with nothing after it. A static check now enforces the field. Two declared
  events that had a renderer and no emitter are now emitted, and three that were
  emitted with no renderer are now shown.
- Give the gate-repair prompt the error output it is told to read. It instructed
  the model to find the root cause from output it was never given —
  `build:build failed with code 1` — while the captured twelve lines sat unread
  in the gate result.
- `kkcode ultra start` printed `done` for every run because it read a field that
  does not exist on the result; it now reports the real status and exits non-zero
  on failure. `currentStageId` was read by the status bar but never returned, so
  the bar always degraded to `2/5` instead of naming the stage.

### 中文

- 让 stage 目标核验重新可达。它把门禁结果读作 `gates.results.build`，而
  `runUsabilityGates` 返回的门禁在 `gates.gates.build`；两条路径都取到
  `undefined`，得到的空对象既通过了「门禁有发言权」的过滤，又被判为「没通过」。
  于是文件全部落地、门禁全绿的 stage 仍然返回未达成，理由是毫无意义的
  `gates failed: ; `。0.4.2 宣称的那道逃生门在生产路径上从未可达。现在门禁结果
  统一经 `readGate()` 读取——形状不对会抛而不是取到 `undefined`，全仓门禁替身
  只能由一个工厂构造，契约测试拿真函数的输出与它逐键比对。
- 让降级链真的会降级。它只在策略生效时才推进档位，而默认的
  `fallback_model: null` 让第一档恒定失败——档位永远停在 0，`graceful_stop`
  不可达，依赖它的四处 break（H4 阶段超时、token 预算上限、重试次数耗尽、
  H5 阶段超时）全部失效。现在档位无条件前进，跳过不适用的策略。
  `degradation.enabled` 此前没有任何代码读取，现在能真正关闭整条链。
  「已降级」的提示只在确实降了级时才发——默认配置下它一直在说谎。
- 阻止无终端运行关掉用户的全部质量门禁。门禁偏好询问在没有 TTY 时照样执行，
  而那里的答案是空串，被解析成「五个门禁全关」并写进用户级的
  `~/.kkcode/gate-preferences.json`——静默生效，影响该机器上的所有项目。
  现在问不到用户就跳过，解析不出答案就不写盘，而没有显式标记的「全关」记录
  会被当作 0.4.x 的事故遗留，重新询问一次。
- 把 Ultra 的失败诊断送到用户面前。`generateRecoverySuggestions` 从 0.3.x 起就
  在生成结构化的事后分析——失败任务及其错误分类、手动排查步骤、恢复提示——而
  `engine.mjs` 在两处逐字段枚举结果的地方都把它丢掉了，全代码库零消费者。
  两处枚举现已收敛为一个函数，REPL 与 `kkcode ultra start` 都会渲染这份诊断。
- 保证收尾。stop 事件的监听器只在四条返回路径中的三条退订，而抛出的异常会
  完全跳过收尾——监听器泄漏，会话永久停在 `running-longagent`。现在退订只有
  一处 `finally`；`runStageBarrier` 因依赖环与文件所有权冲突抛出的错误会被
  当作计划缺陷捕获，而不是让整个回合连同已完成的工作一起丢掉。
- 让告警说出原因。十二个 `LONGAGENT_ALERT` 发射点里有七个从不设置渲染器要读
  的那个字段，终端上只会出现一行 `alert [stuck_warning]`，后面空空如也。
  现在有静态检查兜底。两个「有渲染器没有发射者」的事件补上了发射，三个
  「有发射者没有渲染器」的事件补上了显示。
- 让门禁修复提示词拿到它被要求阅读的错误输出。它一边让模型「从错误输出里找出
  根因」，一边只给出 `build:build failed with code 1`，而采集好的末 12 行输出
  就躺在门禁结果里没人读。
- `kkcode ultra start` 因为读了一个结果对象上并不存在的字段，对每一次运行都打印
  `done`；现在会报告真实状态并在失败时以非零码退出。`currentStageId` 被状态栏
  读取却从未被返回，所以状态栏永远退化成 `2/5` 而不是阶段名。

## 0.4.2

### English

- Restore the Ultra stage prompts. `preview-agent`, `blueprint-agent`,
  `coding-agent` and `debugging-agent` derive their prompt file from the agent
  name, but the files ship under a `longagent-` prefix, so `getAgentPrompt()`
  silently returned an empty string and all four stages had been running with no
  role instructions at all. 229 lines of specialist prompting are live again.
- Stop injecting the mode contract twice. `modeReminder()` prepended it while a
  dedicated `mode_contract` block emitted the same text, so roughly 8% of every
  system prompt was a verbatim duplicate paid for on every request.
- Update the CLI assistant contract to the 0.4.0 vocabulary and state explicitly
  that Agent, Agent · Auto and YOLO differ by approval level, not by lane, so a
  wider mode is never read as pre-approval for edits.
- Add `kkcode preflight`: a fast startup self-check covering config, provider
  credentials, MCP, skills and version. It stays deliberately lighter than
  `doctor`, which also runs session fsck and audit-chain verification. The TUI
  runs it on startup and prints only what is wrong.
- Honour `KKCODE_AUTO_UPDATE` for startup auto-install, overriding
  `update.auto_install` in both directions. The default remains notify-only.
- Stop Ultra from re-running a finished stage. `stageIndex` only advanced when
  every task reported `[TASK_COMPLETE]`, so a stage whose files were already
  written and whose tests already passed would loop until the phase timed out —
  and each degradation reset the recovery counter to zero, removing the only
  ceiling. Stages now verify the objective directly (declared files present,
  build and test passing) before retrying, and a separate running total caps
  total attempts at `max_stage_attempts` regardless of degradations.
- Remove the orphaned `max-steps.txt` prompt.

### 中文

- 恢复 Ultra 的阶段提示词。`preview-agent`、`blueprint-agent`、`coding-agent`、
  `debugging-agent` 的提示词文件名默认取 agent 名，而文件实际带 `longagent-`
  前缀，`getAgentPrompt()` 一直静默返回空串——四个阶段从来没有加载过角色指令。
  229 行专家提示词重新生效。
- 模式契约不再重复注入。`modeReminder()` 会拼接它，而 `mode_contract` 块又发
  一遍同样的文字，约占系统提示词的 8%，每个请求都在为这份重复付费。
- CLI assistant 契约同步到 0.4.0 词汇，并明确写出 Agent、Agent · Auto、YOLO
  的区别在审批档而非航道，避免模型把更宽的模式当成编辑已获批准。
- 新增 `kkcode preflight`：快速启动自检，覆盖配置、provider 凭据、MCP、skills
  与版本。它刻意比 `doctor` 轻——后者还会做 session fsck 与审计链校验。TUI
  启动时会自动跑一遍，只在有问题时打印。
- 支持用 `KKCODE_AUTO_UPDATE` 控制启动自动升级，双向覆盖 `update.auto_install`；
  默认仍然只提示不自装。
- Ultra 不再重跑已经完成的 stage。`stageIndex` 只在所有 task 都报出
  `[TASK_COMPLETE]` 时推进，于是文件早已写好、测试早已通过的 stage 会一直
  重跑到阶段超时；而每次降级又把 recovery 计数清零，唯一的上限也随之失效。
  现在重试前会直接核验目标是否达成（声明的文件是否落地、build/test 是否通过），
  并用一个不清零的累计计数把总尝试次数限制在 `max_stage_attempts`。
- 删除零引用的 `max-steps.txt`。

## 0.4.1

### English

- Fix a CLI end-to-end test that still expected `permission.default_policy` in
  `kkcode permission show`. The key was removed from `DEFAULT_CONFIG` in 0.4.0,
  so a clean install no longer prints it; the test only passed locally because a
  stale user config supplied the field. No runtime behaviour changed.

### 中文

- 修复一条仍然期待 `kkcode permission show` 输出 `permission.default_policy`
  的端到端测试。该键在 0.4.0 已从 `DEFAULT_CONFIG` 移除，干净安装不再打印；
  此前只因本地遗留的用户配置提供了该字段才通过。运行时行为不变。

## 0.4.0

### English

- Collapse the mode vocabulary into a single flat cycle. `Shift+Tab` walks
  Plan, Agent, Agent · Auto, Ultra and YOLO; `/mode` opens a picker. Each mode
  is a (lane, approval) pair, and the lane identifiers stay on the 0.3.x
  vocabulary so sessions, hooks and permission rules keep working.
- Merge the six permission levels into four: `readonly`, `manual`,
  `accept-edits` and `yolo`. The new third level is deliberately not named
  `auto` — in 0.3.x `auto` meant edits still ask, so reusing the name would
  have silently widened existing configs on upgrade.
- Delete the unreachable `permission.mode` and `permission.default_policy`
  decision branches, and fix `/permission allow|ask|deny`, which previously
  wrote only those fields and was therefore a silent no-op.
- Add **Always Allow** to the approval prompt. Grants persist as ordinary
  `permission.rules[]` entries in the user config, scoped by `workspace` so
  they neither leak into other repositories nor into a user's git history.
  Manage them with `/permission list` and `/permission forget`.
- Keep one Ultra orchestration. The 4stage and parallel implementations are
  removed along with their config keys and the `/longagent 4stage|hybrid`
  subcommands; `/ultra` is the new name and `/longagent` a deprecated alias.
- Make the plan handoff real: choosing Build or Ultra Build after `exit_plan`
  now switches mode and runs the build turn, instead of asking the user to
  start it themselves.
- Add a top-level `models` block with `main`, `fast` and `subagent`, replacing
  five disconnected model override mechanisms. `fast` powers a cheap
  non-streaming, audit-bypassed channel used by inline ghost text and session
  titles; it never falls back to `main`.
- Predict the next phrase inline in the composer when `models.fast` is set.
  Ghost text produces no cells, never moves the cursor and never adds a row,
  so mouse hit-testing and IME placement are unchanged.
- Scroll the transcript while dragging past the edge of the log area. Selection
  anchors moved to transcript-absolute coordinates, so a selection now survives
  scrolling mid-drag and can extend beyond the visible viewport.
- Every 0.3.x mode name, permission level and config key still works, mapping
  automatically with a one-time deprecation notice. Removal is planned for
  0.5.0.

### 中文

- 将模式词汇收敛为一条扁平循环：`Shift+Tab` 依次切换 Plan、Agent、
  Agent · Auto、Ultra、YOLO，`/mode` 打开选择面板。每个模式都是
  (航道, 审批档) 二元组，航道标识保持 0.3.x 不变，会话、hooks 与权限规则
  全部照常工作。
- 权限六级合并为四级：`readonly`、`manual`、`accept-edits`、`yolo`。第三档
  刻意不叫 `auto`——0.3.x 的 `auto` 语义是「编辑仍需确认」，沿用同名会在升级时
  静默放宽已有配置。
- 删除 `permission.mode` 与 `permission.default_policy` 两条永不可达的判定
  分支；修复 `/permission allow|ask|deny`，它此前只写这两个字段，实际是空操作。
- 审批弹窗新增 **Always Allow**。授权以普通 `permission.rules[]` 形式写入用户级
  配置，并带 `workspace` 限定，既不会跨仓库误放行，也不会进入用户的 git 历史。
  可用 `/permission list` 与 `/permission forget` 管理。
- Ultra 只保留一套编排：删除 4stage 与 parallel 两套实现及其配置键和
  `/longagent 4stage|hybrid` 子命令；`/ultra` 为新名称，`/longagent` 保留为
  弃用别名。
- Plan 交接真正落地：`exit_plan` 后选择 Build 或 Ultra Build 会直接切换模式并
  开始执行，而不再只是提示用户自己去启动。
- 新增顶层 `models` 配置（`main` / `fast` / `subagent`），取代此前五套互不相通的
  模型覆盖机制。`fast` 提供廉价的非流式、旁路审计通道，供输入框预测与会话标题
  使用；它不会回退到 `main`。
- 配置 `models.fast` 后，输入框会内联预测下一句。Ghost text 不产生 cells、
  不移动光标、不新增行，鼠标点击与输入法定位与之前完全一致。
- 拖动选择文字到日志区边缘外时自动滚动。选区锚点改用 transcript 绝对坐标，
  边选边滚不再错位，选区也可以超出当前可见区域。
- 0.3.x 的模式名、权限等级与配置键全部继续可用并自动映射，首次使用时打印一次性
  弃用提示，计划在 0.5.0 移除。

## 0.3.3

### English

- Rebuild the full-screen terminal renderer around row-addressed updates and a
  real hardware cursor at the composer coordinates, allowing supported terminal
  IME and accessibility integrations to use the actual input position.
- Add incremental SGR mouse and bracketed-paste decoding for transcript
  selection, cross-platform clipboard requests with honest confirmation state,
  wheel scrolling, composer cursor placement, and click-to-expand Thinking/tool
  blocks. Preserve CJK and emoji input when UTF-8 bytes cross stdin chunks, and
  include the final visible composer row in mouse hit-testing.
- Restore cooked mode, mouse tracking, bracketed paste, and the alternate
  screen before Unix job-control suspension; reactivate them on `SIGCONT`.
  Final teardown also drains pending prompts, pauses stdin, and awaits MCP child
  shutdown so `/exit` cannot leave the process or terminal hanging. A synchronous
  exit guard and Windows `SIGBREAK` handling restore the shell after abrupt exits.
- Render assistant Markdown incrementally without chunk-boundary artifacts.
  Move mode/model/provider/permission changes into transient bottom toasts,
  mute tool activity, and expose bounded red/green mutation diffs on demand.
- Show animated elapsed `Thinking · Ns` state during model reasoning and retain
  the completed reasoning as a collapsed, inspectable transcript block. Promote
  the waiting animation into native reasoning without emitting a duplicate empty
  block, and preserve readable Anthropic thinking in non-streaming responses
  without retaining signatures or redacted payloads.
- Treat `retry_attempts: 5` as five reconnects after the initial request.
  OpenAI, Anthropic, compatible gateways, Kimi, and Ollama retry transient
  connection/rate/server failures before the first streamed event, honor
  `Retry-After`, fast-fail deterministic client errors, and never replay a
  request after outward stream content begins.
- Correlate retry events with session, turn, trace, and request identities while
  preserving the final provider error classification for audit records.
- Keep real-desktop mouse, clipboard, and IME behavior in the pre-release manual
  acceptance matrix for Windows, macOS, and Linux terminal emulators.
- Harden native Windows execution: await MCP shutdown in one-shot commands,
  keep argv-form MCP servers out of `cmd.exe`, launch npm/npx and local Prettier
  through safe platform-aware paths, and make branch-review hashes stable across
  Git for Windows path quoting.
- Hold an ambiguous standalone ESC for 35 ms so mouse and paste reports remain
  intact across transport chunks, then deliver a bare Escape without Readline's
  extra delay. Native clipboard fallbacks now run asynchronously, cancel stale
  copies, and use PowerShell UTF-8/Base64 transport for CJK and emoji on Windows.
- Read Linux Wayland image and text clipboards through `wl-paste`, retaining
  `xclip`/`xsel` fallbacks and bounded, timeout-protected reads. Leave detached
  worktrees before cleanup so Windows does not hold the directory open; on
  Windows, validate the registered non-primary worktree, remove its directory
  and exact administrative entry directly, then verify the registration is gone
  without invoking the hanging `git worktree remove` path. Source the splash
  version directly from the package release metadata.
- Stop injecting and preloading Context7 at startup, so a clean KK Code install
  does not invoke `npx` or download an MCP package. Context7 and every other MCP
  server remain available through explicit user, workspace, or plugin configuration.

### 中文

- 将全屏终端渲染重构为逐行更新，并在输入框坐标恢复真实硬件光标，让支持该机制的
  终端输入法与辅助功能使用实际输入位置。
- 新增增量 SGR 鼠标与 bracketed paste 解码，支持对话拖选、跨平台复制请求与
  确认状态区分、滚轮浏览、点击定位输入光标，以及点击展开/收起 Thinking 与工具详情；
  中文与 emoji 的 UTF-8 字节即使跨 stdin 分片也不会损坏，输入框最后一行也可正确点击。
- Unix 挂起前会恢复 cooked mode、鼠标、bracketed paste 与主屏幕，`SIGCONT`
  后再完整激活；最终退出会收口待决交互、暂停 stdin 并等待 MCP 子进程关闭，
  避免 `/exit` 后进程或终端仍被占用；同步退出保护和 Windows `SIGBREAK`
  处理也会在异常退出时恢复 Shell。
- 增量解析模型 Markdown，避免流式分片破坏格式；模式、模型、Provider、权限切换
  改为底部瞬时 Toast；工具日志降为浅灰色，代码修改可按需查看受限长度的红绿 Diff。
- 模型思考时显示带动效和耗时的 `Thinking · Ns`，完成后保存为默认折叠、可检查的
  对话块；等待动画会直接升级为原生 reasoning，不再额外生成空白 Thinking 行。
  Anthropic 非流式响应也会保留可读思考内容，但不会记录签名或 redacted 密文。
- 将 `retry_attempts: 5` 明确定义为首次请求之后最多重连 5 次。OpenAI、
  Anthropic、兼容网关、Kimi 与 Ollama 会在首个流式事件前重试网络、限流与服务端
  瞬时错误，遵循 `Retry-After`；确定性客户端错误立即失败，流式内容开始后绝不重放。
- 重试事件关联 session、turn、trace 与 request 身份，并为审计记录保留最终模型错误分类。
- Windows、macOS、Linux 真实桌面终端的鼠标、剪贴板和输入法表现仍列入发布前
  手工验收矩阵，不以伪终端自动化测试替代。
- 补齐 Windows 原生执行兼容性：一次性命令会等待 MCP 完整关闭，argv 形式的 MCP
  不再经过 `cmd.exe`，npm/npx 与项目 Prettier 使用安全的平台感知启动路径，并消除
  Git for Windows 临时路径转义造成的分支审查哈希漂移。
- 对单独到达的 ESC 保留 35 ms 判定窗口，避免鼠标与粘贴协议跨分片时被拆散；
  确认为裸 Escape 后不再叠加 Readline 延迟。原生剪贴板回退改为异步执行并取消
  过期复制，Windows 通过 PowerShell UTF-8/Base64 通道可靠复制中文与 emoji。
- Linux Wayland 的图片与文本剪贴板优先通过 `wl-paste` 读取，同时保留
  `xclip`/`xsel` 回退、超时和大小限制；清理 detached worktree 前先离开该目录，
  避免 Windows 持有目录锁；Windows 还会先校验目标是已登记且非主工作树，再直接
  删除目录及对应的精确 Git 管理项并复核登记已移除，绕开会卡死的
  `git worktree remove` 路径；启动动画版本号统一读取 package 发布元数据。
- 移除启动时自动注入并预加载的 Context7，干净安装的 KK Code 不再调用 `npx`
  或下载 MCP 包；用户仍可通过个人、工作区或插件配置显式启用 Context7 及其他
  任意 MCP Server。

## 0.3.2

### English

- Discover models from user-configured OpenAI or Anthropic-compatible Base URLs.
- Unify OpenAI and Anthropic gateway endpoints, dynamic wizard/TUI model selection,
  persistent catalog caching, and an opt-in one-token inference probe.
- Add correlated request identity and a redacted, rotating `kk.audit.v1` SHA-256
  audit chain with verify, filter, and export commands.
- Add AI-assisted local branch and GitHub pull-request review, deterministic
  high-risk checks, waiver reasons, idempotent PR publishing, and fail-closed gates.
- Enforce trusted-workspace provider boundaries, HTTPS for credential-bearing
  endpoints, terminal-safe model catalogs, and end-to-end review trace correlation.

### 中文

- 从用户配置的 OpenAI 或 Anthropic 兼容 Base URL 动态发现模型。
- 统一 OpenAI / Anthropic Gateway 端点、向导与 TUI 动态模型选择、持久缓存，
  并提供显式启用的单 token 推理探测。
- 新增可关联请求身份，以及脱敏、轮换的 `kk.audit.v1` SHA-256 审计链，
  支持校验、筛选和导出。
- 新增 AI 辅助的本地分支及 GitHub Pull Request 审查、确定性高风险检查、
  带理由的豁免、幂等 PR 发布与 fail-closed 门禁。
- 对项目级模型出口执行工作区信任隔离，要求携带凭据的端点使用 HTTPS，并加入
  模型目录终端安全校验与审查全链路 trace 关联。

## 0.3.1

### English

- Identify outbound HTTP requests as `KK-Code/0.3.1` and redact credentials in diagnostics.
- Add an official Kimi Code Coding API preset with K3 and Kimi for Coding models.
- Improve terminal transcript, tool lifecycle, cancellation, workspace isolation, and provider reasoning support.
- Keep existing configuration and session data readable without destructive migration.

### 中文

- 将出站 HTTP 请求身份统一为 `KK-Code/0.3.1`，并在诊断输出中脱敏凭据。
- 新增官方 Kimi Code Coding API 预设，提供 K3 与 Kimi for Coding 模型配置。
- 改进终端 Transcript、工具生命周期、任务取消、工作区隔离与模型推理支持。
- 保持旧配置和会话可读，不执行破坏性迁移。
