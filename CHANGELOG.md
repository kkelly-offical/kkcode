# Changelog / 更新日志

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
  worktrees before cleanup so Windows does not hold the directory open, and
  source the splash version directly from the package release metadata.

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
  避免 Windows 持有目录锁；启动动画版本号统一读取 package 发布元数据。

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
