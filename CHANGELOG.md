# Changelog / 更新日志

## 0.6.16

`repl.mjs` 拆分第一阶段：1090 行的命令路由变成注册表 + 六个命令模块。

### English

- **The command router is a registry now.** `processInputLine` was 1090 lines and
  49 sequential `if`s; it is 208 lines and looks up a table. Commands live in
  `src/repl/commands/{session,provider,permission,mode,authoring}.mjs`, one entry
  per command instead of one-to-four scattered branches. `repl.mjs` went from
  4563 to 3456 lines.
- **The completion catalog is derived from the registry.** `BUILTIN_SLASH` was a
  hand-written array of 39 rows sitting a thousand lines away from the dispatch it
  was supposed to mirror; eight commands (`/board`, `/cls`, `/home`, `/yolo` …)
  had been executable but invisible in completion because only the dispatch was
  updated when they were added. 0.6.0 papered over that with a regex that scanned
  the source and compared the two lists. The catalog is now computed from the same
  table that dispatches, so the drift is structurally impossible and the scan is
  gone. The derived catalog was verified row-for-row identical to the hand-written
  one — same 39 names, same descriptions.
- **Seven source-text assertions became behaviour assertions.** Nothing in the
  router was exported, so its contracts could only be tested by reading
  `repl.mjs` and matching regexes — assertions that verify a string exists in a
  file, and break the moment code moves. Commands are importable data now, so the
  tests call them and check which channel they wrote to. One of the old ones had
  already rotted into a vacuous pass: it anchored on a literal that had moved, so
  `indexOf` returned −1, `slice(-1)` left one character, and `doesNotMatch`
  succeeded against nothing. Every anchor now asserts it was found first.
- **Cache savings were computed, displayed, and dropped in between.** The turn
  result was assembled in two places — the normal submit path and `/paste <text>` —
  and the normal one omitted `costSavings`. So the `↓$0.0042` next to `COST` in
  the status bar, which reports how much prompt caching saved, only ever appeared
  after a `/paste`. Both paths are one `turn-presenter.mjs` now, with a single
  definition of what a turn result contains.
- **An enumeration-driven test found a missed toast.** 0.6.14 moved command
  errors off the transcript using a hand-picked list of four strings; the new test
  asserts *every* `usage:` message in the command layer is a toast, and caught the
  `/permission` fall-back usage line still going into the conversation.
- **78 dead imports removed** — 23 of them left behind by the 0.6.12 and 0.6.13
  splits, which moved code out without cleaning up what it had imported.
- **Two deliberate behaviour changes.** `/paste <text>` now also lists file
  changes and diagnostics, which it should always have done — that was lost when
  the turn path was copied. And a rewritten `/ultra <goal>` no longer runs the
  goal through command dispatch: `/ultra /model k3` used to switch the model,
  because the rewritten text fell through into the `if`s that came later. That was
  a by-product of statement order, not a design.
- **Verified in a real 100×32 terminal**, not just in unit tests: `/status`,
  `/agents`, `/provider`, `/mode` overlays, the picker→submit→registry round trip
  (status bar really does change to the selected provider), and `/exit`.

### 中文

- **命令路由变成注册表。** `processInputLine` 从 1090 行、49 个顺序 `if` 变成
  208 行的查表。命令本体在 `src/repl/commands/` 下按领域分成五个文件，一条命令
  一个注册项，而不是散在四处的分支。`repl.mjs` 从 4563 行降到 3456 行。
- **补全目录由注册表派生。** `BUILTIN_SLASH` 是一份 39 行的手写数组，和它本该
  镜像的分发隔着一千行；`/board`、`/cls`、`/home`、`/yolo` 等八条命令曾长期能
  执行却在补全里看不见，因为加它们时只改了分发。0.6.0 用一条扫源码的正则把这个
  问题糊住了。现在目录与分发同源，漂移在结构上不可能发生，那条扫描也删了。派生
  出的目录与手写版逐条核对过 —— 39 个名字、描述全部一致。
- **七处源码文本断言换成行为断言。** 路由里什么都没导出，它的契约只能靠读
  `repl.mjs` 打正则来验 —— 那种断言只证明「文件里有某个字符串」，且代码一搬就
  失效。现在命令是可导入的数据，测试直接调用它们、看它们往哪个通道写。其中一条
  旧断言已经烂成了**空洞通过**：它锚定的字面量搬走了，`indexOf` 返回 −1，
  `slice(-1)` 只剩一个字符，`doesNotMatch` 于是对着空气成立。现在每个锚点都先
  断言自己找得到。
- **缓存节省算出来了、有地方显示、中间被丢了。** 回合结果在两处组装 —— 正常提交
  一处、`/paste <文字>` 一处 —— 而正常那处漏了 `costSavings`。于是状态栏 `COST`
  旁边那个报告提示词缓存省了多少的 `↓$0.0042`，只在 `/paste` 之后出现过。两条路
  现在合并成一个 `turn-presenter.mjs`，「回合结果有哪些字段」只有一个答案。
- **枚举驱动的测试抓到一处漏掉的提示。** 0.6.14 把命令报错移出对话记录时用的是
  手写的四条文案清单；新测试断言命令层里**所有** `usage:` 文案都必须是瞬时提示，
  于是抓到 `/permission` 的兜底 usage 仍在往对话记录里写。
- **删掉 78 个死导入** —— 其中 23 个是 0.6.12、0.6.13 那两次拆分留下的：代码搬走了，
  它当初引入的依赖没跟着清。
- **两处有意的行为变化。** `/paste <文字>` 现在也会列出文件变更与诊断 —— 那本来就
  该有，是当初复制回合路径时丢的。以及 `/ultra <目标>` 改写后的文本不再过一遍命令
  分发：此前 `/ultra /model k3` 会去切模型，因为改写后的文本顺着流进了后面的
  `if`。那是语句顺序的副产物，不是设计。
- **在真实 100×32 终端里验过**，不只是单测：`/status`、`/agents`、`/provider`、
  `/mode` 四个浮层，选择器→提交→注册表的完整闭环（状态栏确实切到了所选渠道），
  以及 `/exit`。

## 0.6.15

修一个从 0.6.0 起就在的崩溃：`/agents` 与 `/tasks` 会打死行模式的 REPL。

### English

- **`/agents` and `/tasks` crashed the line-mode REPL.** Every command branch in
  the router returns an action object, and the three call sites read its fields
  directly (`action.cleared`, `action.exit`). These two branches returned a bare
  `null`, so the next line dereferenced it. In the TUI an enclosing `try/catch`
  swallowed it into one stray `error: Cannot read properties of null` line in the
  transcript — which is why it survived 15 releases. The line-mode loop (piped
  stdin, no TTY) has no `try/catch`, so the whole REPL died and never reached
  `/exit`.
- **Fixed in two layers, not one.** The five bare `return null` became
  `return { exit: false }`, and — the part that matters — all three call sites now
  normalize the result (`(await processInputLine(…)) || {}`). The first fixes
  today's instance; the second makes the whole class harmless, since a future
  branch that forgets to return an object now degrades to a no-op action instead
  of killing the process.
- **Regression cover.** A structural test asserts every call site normalizes and
  that no branch returns a bare null, plus an end-to-end test that runs a real
  line-mode process through the read-only commands and asserts it exits 0. The
  end-to-end one is the layer that would actually have caught this: the defect
  was invisible to unit tests because nothing in the router was exported.

### 中文

- **`/agents` 与 `/tasks` 会打死行模式的 REPL。** 命令路由的每个分支都返回一个
  action 对象，三个调用点直接读它的字段（`action.cleared`、`action.exit`）。这
  两个分支返回的是裸 `null`，下一行就解引用了它。TUI 外面有 `try/catch`，把它
  咽成对话记录里一行多余的 `error: Cannot read properties of null` —— 这正是它
  活过 15 个版本的原因。而行模式（管道输入、无 TTY）的循环没有 `try/catch`，
  整个 REPL 直接死掉，`/exit` 根本执行不到。
- **修两层，不是一层。** 5 处裸 `return null` 改成 `return { exit: false }`；更
  要紧的是三个调用点现在都做归一化（`(await processInputLine(…)) || {}`）。前者
  修的是这一次，后者让整类问题无害化 —— 将来某个分支忘了返回对象，只会退化成
  一次空动作，而不是杀掉进程。
- **回归防线。** 一条结构性测试断言每个调用点都归一化、且没有分支返回裸 null；
  另加一条端到端测试，真的起一个行模式进程把只读命令跑一遍，断言它以 0 退出。
  后者才是本该拦住这个缺陷的那一层：路由里什么都没导出，单测根本够不着它。

## 0.6.14

弹窗审查的第二半：`/resume` 也成了选择器，剩下 36 处输出按性质归位。

### English

- **`/resume` is a picker.** Bare `/resume` printed a numbered session list into
  the transcript and then asked you to type `/resume <number>` — read a number
  off a scrolling log, then type it back. It is the same shape as `/provider`, so
  it gets the same overlay: current session marked, mode/status/age per row,
  Enter resumes. Both pickers confirm by feeding the equivalent slash command
  through the normal submit path, so the channel-switch and session-restore logic
  stays in one place instead of being copied into the picker.
- **36 outputs moved off the transcript.** Two groups. Command errors — `usage:
  /model <model-id>`, `no session matching …`, `invalid model id`, generation
  failures — are feedback on a rejected command. Action confirmations —
  `workspace trusted`, `new session: …`, `permission saved`, `compacted: N
  messages` — report that something just happened. Neither is conversation, and
  both were being sent to the model along with the session. They are toasts now.
  Plain `print()` calls in the command router went from 103 to 67.
- **What deliberately stayed.** Model replies, file-change lists, diagnostics,
  generated skill/agent content, and Ultra's stage output remain in the
  transcript — a toast disappears, and those are things you need to scroll back
  to. There is a test asserting the reply and file-change paths did not get
  swept up in the conversion.

### 中文

- **`/resume` 现在是选择器。** 裸 `/resume` 此前把编号会话列表打进对话记录，
  然后要你敲 `/resume <编号>` —— 在滚动的日志里读一个数字，再手打回去。
  它和 `/provider` 同构，所以给同样的浮层：当前会话带标记、每行显示
  模式/状态/时间、Enter 直接续跑。两个选择器确认时都把等价的斜杠命令送进正常
  提交路径，所以切渠道与恢复会话的逻辑留在一处，而不是在选择器里复制一份。
- **36 处输出从对话记录移出。** 分两类。命令报错 —— `usage: /model <model-id>`、
  `no session matching …`、`invalid model id`、生成失败 —— 是对被拒命令的反馈。
  动作确认 —— `workspace trusted`、`new session: …`、`permission saved`、
  `compacted: N messages` —— 报告的是刚刚发生了什么。两者都不是对话内容，
  而它们此前都会随会话一起发给模型。现在都是瞬时提示。命令路由里的裸
  `print()` 从 103 处降到 67 处。
- **有意保留的部分。** 模型回复、文件变更清单、诊断、生成出来的 skill/agent
  内容、Ultra 的阶段输出仍留在对话记录里 —— 瞬时提示会消失，而这些是需要
  回看的东西。有一条测试专门断言回复与文件变更这两条路径没被这轮转换顺手扫走。

## 0.6.13

只读查询改走浮层，`/provider` 改成可视化选择器。

### English

- **Read-only queries no longer land in the conversation.** `/status`, `/help`,
  `/keys`, `/permission`, `/commands`, `/board`, `/agents`, `/tasks` and
  `/history` used to fold their output into a transcript entry. 0.6.0 solved the
  "80-line help floods the screen" problem, but left the output inside the
  conversation, which has three consequences: it gets sent to the model along
  with the session — and it is written for a person, not a model; `/clear` wipes
  it even though it has nothing to do with the conversation; and once read you
  cannot dismiss it, only scroll past. They now open a scrollable overlay
  (`↑↓`/PgUp/PgDn, Esc or Enter to close) that never touches the transcript. Line
  mode, which has no frame to float over, still falls back to a folded entry.
- **`/provider` is a picker now.** It printed a numbered list into the transcript
  and then entered a "type the number" mode. Configuring a channel is a
  selection, so it gets the same visual overlay as `/model`: current channel
  marked, model shown per row, Enter to switch, Esc to cancel. Confirming feeds
  `/provider <name>` through the normal submit path rather than duplicating the
  channel-switch logic.
- **A panel inside a panel was being wrapped apart.** `/status` renders its own
  box, and the overlay wrapped it at its inner width, breaking `+---...` onto a
  second line ending in `---+`. Content can now be a function of the available
  inner width; the runtime view and the ultra board both use it. A terminal
  resize re-renders them at the new width instead of leaving the border broken.
- **One-line action results became toasts.** `/session`, `/tasks stop`,
  `/tasks retry`, `permission.level -> …` and similar were transcript entries.
  They report that something just happened; they are not conversation.
- `scripts/tty-acceptance.sh` used `pkill -f "xterm -geometry"`, which matches
  any process whose command line contains that text — including the shell that
  invoked the script. It killed my own shell twice during this session's
  acceptance run. Matches by process name now.

### 中文

- **只读查询不再进入对话。** `/status`、`/help`、`/keys`、`/permission`、
  `/commands`、`/board`、`/agents`、`/tasks`、`/history` 此前把输出折叠成一条
  对话记录。0.6.0 解决的是「80 行帮助刷屏」，但把输出留在了对话里，带来三个
  后果：它会随会话一起发给模型 —— 而它是写给人看的，不是给模型看的；`/clear`
  会把它清掉，尽管它和对话内容无关；看完之后关不掉，只能往下滚过去。现在它们
  打开一个可滚动浮层（`↑↓`/PgUp/PgDn，Esc 或 Enter 关闭），完全不碰对话记录。
  行模式没有帧可浮，仍然回落到折叠条目。
- **`/provider` 现在是选择器。** 它此前把编号列表打进对话记录，然后进一个
  「输入编号」的模式。配置渠道是个选择动作，所以给它和 `/model` 一样的可视化
  浮层：当前渠道带标记、每行显示模型、Enter 切换、Esc 取消。确认时走用户手敲
  `/provider <name>` 的同一条码，而不是把切渠道的逻辑复制一份。
- **面板套面板会被折断。** `/status` 自己也画框，而浮层按内宽折行，把
  `+---...` 折成第二行以 `---+` 结尾。现在内容可以是「可用内宽的函数」，
  runtime 视图与 ultra 看板都用这种形式。终端 resize 后会按新宽度重排，
  而不是留着一个断掉的边框。
- **单行动作结果改为瞬时提示。** `/session`、`/tasks stop`、`/tasks retry`、
  `permission.level -> …` 之类此前都是对话记录条目。它们报告的是「刚刚发生了
  什么」，不是对话内容。
- `scripts/tty-acceptance.sh` 里的 `pkill -f "xterm -geometry"` 会匹配任何
  命令行含这段文字的进程 —— 包括调用它的那个 shell。这次验收过程中它两次杀掉
  了我自己的 shell。改为按进程名匹配。

## 0.6.12

`repl.mjs` 拆分的第一刀：4782 → 4284 行，抽出 `frame-primitives.mjs` 与
`frame-builder.mjs`。拆的过程本身找出四个真实缺陷 —— 这是拆分的实际收益，
不是副产品。

### English

- **Frame primitives existed in five divergent copies.** `stripAnsi`,
  `displayWidth`, `padRight` and friends were reimplemented in `repl.mjs`,
  `repl-dashboard.mjs`, `activity-renderer.mjs`, `repl-help.mjs` and
  `text-layout.mjs`, with four different ANSI patterns between them. `repl.mjs`
  and `repl-dashboard.mjs` matched SGR only, so `padRight` returned a string
  still carrying OSC hyperlink and cursor-movement bytes while presenting it as
  plain text — a tool that emits a hyperlink (npm and pnpm do) put escape bytes
  into a frame cell, and the terminal acted on them at paint time.
  `repl-help.mjs` aligned by JS string length, which is wrong for CJK and for
  colour codes; that one is latent only because the help table's first column
  happens to be ASCII commands. One implementation now, in
  `src/repl/frame-primitives.mjs`.
- **Two off-by-one layout bugs, found by the new tests.** Clipping to a cell
  budget can land inside a wide character; the clip stops one cell short and
  nobody padded the remainder. So `padRight("中文中文", 5)` returned 4 cells and
  `frameRow` came out one cell narrow whenever content contained CJK — the row
  shifts left and the border stops aligning. Both now pad the shortfall.
- **The status bar was still reading `process.stdout.columns` itself.** 0.6.1
  fixed *which* segment gets dropped when the bar does not fit; it did not fix
  where the width comes from. So the frame would lay out at 86 columns while the
  status bar laid itself out at 120 (or at whatever the test process reported,
  which is nothing), and the frame then hard-clipped the overflow from the right
  — dropping PERMISSION regardless of its priority. The priority mechanism never
  got to participate. Width is now a parameter, and the frame passes its own.
  Verified in a real 86-column terminal: TOKENS and COST drop, PERMISSION stays.
- **`buildFrame` is testable at all now.** It was 456 lines inside
  `startTuiRepl`, reading width and height straight from `process.stdout` —
  which in a test process is `undefined`, so every width branch collapsed to the
  120×40 path. That is how the 0.6.1 status-bar regression passed 1148 tests.
  Width, height and `now` are parameters; the new suite renders every overlay
  branch (permission prompt, single/multi/custom question, three pickers,
  thinking, paused, images, dashboard, input selection) across six widths and
  asserts every line is exactly the terminal width.
- One extraction bug caught before release, worth recording: replacing
  `Date.now()` with the new `now` parameter also rewrote the parameter's own
  default into `now = now`, a TDZ error that only fires when the caller omits
  `now` — which the real caller does and the new tests did not. The e2e TUI test
  caught it; there is now a unit test that takes the default path.

### 中文

- **帧原语此前有五份互不一致的副本。** `stripAnsi`、`displayWidth`、`padRight`
  这几个在 `repl.mjs`、`repl-dashboard.mjs`、`activity-renderer.mjs`、
  `repl-help.mjs`、`text-layout.mjs` 各写了一遍，四种不同的 ANSI 正则。
  `repl.mjs` 与 `repl-dashboard.mjs` 只认 SGR，于是 `padRight` 返回的字符串仍
  带着 OSC 超链接与光标序列的字节，却被当作纯文本填进帧格 —— 工具输出超链接时
  （npm、pnpm 都会）转义字节就进了帧，绘制时终端会真的执行它。
  `repl-help.mjs` 按 JS 字符串长度对齐，对中文和颜色码都是错的；它只是潜在，
  因为帮助表第一列恰好全是 ASCII 命令。现在只有一份，在
  `src/repl/frame-primitives.mjs`。
- **两个差一格的错位 bug，由新测试找出。** 按单元格预算裁剪可能落在宽字符
  中间，裁剪结果比预算少一格，而没人补上那一格。于是
  `padRight("中文中文", 5)` 返回 4 格宽、`frameRow` 在内容含中文时窄一格 ——
  整行左移、边框对不齐。两处现在都补足差额。
- **状态栏此前仍在自己读 `process.stdout.columns`。** 0.6.1 修的是「装不下时
  丢哪个段」，没修宽度来自哪里。于是帧按 86 列排版、状态栏按 120 列排版
  （测试进程里干脆读不到），超出部分被帧从右边硬切 —— 不论优先级如何，
  被切掉的都是最右的 PERMISSION，优先级机制根本没参与判断。现在宽度是参数，
  帧把自己的宽度传下去。86 列真实终端确认：TOKENS 与 COST 被丢弃，PERMISSION
  保留。
- **`buildFrame` 现在才第一次可测。** 它是 `startTuiRepl` 内部的 456 行，宽高
  直读 `process.stdout` —— 测试进程里那是 `undefined`，所有宽度分支塌缩成
  120×40 一条路。0.6.1 的状态栏回归就是这么通过 1148 条测试的。宽、高、`now`
  都成了参数；新测试把每个浮层分支（权限提示、单选/多选/自定义提问、三种
  选择器、思考、暂停、图片、仪表盘、输入选区）在六个宽度下各渲染一遍，
  断言每一行恰好等于终端宽度。
- 一个在发布前被拦下的抽取错误，值得记下：把 `Date.now()` 换成新参数 `now`
  时，参数自己的默认值也被改写成了 `now = now` —— TDZ 错误，且只在调用方
  **省略** `now` 时触发，而真实调用方正是省略它、新测试却总是显式传值。
  e2e 的 TUI 测试抓到了它；现在有一条走默认值路径的单测。

## 0.6.11

0.6.10 说图片读取「未能验证」。用视觉模型（aliyun qwen3.7-plus）真跑之后发现，
那不是未验证 —— 是坏的。

### English

- **An image next to a tool_result never reached the model.** The
  openai-compatible mapper handled the `tool_result` blocks in a user message and
  then `continue`d, which discarded every remaining block in that message — and
  since 0.6.8 the image `read` produces sits exactly there. The image was intact
  in the session history with the right `mediaType` and payload, so the wiring
  looked correct end to end; it simply never entered the request. The model saw
  only `Image file: x.png (137 bytes, image/png)`, which made "supports visual
  analysis" an empty promise.
  Images now go out as their own `user` message, because OpenAI's `role: "tool"`
  messages only accept string content and cannot carry `image_url`. Verified with
  a vision model: one `read` call, no pixel-sampling through `bash`, correct
  answer straight from the image.
  The Anthropic path was already fine — it maps each block individually rather
  than dropping siblings.
- **Why 0.6.10 could not see this:** k3 is a text-only reasoning model, so its
  fallback to `bash` pixel sampling was indistinguishable from "the model cannot
  see images". Only a vision-capable model separates "not sent" from "cannot
  read". Worth remembering when a capability check comes back ambiguous — pick a
  model that can actually exercise the path.

### 中文

- **挂在 tool_result 旁边的图片从未到达模型。** openai 兼容层处理完一条 user
  消息里的 `tool_result` 块之后直接 `continue`，把该消息中剩下的块全部丢掉 ——
  而 0.6.8 起 `read` 产出的图片正好挂在那里。图片在会话历史里带着正确的
  `mediaType` 和数据完好存在，所以接线看起来端到端都对；它只是从未进入请求。
  模型看到的只有 `Image file: x.png (137 bytes, image/png)`，「可视觉分析」
  是句空话。
  图片现在作为独立的 `user` 消息发出 —— OpenAI 的 `role: "tool"` 消息只接受
  字符串 content，装不了 `image_url`。视觉模型实测确认：只调一次 `read`，
  不再用 `bash` 采样像素，直接看图给出正确答案。
  Anthropic 路径本来就没问题，它逐块映射，不会丢弃兄弟块。
- **为什么 0.6.10 没能发现：** k3 是纯文本推理模型，它退回 `bash` 采样像素的
  行为，和「模型看不了图」无法区分。只有具备视觉能力的模型才能把「没发出去」
  和「读不了」分开。能力类验收结论含糊时值得记住这一点 —— 换一个真能走通那条
  路径的模型。

## 0.6.10

第一次对 0.7.0 工具层做真实模型验收（kimi k3，全部通过 `kkcode chat` 本身驱动）。
它找到的问题和单测找到的完全不是同一类：**工具建好了、注册了、测试全绿，
但模型从不用它。**

### English

- **The five file tools and `http_request` were never announced, so the model
  never used them.** Asked to tidy a directory, it ran one `bash` call —
  `mkdir && mv && rm && tar` — and none of `move`/`copy`/`remove`/`mkdir`/
  `archive` were touched. Asked to POST to an API, it reached for `curl`. The
  cause: `src/tool/prompt/bash.txt` carries a CRITICAL tool-selection list that
  names `read`, `grep`, `glob`, `write` and `edit`, and the new tools were never
  added to it. That list is what the model actually follows.
  After adding them, the same directory task made 12 calls, all through the
  dedicated tools, zero `bash`. The same HTTP request went through
  `http_request`. This matters beyond tidiness: `bash` is precisely the path that
  skips `resolveWorkspacePath`, the protected-path list, and the egress checks —
  the reasons those tools exist at all. Unused, they protected nothing.
- **Nineteen tools had no prompt file at all** — the six new ones plus every
  `git_*` tool, `skill`, and the `task_*` query tools. A missing file is silent:
  the tool still works, it just reaches the model as one short line. All 42 now
  have one, and a test asserts every registered builtin does.
- **A denial now says what it hit.** The model received exactly
  `permission denied for tool write` — no indication that it had hit the
  protected-path list rather than an insufficient approval level, so it could
  neither explain the refusal nor propose an alternative. `evaluatePermission`
  had been returning a precise reason all along and both denial paths dropped it.
  With the reason attached, the model explained the block correctly and offered
  three workable alternatives.
- **`kkcode chat` gained `--trust`.** Headless `chat` had no way to trust a
  workspace, so every tool — including `read` — was refused in scripts and CI,
  with the only escape being to open the REPL and type `/trust`. `buildContext`
  had accepted `options.trust` all along; `chat` never passed it. `ultra` got the
  same fix back in 0.5.0.
- The bash rules now also state explicitly that `python3`/`node` one-liners for
  CSV/JSON work belong in `bash`. The plan deliberately dropped a `data_query`
  tool on the grounds that no frontier tool builds one; that only holds if the
  shell path is clearly sanctioned, or the model stalls between "do not use bash"
  and "there is no other tool".

**Verified working against the real model:** read truncation steering (it
switched to `grep` for a needle, and used `offset`/`limit` to reach line 2600 of
a 3000-line file); edit self-correction (a whitespace-mismatched anchor produced
the 84%-similarity diagnosis and it fixed the edit on the very next call, one
round); protected paths holding under YOLO; recoverable delete landing in
`.kkcode/trash`; the archive unpacking correctly with system `tar`; a 400-row CSV
aggregation whose numbers matched an independent recomputation exactly; plan mode
refusing to write.

**Not verified:** image reading. The image block reaches the message history with
the correct `mediaType` and base64 payload — the 0.6.8 wiring is sound end to end
— but k3 answered by sampling pixels through `bash` instead of looking at it,
which is what a text-only reasoning model would do. Confirming the visual path
needs a vision-capable model.

### 中文

- **五个文件工具和 `http_request` 从未被通告，所以模型从来不用它们。** 让它整理
  一个目录，它用一条 `bash` 干完 `mkdir && mv && rm && tar`，
  `move`/`copy`/`remove`/`mkdir`/`archive` 一个都没碰；让它向 API 发 POST，
  它伸手就是 `curl`。原因是 `src/tool/prompt/bash.txt` 里那份 CRITICAL 工具选择
  清单只列了 `read`、`grep`、`glob`、`write`、`edit`，新工具从没被加进去 ——
  而模型实际遵循的是那份清单。
  补上之后，同一个整理任务变成 12 次调用、全部走专用工具、`bash` 零调用；
  同一个 HTTP 请求走了 `http_request`。这件事的分量不在整齐：`bash` 恰恰就是
  绕过 `resolveWorkspacePath`、保护路径清单和出网校验的那条路 —— 也就是这些
  工具存在的全部理由。没人用，它们就什么也没保护到。
- **十九个工具根本没有 prompt 文件** —— 六个新工具，加上全部 `git_*`、`skill`
  和 `task_*` 查询工具。缺文件是静默的：工具照样能用，只是在模型眼里只剩一行
  短描述。现在 42 个工具全部有了，并有测试断言每个内置工具都必须有。
- **拒绝现在会说清撞了什么。** 模型收到的原文只有
  `permission denied for tool write` —— 它无从判断自己撞的是保护路径清单还是
  档位不够，既没法解释也没法换做法。`evaluatePermission` 一直在返回精确的理由，
  而两条拒绝路径都把它丢掉了。带上理由之后，模型准确解释了拦截原因并给出三个
  可行替代方案。
- **`kkcode chat` 补上了 `--trust`。** 无头 `chat` 此前完全没法信任工作区，
  于是脚本与 CI 里所有工具（包括 `read`）一律被拒，唯一出路是开 REPL 手敲
  `/trust`。`buildContext` 一直接受 `options.trust`，只是 `chat` 从不传 ——
  `ultra` 在 0.5.0 就修过同一个缺口。
- bash 规则里也明确写上了：CSV/JSON 这类数据处理的 `python3`/`node` 一行流
  就该走 `bash`。计划有意不做 `data_query`（理由是没有一家前沿工具内置它），
  但这个结论成立的前提是 shell 那条路被明确许可，否则模型会卡在「不许用 bash」
  和「没有别的工具」之间。

**真模型验证通过的**：读取截断的引导作用（找一个特征串时它改用 `grep`，
需要精确区间时用 `offset`/`limit` 直取 3000 行文件的第 2600 行）；编辑自纠
（缩进不匹配的锚点触发 84% 相似度诊断，它**下一次调用就改对了**，一轮完成）；
YOLO 档下保护路径依然拦住；可恢复删除确实进了 `.kkcode/trash`；归档能被系统
`tar` 正常解开；400 行 CSV 的聚合结果与独立复算逐项吻合；plan 档拒绝写入。

**未能验证的**：图片读取。图片块带着正确的 `mediaType` 与 base64 进入了消息
历史 —— 0.6.8 的接线端到端是通的 —— 但 k3 是通过 `bash` 采样像素来回答的，
而不是去看那张图，这符合一个纯文本推理模型的行为。要确认视觉链路需要一个
具备视觉能力的模型。

## 0.6.9

0.7.0 计划的最后一条（阶段 2-5 的降级半边）。

### English

- **An external change elsewhere in a file no longer kills an unambiguous edit.**
  kkcode is multi-agent by design: another agent, or your editor, touching the
  far end of a file used to reject the whole edit, leaving the model to re-read
  everything and try again. Claude Code added this downgrade in v2.1.208 for the
  same reason — the false-rejection rate is high when several agents share a
  workspace. The edit is applied and the model is told the file changed.
- **Three conditions, all required, because two are not enough.** The anchor must
  match exactly once in the new content, exactly once in the content that was
  read, *and* the line it spans must be byte-identical in both. That third
  condition is not decoration: an anchor of `const a = 1` matches exactly once in
  a file an external change turned into `const a = 10` — one occurrence, but no
  longer the same token, and the replacement would silently produce
  `const a = 20` with the model none the wiser. An existing test caught this
  while the weaker two-condition version was in the tree; both the dangerous case
  and a same-line comment edit are now pinned down.
- `write`, `patch` and `notebookedit` keep failing hard, deliberately: a
  whole-file replacement would swallow the external change, and a line range no
  longer points where it did. Neither has an anchor whose survival could be
  checked. `replace_all` also keeps failing hard, since its anchor is expected to
  match many times.

### 中文

- **文件另一头被外部改动，不再连带否掉一次无歧义的编辑。** kkcode 本来就是
  多 agent 的：另一个 agent 或你的编辑器碰一下文件另一端，此前会让整次编辑
  被拒，模型只能重读全文再来一遍。Claude Code 在 v2.1.208 加这个降级是同一个
  理由 —— 多个 agent 共用工作区时，误杀率很高。现在编辑照做，并明确告诉模型
  文件变过了。
- **三个条件同时成立才放行，因为两个不够。** 锚点必须在新内容里精确且唯一
  匹配、在读到的旧内容里也精确且唯一匹配，**并且**它所跨的整行在新旧内容里
  逐字节相同。第三条不是装饰：锚点 `const a = 1` 在被外部改成 `const a = 10`
  的文件里确实只匹配一次 —— 一处，但已经不是同一个 token 了，替换会静默产出
  `const a = 20`，而模型毫不知情。这是仓库里一条既有测试在弱版本（只有两个
  条件）还在树上时抓到的；现在这个危险场景和「同一行加个注释」都被固化成了
  测试。
- `write`、`patch`、`notebookedit` 有意保持硬失败：整文件替换会吞掉外部改动，
  而行号区间早已不指向原处 —— 两者都没有可供验证存活的锚点。`replace_all`
  同样保持硬失败，因为它的锚点本就应当命中多处。

## 0.6.8

阶段 2 的三条遗留 —— 0.6.5 交付了编辑诊断与 multiedit 修复，但计划里同阶段的
另外三项（全文回灌、图片读取、PDF 提取）当时没做完，这一版补齐。

### English

- **Reading an image now actually shows the model the image.** `read` returned a
  base64 data URI and `makeToolResult`'s field whitelist dropped it, so the model
  received one line — `Image file: x.png (12345 bytes)` — while the tool
  description promised visual analysis. The provider layers had supported
  `{type: "image", data, mediaType}` blocks all along; the missing piece was
  these three hops. The image is now attached after its `tool_result` block,
  which is the only shape both Anthropic and OpenAI accept, and the text line
  stays for models without vision.
- **PDF extraction works on real PDFs.** The old code decoded the whole file as
  latin1 and regexed for parenthesized strings — which finds parentheses that
  happen to occur inside compressed bytes, and returns them as prose. Content
  streams are FlateDecode by default, meaning it failed on essentially every
  modern PDF. Streams are now inflated with `node:zlib` first, and text comes
  only from the `Tj`/`TJ`/`'`/`"` show operators. Scanned PDFs say they are
  scanned instead of returning binary. No new dependency.
- **`pages` does something.** It was declared in the schema and never read. It
  now filters, and says outright that content streams do not map 1:1 to pages
  rather than implying a precision it cannot deliver.
- **A failed edit re-injects the file when it is small.** Cline's approach: the
  most common reason an edit fails is that the model's copy is stale, and window
  evidence only lets it infer that. Files up to 400 lines come back in full,
  marked as authoritative; larger ones get a concrete `offset=N, limit=60`
  instead of a vague suggestion to re-read.
- **A Windows lock bug that cost this release.** `acquireAuditLock` treated
  anything other than `EEXIST` as fatal, but Windows reports a held lock as
  **`EPERM`** when another process has the file open (and `EBUSY`/`EACCES` when
  an unlink is in flight). So several kkcode processes writing audit entries
  concurrently would crash on Windows instead of retrying — and audit-chain
  reliability is the entire reason that lock exists. It surfaced as a
  nondeterministic test failure that blocked the 0.6.7 release. The assertion is
  now in the unit test and fails on Linux too; relying on a Windows runner to
  hit a race is not a test.
- `removeStaleAuditLock` no longer reports success when `unlink` fails with
  `EPERM` — that turned the caller's retry into a busy loop.

### 中文

- **读图片现在真的把图给模型看了。** `read` 返回的是 base64 data URI，而
  `makeToolResult` 的字段白名单把它丢掉了，于是模型只收到一行
  `Image file: x.png (12345 bytes)` —— 而工具描述承诺「可视觉分析」。
  provider 层（anthropic.mjs / openai.mjs）一直支持
  `{type:"image", data, mediaType}` 块，缺的只是中间这三跳。图片现在挂在它
  对应的 `tool_result` 之后 —— 这是 Anthropic 与 OpenAI 都接受的唯一形状 ——
  文本说明保留，供不支持视觉的模型使用。
- **PDF 提取对真实 PDF 有效了。** 旧代码把整个文件按 latin1 解码后正则抓
  括号内的字符串，抓到的是压缩字节里偶然出现的括号，然后当正文吐出来。
  内容流默认是 FlateDecode，也就是说它对**几乎所有现代 PDF 都失效**。
  现在先用 `node:zlib` 解压流，再只从 `Tj`/`TJ`/`'`/`"` 这几个显示操作符里
  取文本。扫描版 PDF 会说自己是扫描件，而不是返回二进制。不引入新依赖。
- **`pages` 参数开始起作用了。** 它在 schema 里声明了，代码从头到尾没读过。
  现在会真的过滤，并明说内容流与页面不是一一对应 —— 而不是暗示一个它给不了
  的精度。
- **编辑失败时小文件回灌全文。** 抄 Cline 的做法：编辑失败最常见的根因是
  模型手里的副本已经过期，而窗口式证据只能让它推断这一点。400 行以内的文件
  整份回传并标注「这是权威版本」；更大的文件给出具体的 `offset=N, limit=60`，
  而不是一句含糊的「重读一下」。
- **一个卡住了本次发布的 Windows 锁 bug。** `acquireAuditLock` 把除
  `EEXIST` 以外的错误一律当致命错抛出，但 Windows 在文件被其他进程持有打开
  句柄时报的是 **`EPERM`**（并发 unlink 进行中时还可能是 `EBUSY`/`EACCES`）。
  于是多个 kkcode 进程同时写审计日志时，Windows 上会崩而不是重试 ——
  而审计链的可靠性正是这个锁存在的全部理由。它表现为一次非确定性的测试失败，
  卡住了 0.6.7 的发布。现在断言写在单元测试里、在 Linux 上也会红：
  指望 Windows runner 去撞上一个竞态，那不叫测试。
- `removeStaleAuditLock` 在 `unlink` 因 `EPERM` 失败时不再报告成功 ——
  那会让调用方的重试变成忙循环。

## 0.6.7

### English

- **`webfetch` could read your internal network.** The old check was a string
  prefix test for `http://`, so `http://127.0.0.1:PORT/admin` returned the
  response body verbatim — verified against a live local server, not inferred.
  The 0.7.0 plan said `http_request` would "reuse the existing egress checks";
  there were none. Now loopback, private ranges, carrier-grade NAT,
  IPv4-mapped IPv6 and URL-embedded credentials are all refused, and cloud
  metadata endpoints (`169.254.169.254` and friends) are refused unconditionally
  — what they return is instance credentials, not data. Redirects are followed
  manually and re-checked at every hop, because validating only the first URL is
  the same as not validating. Set `tool.http.allow_private_hosts: true` to reach
  local services on purpose.
- **`http_request`**: methods, headers, and bodies, for APIs that need more than
  a GET. Header names that fail the RFC 7230 token rule are dropped and CR/LF is
  stripped from values, since either one opens request smuggling.
- **Five file-management tools that did not exist: `move`, `copy`, `remove`,
  `mkdir`, `archive`.** "Tidy up this directory" was previously impossible — the
  model had to fall back to `bash`, which is exactly the path that bypasses
  `resolveWorkspacePath`. These go through it, including the symlink-escape
  check, and they refuse protected paths, so tidying a directory cannot install
  a pre-commit hook. `remove` moves to `.kkcode/trash` by default rather than
  unlinking: deleting the wrong file is the least reversible step in everyday
  cleanup, and repeated deletes of the same name no longer overwrite each other
  in the trash. `archive` writes a real ustar tarball with no new dependency.
- **A sixth gate that actually runs the thing: `smoke`.** The five existing
  gates are all static. `npm run build` exiting 0 means it compiled; `npm test`
  passing means the covered paths still work. Neither catches "compiles fine,
  crashes on startup" — the failure mode you get from editing an entry point,
  changing the import graph, or deleting an export something still imports,
  which is precisely what an agent does most. It discovers the entry point from
  `package.json` (`bin` → `--version`, or `main` → one import) and reports
  `not_applicable` when it cannot, because a gate that guesses at a start
  command manufactures false failures in other people's projects. A crash
  signature outweighs a zero exit code, since a process can print
  `ERR_MODULE_NOT_FOUND` and still exit 0.
- **Gate results now reach the report.** They were being stored in the ledger
  and never read — so "all six gates green" existed only in the logs, with no
  way for a reader of the report to confirm it. Both the terminal and Markdown
  renderers now show each gate, and the smoke gate's runtime evidence gets its
  own section: the other five answer "it looks unbroken", this one answers "it
  ran, and here is how".
- **A self-healing check had silently stopped working.** `isAccidentalAllFalse`
  detects the 0.4.x accident where an empty answer disabled every gate
  permanently. It tested `GATE_NAMES.every(g => prefs[g] === false)` — so adding
  `smoke` broke it for exactly the records it existed to rescue, since a 0.4.x
  record has five keys and `prefs.smoke` is `undefined`, not `false`. It now
  keys off the gates present in the record. Three other places hard-coded the
  same five-gate list; all now derive from `GATE_NAMES`.
- The smoke gate's library-entry check builds a `file://` URL. A bare Windows
  path is not a valid ESM specifier — `C:` parses as a URL scheme — so the check
  would have failed on every Windows library project. The release gate caught it
  (5/6 green, tag not pushed). This class of defect has now appeared three times
  in this repository, so the assertion lives in the unit test and fails on Linux
  too, rather than waiting for a Windows runner.
- `runGateCommand` moved to `src/session/gate-command.mjs`. The smoke gate needs
  it and `runUsabilityGates` needs the smoke gate — ESM function hoisting makes
  that cycle work by accident, and it breaks the moment someone adds a
  module-level `const`, far from where the error surfaces.

### 中文

- **`webfetch` 能读到你的内网。** 旧检查只是对 `http://` 做字符串前缀判断，
  于是 `http://127.0.0.1:PORT/admin` 的响应体会被原样返回 —— 这是对着一个
  真实的本地服务实测出来的，不是推断。0.7.0 的计划里写「`http_request` 复用
  现有出网校验」，而那样的校验并不存在。现在回环、内网段、运营商级 NAT、
  IPv4-mapped IPv6、URL 内嵌凭证一律拒绝，云元数据端点
  （`169.254.169.254` 等）**无条件**拒绝 —— 它返回的是实例凭证，不是数据。
  重定向改为手动跟随并逐跳复检，因为只校验第一个 URL 等于没校验。
  确实要访问本地服务时写 `tool.http.allow_private_hosts: true`。
- **`http_request`**：支持 method、headers、body，给那些不止一个 GET 的 API。
  头名不符合 RFC 7230 token 规则的直接丢弃，头值里的 CR/LF 清掉 ——
  这两样任何一个都能撑开请求走私。
- **五个此前根本不存在的文件管理工具：`move`、`copy`、`remove`、`mkdir`、
  `archive`。** 「整理一下这个目录」以前在物理上做不到，模型只能退回 `bash`，
  而那恰好是绕过 `resolveWorkspacePath` 的那条路。这些工具都过它，包含
  symlink 逃逸检查，并且拒绝受保护路径 —— 整理目录不该能装上 pre-commit
  钩子。`remove` 默认移入 `.kkcode/trash` 而非 unlink：删错文件是日常整理里
  最不可逆的一步；同名文件重复删除也不会在回收站里互相覆盖。`archive` 生成
  真正的 ustar tarball，不引入新依赖。
- **第六道门禁，而且它真的把东西跑起来：`smoke`。** 现有五道全是静态检查。
  `npm run build` 退出 0 只说明编译通过，`npm test` 通过只说明覆盖到的路径
  没坏 —— 两者都接不住「编译过了但一启动就崩」，而那正是改入口文件、改
  import 图、删掉还有人引用的导出时的典型失败，也正是 agent 最常做的改动。
  它从 `package.json` 发现入口（`bin` → `--version`，或 `main` → import 一次），
  发现不了就报 `not_applicable` —— 一个乱猜启动命令的门禁会在别人的项目里
  制造假失败。崩溃签名优先于退出码：一个进程可以打印 `ERR_MODULE_NOT_FOUND`
  之后仍以 0 退出。
- **门禁结果终于进入报告。** 它们一直存在 ledger 里却从未被读取 ——
  于是「六道门禁全绿」这个结论只存在于日志中，报告读者无从确认。现在终端与
  Markdown 两个渲染器都会逐条显示，smoke 的运行时证据独立成段：其余五道回答
  的是「看起来没坏」，这一段回答的是「真的跑起来了，而且是这么跑的」。
- **一个自愈检查已经静默失效了。** `isAccidentalAllFalse` 负责识别 0.4.x 那个
  「空答案永久关掉所有门禁」的事故，它的判定是
  `GATE_NAMES.every(g => prefs[g] === false)` —— 加入 `smoke` 之后，它对
  自己本来要救的那类记录**恰好失效了**：0.4.x 的记录只有五个键，
  `prefs.smoke` 是 `undefined` 而不是 `false`。现在按记录里实际出现的门禁键
  判定。另有三处也硬编码了同一份五门禁清单，全部改为从 `GATE_NAMES` 推导。
- smoke 门禁的库入口检查改为构造 `file://` URL。裸 Windows 路径不是合法的
  ESM specifier（`C:` 会被解析成 URL scheme），这道检查本会在**每一个**
  Windows 库项目上假失败。发布门槛拦住了它（5/6 绿，tag 未推）。这类缺陷在
  本仓已出现三次，所以断言写进了单元测试、在 Linux 上也会红，不再等
  Windows runner 去发现。
- `runGateCommand` 移到 `src/session/gate-command.mjs`。smoke 门禁要用它，而
  `runUsabilityGates` 要用 smoke 门禁 —— ESM 的函数提升让这个循环恰好能跑，
  但谁在里面加一个模块级 `const` 就会炸，而炸的现场离原因很远。

**关于计划的一处修正**：计划里把 `http_request` 的出网校验写成「复用现有的」，
实际上一条都没有，所以这道闸是新增工具的**前置条件**而非配套增强 ——
带任意 method 与 body 的 `http_request` 会把「能读内网」放大成「能对内网服务
发 POST」。另外计划中的 `data_query` 按调研结论不做：没有一家前沿工具内置
数据处理，而 kkcode 做不了的根因（bash 输出被砍到 3000 字符）已在阶段 1 修掉。

## 0.6.6

### English

- **Protected paths, checked before your own allow rules.** Writes to `.git/`,
  `.kkcode/`, `.github/workflows/`, every shell rc (`.bashrc`, `.zshrc`,
  `.envrc`), package-manager configs (`.npmrc`, `.yarnrc`, `bunfig.toml`) and
  `.mcp.json` now always require confirmation — yolo included. These are the
  one class of change git cannot undo for you: break `.git` and the snapshot
  system that would have saved you is gone with it.
  The ordering is the security property. The check runs *before* `permission.
  rules` is evaluated, so a checked-in `{tool: "write", pattern: ".git/**",
  action: "allow"}` cannot switch it off — and that rule might have arrived in
  a repository you just cloned. `bash` is covered too, by scanning commands
  that look like writes; `cat ~/.bashrc` and `.gitignore` are deliberately not
  caught.
- **Long-running commands can finally go to the background.** The foreground
  block told the model "or use `run_in_background: true`" — and the background
  branch blocked the same commands again. The one escape hatch the tool
  documented did not exist. Now background accepts them, which is what
  background is for.
- **Thirteen git tools were unregistered, not restricted.** `TOOL_CAPABILITIES`
  covered 24 tools; every `git_*` tool, `task_group` and `task_parallel` fell
  through to `"unknown"`, which readonly denies wholesale and accept-edits asks
  about wholesale. `git_status` was denied in the readonly tier while
  `TRUSTED_BASH_PATTERNS` and exec-policy's `allow_git_status` both called it
  safe — three layers disagreeing about the same command. Read-only shell is
  now allowed in the readonly tier, which is what "readonly" should have meant.
- **`/plan` had no execution-layer gate.** It set `state.mode = "plan"` and
  injected a "do not edit source files" instruction, but the gate keyed off
  `_planMode`, which only the model's own `enter_plan` call ever set. Plan mode's
  entire binding force was the model choosing to comply. The gate now derives
  from the declared mode, and from tool capability rather than a hand-written
  list — that list had been missing `sysinfo`, `question`, `task_list` and
  `git_status`, all pure reads, blocked precisely when you are surveying a
  repository to plan against it.
- **`sensitive_file_patterns` merges instead of replacing.** Adding one pattern
  to protect `secrets/**` used to delete the protection for `.env` and five
  others, silently. Wanting one more should not cost you six. Pass
  `sensitive_file_patterns_replace: true` to actually drop the defaults.
  Both this and `skills.allowed_commands` were absent from
  `docs/config.example.yaml`; both are documented now.
- **`bash` reports exit codes and accepts `cwd` and `env`.** The exit code was
  swallowed by the catch block, so the model could not tell a failed command
  from one that succeeded while writing progress to stderr — which npm, pip and
  git all do. `cwd` is resolved through the workspace boundary, so `cwd: "../.."`
  cannot relocate the root that every later path check depends on. A third
  hard-coded output cap (30000 chars, missed in 0.6.4) now follows the model's
  context budget and says how to get the rest.
- **`git_apply_patch` checks the diff's target paths.** `git apply` refuses
  `.git/**` and `../` escapes on its own — verified, not assumed — but it will
  happily create a repo-local `.bashrc` or `.github/workflows/ci.yml`, and this
  tool never passes a path through `evaluatePermission`, so the protected-path
  list could not see them. One diff was enough to install a pre-commit hook.

### 中文

- **保护路径清单，且排在你自己的 allow 规则之前。** `.git/`、`.kkcode/`、
  `.github/workflows/`、全套 shell rc（`.bashrc`/`.zshrc`/`.envrc`）、包管理器
  配置（`.npmrc`/`.yarnrc`/`bunfig.toml`）、`.mcp.json` 的写入一律需要确认，
  yolo 也不例外。这是唯一一类 git 帮不了你的改动 —— `.git` 被改坏，本该救你的
  快照系统跟着一起没了。
  **顺序本身就是安全属性**：检查排在 `permission.rules` 求值之前，所以仓库里
  checked-in 的一条 `{tool: "write", pattern: ".git/**", action: "allow"}`
  关不掉它 —— 而那条规则可能来自你刚 clone 的别人的仓库。`bash` 同样覆盖，
  按"像在写"的命令特征扫描；`cat ~/.bashrc` 与 `.gitignore` 有意不拦。
- **长命令终于能进后台了。** 前台拦截的提示原文是「或者用
  `run_in_background: true`」，而后台分支把同一批命令又拦了一遍 —— 工具文档
  承诺的唯一逃生口在代码里不存在。现在后台接收它们，后台本来就是干这个的。
- **十三个 git 工具是漏登记，不是被限制。** `TOOL_CAPABILITIES` 只覆盖 24 个
  工具，全部 `git_*`、`task_group`、`task_parallel` 落到 `"unknown"` ——
  只读档一律拒、接受编辑档一律问。`git status` 在只读档被拒，而
  `TRUSTED_BASH_PATTERNS` 与 exec-policy 的 `allow_git_status` 都判它安全，
  三层对同一条命令的判定互相矛盾。现在只读 shell 在只读档放行，这才是
  「只读」该有的意思。
- **`/plan` 在执行层没有闸门。** 它设了 `state.mode = "plan"` 并注入一段
  「请勿修改源文件」的提示，但闸门认的是 `_planMode`，而那个只有模型自愿调
  `enter_plan` 才会被设 —— plan 模式的全部约束力来自模型听不听话。现在闸门
  从声明的 mode 推导，判定依据从手写名单改为工具能力：那份名单漏了
  `sysinfo`、`question`、`task_list`、`git_status`，全是纯读，偏偏在你勘察
  仓库准备制定计划时被拦。
- **`sensitive_file_patterns` 改为合并而非替换。** 此前为了保护 `secrets/**`
  加一条模式，会静默删掉 `.env` 等六条内置保护 —— 想加一条不该赔上六条。
  真要丢掉默认值，写 `sensitive_file_patterns_replace: true`。这一项与
  `skills.allowed_commands` 都从未出现在 `docs/config.example.yaml` 里，
  现在都补上了。
- **`bash` 上报 exit code，并支持 `cwd` 与 `env`。** exit code 此前被 catch
  整个吞掉，模型无法区分「命令失败」与「命令成功但往 stderr 写了进度」——
  后者在 npm、pip、git 里天天发生。`cwd` 过工作区边界解析，`cwd: "../.."`
  不能把后续所有路径判定所依赖的根挪走。第三处硬编码输出上限（30000 字符，
  0.6.4 漏掉的）改为跟随模型上下文预算，并说明怎么取剩下的部分。
- **`git_apply_patch` 检查 diff 的目标路径。** `git apply` 自己会拒
  `.git/**` 与 `../` 逃逸 —— 这是实测确认的，不是假设 —— 但它照样会凭空创建
  仓库内的 `.bashrc` 或 `.github/workflows/ci.yml`，而本工具从不带路径走
  `evaluatePermission`，保护清单看不到它们。一个 diff 就足够装上 pre-commit 钩子。

**关于计划的两处修正**：0.7.0 计划里写 `git_restore` 绕过路径校验 —— 它只吃
`snapshot_id`，没有路径入参，没有可校验的东西，这条不成立。另一条写
`git_apply_patch` 绕过路径校验，实测后发现只对了一半：路径遍历与 `.git` 写入
是 `git apply` 自己拦住的，真正漏的是仓库内的受保护文件。

## 0.6.5

### English

- **`multiedit` was silently dropping changes.** Every change computed its
  result from `snapshot.original` — the content as it was *before* the batch —
  so when the same file appeared twice, the second change overwrote the first.
  The tool reported `2 file(s) updated atomically` and produced two diffs that
  both claimed success, while only half the edit reached disk. That is the
  hardest kind of data loss to notice: nothing fails.
  Changes now accumulate through a working copy. If a later change's anchor was
  removed by an earlier one in the same batch — which the pre-flight check
  cannot see, since it validates against the original content — the whole batch
  rolls back and says so, rather than producing a half-applied file.
- **`edit` explains itself when it finds nothing.** It used to return two words:
  `no match`. The only move left to the model was re-reading the whole file and
  guessing again — the most expensive self-correction path there is. It now
  reports the file length, your snippet's size, the similarity of the closest
  block with its line number, that block with line numbers, and the surrounding
  window. When the difference is only whitespace it says so outright, which is
  the most common cause by far.
  Matching stays exact. A proportion guard is in place for the day loose
  matching arrives, because the dangerous failure there is not "no match" —
  which errors and can be recovered — but matching a much larger span and
  swallowing it silently.

**Note on 0.6.4:** the edit diagnosis code shipped in 0.6.4 without being
mentioned in its changelog. A background release ran `git add -A` while this
work was still in progress, so the commit captured it. It passed all six checks
on every platform, but its tests only arrive here — a release should contain
what its changelog says it contains, and that one did not.

### 中文

- **`multiedit` 在静默丢改动。** 每个 change 都从 `snapshot.original`（批次
  **之前**的内容）算起，于是同一文件出现两次时，第二个 change 覆盖掉第一个。
  工具报告 `2 file(s) updated atomically` 并给出两份都声称成功的 diff，而磁盘
  上只落了一半 —— 这是最难发现的一类数据丢失：什么都没有失败。
  改动现在通过一份工作副本逐个叠加。若后一个 change 的锚点已被同批次的前一个
  改掉（预检基于原始内容，看不到这种批次内相互作用），整批回滚并明说原因，
  而不是产出一个改了一半的文件。
- **`edit` 找不到时会解释自己。** 它此前只返回两个词 `no match`，模型唯一能做
  的是重读整个文件再猜一次 —— 最贵的自我纠正路径。现在给出文件行数、你的片段
  规模、最接近块的相似度与起始行号、带行号的该块、以及周边窗口。差异只在空白
  时直接说出来 —— 那是最常见的失配原因。
  匹配仍然是精确的。不成比例守卫已就位，为将来引入宽松匹配预备：那时危险的
  失败不是「匹配不到」（会报错、可恢复），而是匹配到一个大得多的块然后静默
  吞掉它。

**关于 0.6.4：** 编辑诊断的代码随 0.6.4 发布了，但没写进它的更新日志 ——
后台发布任务的 `git add -A` 在这项工作还没完成时把它收走了。它在六个平台的
检查全都通过，但测试直到这一版才补上。一个版本应当包含它的更新日志所说的内容，
那一版没做到。

## 0.6.4

### English

- **Tool output was capped at 3000 characters, and truncation was silent.** A
  268-line source file is 12494 characters, so the model saw a quarter of any
  ordinary file — and read's 2000-line limit had never once taken effect,
  because the real ceiling was 1/25 of it. Against peers that is one to two
  orders of magnitude low: opencode caps at 50 KB, Codex at 1 MiB of shell
  output, Claude Code at roughly 100 KB.
  The budget now derives from the active model's context window instead of a
  frozen number: k3 gets 35840 characters, gpt-5 76160, a 64K model 17920.
  Floor 16000 so reading one ordinary file always fits; ceiling 200000 so one
  call cannot dominate the context and drag compaction forward.
  This is not "remove the limits" — a line cap is what every peer does and it
  is deliberate; Anthropic's own guidance is that truncation should steer the
  agent toward more targeted retrieval. What was missing is that ours never
  said so.
- **Every read now reports its own state**: `[complete: 340 lines]`, or
  `[truncated: showing 2000 of 3000 lines, 1000 remaining. Use read with
  offset=2001 to continue.]`. Silence was the worse half: a read of a 3000-line
  file stopped dead at line 2000 with no footer, so a quarter of a file passed
  for the whole thing — and it was separately marked a partial view, which then
  failed the model's later write for a reason it could not see.
- read also gains a 50 KB byte cap (line and per-line caps cannot stop a
  minified file), a size check before loading (nothing stopped a 2 GB file from
  going straight into memory), binary detection (a `.so` read as UTF-8 filled
  the context with replacement characters), and an error instead of a silent
  empty string for an out-of-range offset. The read-state cache now stores what
  the model actually saw rather than the untruncated original — that mismatch
  made edits against a truncated line fail with no way to work out why.
- **`BUILTIN_CONTEXT` gains the kimi family.** `k3` was falling through to the
  128000 default when it is a 1M model, so compaction fired eight times too
  early. Long prefixes are now ordered ahead of short ones, since the lookup
  walks in declaration order and `k3` would otherwise swallow `k3-256k`.

### 中文

- **工具输出被砍到 3000 字符，而且截断不发声。** 一个 268 行的源文件有 12494
  字符，模型只能看到普通文件的四分之一 —— 而 read 那个 2000 行的上限**从未
  生效过**，真正的天花板是它的 1/25。对比同行低了一到两个数量级：opencode
  50KB、Codex 1MiB shell 输出、Claude Code 约 100KB。
  预算现在按当前模型的上下文推算而非写死：k3 得 35840 字符、gpt-5 得 76160、
  64K 模型得 17920。下限 16000 保证读一个普通文件总能读全；上限 200000 防止
  单次调用主导上下文、把压缩提前拖来。
  这不是「取消上限」—— 行数上限是同行共识且刻意为之，Anthropic 自己的指导是
  截断应当把 agent 引向更精确的检索。我们缺的从来是「说出来」。
- **每次读取都自报状态**：`[complete: 340 lines]`，或 `[truncated: showing
  2000 of 3000 lines, 1000 remaining. Use read with offset=2001 to continue.]`。
  沉默是这个缺陷更糟的那一半：读 3000 行的文件在第 2000 行戛然而止、没有任何
  footer，四分之一就当成了全文 —— 而且它还被单独标记成部分读取，导致模型后续
  的写入失败，且它看不出原因。
- read 另补：50KB 字节帽（行数与单行上限都拦不住 minified 文件）、加载前的
  大小预检（此前没有任何东西阻止一个 2GB 文件直接进内存）、二进制探测（`.so`
  按 UTF-8 读会用替换字符填满上下文）、越界 offset 改为报错而非静默返回空串。
  读状态缓存现在存模型实际看到的内容而非未截断原文 —— 这个错位让「照着被截断
  的行去编辑」必然失败，且无从判断原因。
- **`BUILTIN_CONTEXT` 补上 kimi 族。** `k3` 此前落到 128000 默认值，而它是 1M
  模型 —— 压缩因此提前八倍触发。长前缀现在排在短前缀之前，因为查表按声明序
  遍历，否则 `k3` 会把 `k3-256k` 吃掉。

## 0.6.3

0.6.2 claimed to fix YOLO refusing commands. It did not — the fix landed in the
function and never reached the call sites. This release actually wires it, and
adds a check so this particular failure shape stops recurring.

### English

- **`checkBashAllowed` now receives the approval level at its call site.** The
  parameter was added in 0.6.2 but `src/tool/registry.mjs` still called it with
  two arguments, so the internal check read `undefined` and every tier behaved
  like the strictest one. The tests passed because they called the function
  directly and supplied the level themselves — the exact blind spot the fix was
  supposed to close.
  A new end-to-end assertion exercises the bash tool rather than the function,
  which is the only way to prove that turning on YOLO actually lets a commit
  through.
- **`write_scope: read-only` blocks `bash`.** The 0.6.2 check tested
  `["write","edit"].includes(capability)`, and `toolCapability` never returns
  `"write"` — half the condition was dead, and the half that worked missed the
  hole that mattered: bash reports as `risky-shell`, so a read-only subagent
  could still reshape the workspace through a shell. It now asks whether the
  call can mutate the workspace at all, defaulting to yes for anything not
  explicitly known to be read-only, with bash judged per command against the
  existing trusted-read-only patterns.
- **`test/wiring-contract.test.mjs`** scans for this failure shape: a security
  parameter that exists in a signature but is missing at a call site, and a
  comparison against a capability string the producing function can never
  return. Four defects in this repository have had exactly that shape
  (`setTrusted` in the background worker, and both of the above). Verified by
  reverting the fix and watching the check go red. Deliberate omissions are
  exempted by stating the reason next to the call — the criterion verifier
  omits the approval level on purpose, since a criterion that commits is a bad
  criterion regardless of which tier the user selected.

### 中文

- **`checkBashAllowed` 在调用点终于收到了审批档。** 这个参数是 0.6.2 加的，
  但 `src/tool/registry.mjs` 仍以两个实参调用，函数内部读到 `undefined`，
  于是任何档位都等同于最严格档。测试之所以全绿，是因为它们直接调函数并自己
  传档 —— 正是这个修复本该堵上的那个盲区。
  新增的端到端断言从 bash 工具而非函数出发，那是唯一能证明「用户开了 YOLO
  真的能提交」的方式。
- **`write_scope: read-only` 现在拦得住 `bash`。** 0.6.2 那版判的是
  `["write","edit"].includes(capability)`，而 `toolCapability` 从不返回
  `"write"` —— 一半条件是死值，能工作的另一半又恰好漏掉了真正要紧的口子：
  bash 的能力是 `risky-shell`，只读子智能体照样能用 shell 改工作区。现在改问
  「这次调用是否可能改动工作区」，未明确登记为只读的一律视为可能，bash 按命令
  对照既有的可信只读白名单单独判定。
- **`test/wiring-contract.test.mjs`** 专扫这一类缺陷形状：签名里有、调用点没传
  的安全参数；以及与一个永远不会被返回的能力名做比较。本仓库已有四个缺陷是这个
  形状（后台 worker 的 `setTrusted`，以及上面两条）。已用「撤销修复看它变红」
  反向验证。有意不传的情形在调用点旁写明理由即可豁免 —— 判据校验器就是有意不传，
  因为一条会提交的验收判据本身就是错的，与用户选了哪一档无关。

## 0.6.2

### English

- **YOLO was still refusing commands.** `checkBashAllowed` never looked at the
  approval level — it read only `config.git_auto` — so a mode documented as
  "every approval prompt is skipped" still denied `git commit` and `git push`.
  The level is passed in now and YOLO relaxes the `git_safety` category.
  It does not relax everything, and that distinction is the point: `rm -rf /`,
  writing to a device, formatting a filesystem, piping a download into a shell
  and privilege escalation stay forbidden at every tier. YOLO means "don't
  interrupt me", not "you may format the disk". Refusals now say which class
  they belong to, so you can tell a config flip from a genuine no.
- Writing that test exposed a real hole: the `mkfs` rule matched the bare token
  while what people actually run is `mkfs.ext4` / `mkfs.xfs`. Every variant
  slipped past. Now covered, along with `mke2fs` and the partitioners.
- **Thinking is visible while it happens** — a fixed two-line grey tail of the
  reasoning stream instead of a lone `Thinking · 5.1s`. Two lines is a hard
  constraint, not a taste call: the frame bills rows by their actual count, so
  a block that grows would make the transcript jitter with every token.
- **Writes read like a file, not a diff.** New files render with line numbers
  and syntax highlighting rather than `+` prefixes — a write is "this is what
  the file now is", and line numbers let you say "change line 57" while looking
  at the screen.
- **Thinking effort has four tiers** (low/medium/high/max, plus off), expressed
  as a proportion of the model's own output budget. Anthropic's `budget_tokens`
  was hardcoded at 10000: too timid for a 200K-context model, potentially over
  a small model's output ceiling. Model discovery reads max output tokens and
  declared capabilities from the catalog and writes them into the provider
  config, so switching models changes no numbers — the config states intent.
- **`Esc` `Esc` rewinds one conversation turn.** Said it wrong, or the model
  went sideways: back up and retry instead of pushing forward through context
  that already drifted. The withdrawn prompt returns to the composer so
  "rewind, tweak, ask again" is one step. It rewinds the conversation only —
  file changes remain, and `/undo` handles those; unwinding a sentence is
  cheap, unwinding a batch of edits is not, and one gesture should not do both.
  Two message shapes wear the `user` role without being user speech —
  compaction summaries and tool results — and treating either as a turn
  boundary would rewind half a turn or discard compacted history.
- `Ctrl+O` toggles the latest collapsed block alongside `Ctrl+E` and clicking.

### 中文

- **YOLO 档下命令仍被拒。** `checkBashAllowed` 从不看审批档，只读
  `config.git_auto` —— 于是一个说明写着「每个审批提示都跳过」的模式，
  照样拒绝 `git commit` 与 `git push`。现在传入审批档，YOLO 放开 `git_safety`。
  但不是全部放开，这个区分正是重点：清空根目录、写裸设备、格式化文件系统、
  把下载管道进 shell、提权，在任何档位都禁止。YOLO 的含义是「不要打断我」，
  不是「可以格盘」。拒绝理由会说清属于哪一类，你才知道这是改个配置就行，
  还是我们真的不做。
- 写这条测试时发现一个真实漏洞：`mkfs` 规则匹配的是裸 token，而实际用的是
  `mkfs.ext4` / `mkfs.xfs` —— 所有变体全部溜过去了。现已覆盖，连同 `mke2fs`
  与分区工具。
- **思考过程可见** —— 固定两行灰字显示推理流的尾部，取代孤零零的
  `Thinking · 5.1s`。两行是硬约束而非审美取舍：帧按块的实际行数计费，
  会变高的块会让对话区随每个 token 抖动。
- **写入读起来像文件，不像 diff。** 新建文件带行号与语法高亮，而不是 `+`
  前缀 —— 写入是「文件现在就长这样」，行号让你能对着屏幕说「第 57 行改一下」。
- **思考强度分四档**（low/medium/high/max 与 off），表达为模型自身输出预算的
  比例。Anthropic 的 `budget_tokens` 此前硬编码 10000：对 200K 上下文的模型
  太保守，对小模型又可能超出它的输出上限。模型发现会从目录读出输出上限与
  声明的能力并写回 provider 配置，于是换模型不用改任何数字 —— 配置里写的是意图。
- **连按两下 `Esc` 回溯一轮对话。** 说错了、或模型跑偏了：退回去重来，而不是
  在一段已经歪掉的上下文里继续往前顶。撤回的那句会填回输入框，「退回去改一下
  再问」是一步。只回溯对话 —— 文件改动保留，由 `/undo` 负责；退一句话很轻，
  退一批改动不轻，一个手势不该同时做两件事。有两类消息挂着 `user` 角色却不是
  用户说的话（压缩摘要与工具结果），把它们当轮次边界会退半轮或丢掉压缩历史。
- `Ctrl+O` 与 `Ctrl+E`、鼠标点击并列，都能展开最近的折叠块。

## 0.6.1

Fixes a 0.6.0 regression found by running kkcode in an actual terminal on a
Linux desktop — the first time this release had been looked at rather than
asserted about.

### English

- **The status bar dropped `PERMISSION` to make room for a token count.**
  0.6.0 added absolute tokens to the context badge (`CONTEXT 20.2K (2%)`),
  about six characters wider. At 110 columns that pushed the rightmost segment
  past the edge, and the terminal clipped it — so the badge telling you whether
  the agent can edit files without asking was the one sacrificed for a
  decorative number. At 86 columns the bar had already been overflowing before
  0.6.0.
  Segments now carry a priority and the bar drops the least important ones
  until it fits, instead of being concatenated and cut from the right in an
  order that was historical rather than meaningful. Mode and permission are
  never dropped; context survives down to 70 columns; cost, token counters and
  the memory flag go first. Verified in a real 88-column xterm.
- `renderStatusBar`'s width tiers had never been tested — it reads
  `process.stdout.columns` directly, which is undefined in a test process, so
  every assertion silently exercised the widest layout. The new tests fake the
  column count and assert the bar fits at 70/86/100/110/120/160.
- `scripts/tty-acceptance.sh`: the harness used to find this. Xvfb plus a
  window manager, a real terminal emulator, synthetic input and screenshots —
  enough to check what unit tests structurally cannot.

### 中文

- **状态栏为了给 token 数腾地方，丢掉了 `PERMISSION`。** 0.6.0 给上下文徽章
  加了绝对 token 数（`CONTEXT 20.2K (2%)`），宽了约六个字符。110 列时最右边的
  段被挤出边界、被终端硬切 —— 于是「agent 能不能不问就改文件」这个信号，为一个
  装饰性的数字让了位。而 86 列下整条状态栏在 0.6.0 之前就已经溢出。
  现在每个段带优先级，装不下时从最不重要的开始丢，而不是拼接后从右边切
  （那个顺序是历史形成的，与重要性无关）。模式与权限永不丢弃，上下文一直保留到
  70 列，成本、token 计数与内存标记最先让路。已在真实的 88 列 xterm 中验证。
- `renderStatusBar` 的宽度分档从来没被测过 —— 它直读 `process.stdout.columns`，
  测试进程里恒为 undefined，所以此前所有断言走的都是最宽的那套布局。新测试伪造
  列数，断言 70/86/100/110/120/160 各档都装得下。
- `scripts/tty-acceptance.sh`：找出这个问题的工具。Xvfb 加窗口管理器、真实终端
  模拟器、合成输入与截图 —— 足以检查单元测试在结构上就检查不到的东西。

## 0.6.0

A release about the layer you actually look at: what the terminal shows, what
subagents are doing, whether anyone asked you before starting, and whether the
context window manages itself. Most of the capability was already in the tree —
unwired, duplicated, or silent when it failed.

### English

**Subagents you can control and see.** The tools allowlist is enforced where
tools execute, not just where the list is advertised to the model; `write_scope`
blocks mutating tools instead of being prose in a prompt; `budget_usd` and
`deadline_at` abort a delegation instead of being fields nothing reads. Config
overrides merge with the registry definition rather than replacing it — setting
`agent.subagents.explore.model` used to drop explore's readonly tier and its
allowlist with it. An unknown `subagent_type` now reports the available types
instead of quietly falling back to a full-permission agent. `maxTurns`,
`temperature` and `model: "inherit"` all reach their destinations for the first
time, and `agent.prompt` is read on the production path (`buildSystemPrompt`
looked the agent up by name; the function honouring an inline prompt was only
reachable from dead code the tests happened to cover). Ultra stage tasks carry
a runSpec, so a declared subagent keeps its permission tier in parallel stages.
Delegations emit start/finish events on the parent session, `/agents` and
`/tasks` bring the CLI surface into the REPL, and delegated replies come back
as text with a metadata footer rather than JSON truncated mid-escape.

**It asks before it starts.** `planner.intake_questions` never asked anyone
anything: its prompt tells the model to answer every question with its own best
assumption. Intake now separates what it can settle from the codebase from what
genuinely belongs to the user, and routes the latter through a real prompt that
borrows its shape from the blocked-decision flow — probe for a handler at the
moment of asking, never read an empty answer as a choice, fall back to a stated
assumption with an explicit reason. Plan mode gets a Phase 1.5 that clarifies
before designing rather than after. Dead config settled: `intake_questions.
enabled` is wired, `ask_user_after_plan_frozen` finally does something, and
`intake_user_confirm` is promoted out of hiding.

**The context window manages itself.** Model discovery keeps the context length
providers already report and merges it into `provider.model_context` (explicit
config always wins); startup refreshes the catalog asynchronously. Compaction
keys on 85% utilization — the old 50-message OR threshold fired first in nearly
every long session, which made the ratio knob dead — and reports through a
toast instead of interrupting. `modelContextLimit` follows the active provider;
it read `provider.default`, which `/provider` never changes, so switching
channels mid-session skewed the limit, the status bar and the compaction
trigger together. The status bar shows absolute tokens beside the percentage,
and headless chat finally passes its context meter through.

**Terminal experience.** Four hand-drawn pickers became one overlay component —
which surfaced a defect all four shared: item rows were one character narrower
than their borders, so every box had a ragged right edge. Frame accounting now
derives from the block list instead of a parallel hand-written sum, so adding a
UI block can no longer silently miscount the transcript height. Command output
declares its channel explicitly (`/help`, `/status`, `/board`, `/agents`,
`/tasks` collapse into expandable panels instead of flooding the transcript);
the previous mechanism sniffed message text for four English verbs, so any
Chinese or multi-line output leaked into the conversation. Toasts now trigger
their own repaint — nothing subscribed to expiry, so an idle toast lingered
until the next keypress. Eight commands that were dispatchable but missing from
completion are listed, with a test that compares the two lists.

**Colors and syntax highlighting.** Markdown's palette follows the theme
instead of being a hardcoded constant; bold, italic, strikethrough, heading
levels and horizontal rules all had no color at all. User and assistant text
take their color from `theme.roles` — `item.kind` was a first-class field the
renderer never read. Fenced code blocks are syntax-highlighted across ~17
languages plus diff, line by line with no cross-line state (the stream renderer
guarantees output cannot depend on chunk boundaries) and adding only SGR
sequences, so stripping color returns the source byte for byte.

**Breaking: the 0.4.0 permission vocabulary is gone.** `permission.mode`,
`permission.default_policy` and the legacy level names (`review`, `auto`,
`edit`, `full-auto`) are now rejected rather than mapped. They are rejected
rather than ignored on purpose: a permission tier decides which tools run
without asking, and silently falling back to a default would leave someone
believing they are still locked down while they may in fact be looser. Each
error names the exact replacement, so migrating is a one-line edit —
`mode` → `level`, `default_policy: allow` → `level: accept-edits`,
`review`/`auto` → `manual`, `edit`/`full-auto` → `accept-edits`. At runtime a
legacy value that bypasses validation resolves to the default tier, never the
wider tier it used to mean. `kkcode init` was still generating
`default_policy` — a config the tool would then refuse to load.

**Internals.** The streaming and non-streaming provider paths share one
preparation step instead of each carrying a copy of settings resolution,
outbound checks, credential checks and telemetry — a security check adjusted in
one copy and not the other would have failed silently. Seven self-contained
helpers move out of `longagent-hybrid.mjs`; they were only reachable by running
a whole Ultra pipeline, so they were effectively untested, and writing their
first direct assertions corrected three wrong assumptions about their
contracts. The orchestrator function itself is untouched — splitting it needs
the run-context extraction first.

### 中文

**子智能体可控、可见。** 工具白名单在执行处强制，而不只是过滤给模型看的清单；
`write_scope` 真的拦截写工具，不再只是提示词里的一句话；`budget_usd` 与
`deadline_at` 会中止委派，不再是无人读取的字段。配置覆盖与注册表定义**合并**
而非替换 —— 此前只改一个 model 会连带丢掉 explore 的只读档与白名单。未知的
`subagent_type` 会报出可用类型，不再静默回落成全权 agent。`maxTurns`、
`temperature`、`model: "inherit"` 首次真正生效；`agent.prompt` 接上生产路径
（此前测试覆盖的是一条无人调用的死路径）。Ultra 阶段任务带上 runSpec，声明的
子智能体在并行阶段保住自己的权限档。委派会在父会话发出起止事件，`/agents`
与 `/tasks` 把 CLI 能力带进 REPL，委派结果以正文加元数据返回，不再是被从中间
截断的 JSON。

**开工前会问你。** `planner.intake_questions` 从不问任何人 —— 它的提示词要求
模型对每个问题「给出自己的最佳假设」。现在 intake 区分「能从代码里查到的」与
「只有你能定的」，后者走真实提问，收口语义沿用受阻交互那套成熟做法：提问那一
刻探测、空答案绝不当成选择、回落到明示的假设并记录原因。plan 模式新增
Phase 1.5，先澄清后设计。死配置一并清理。

**上下文自己管好。** 模型发现保留 provider 已经返回的上下文长度并合并进
`provider.model_context`（手工配置优先）；启动异步刷新目录。压缩以 85% 占用为
判据 —— 旧的 50 条消息 OR 阈值在长会话里几乎总是先撞线，让比例形同虚设 ——
并以提示条告知而不打断。`modelContextLimit` 跟随当前 provider：它此前读的是
配置默认值，而 `/provider` 切换从不改那个键。状态栏显示绝对 token 数，headless
也终于能看到上下文占用。

**终端体验。** 四个手绘选单合并为一个浮层组件，并暴露出它们共有的缺陷：项目行
比边框窄一个字符，方框右边缘一直是参差的。帧的行数记账改为由块列表推导，新增
UI 块不再可能算错对话区高度。命令输出显式声明通道（`/help`、`/status`、
`/board`、`/agents`、`/tasks` 折叠成可展开面板，不再灌进对话记录）—— 此前靠
嗅探四个英文动词，中文与多行输出一律漏网。提示条到期会自己触发重绘。八个能
执行却不在补全里的命令已补齐，并有测试比对两份清单。

**配色与语法高亮。** markdown 配色跟随主题；粗体、斜体、删除线、标题层级、
水平线此前完全没有颜色。用户与模型文本取自 `theme.roles`。围栏代码块支持
约 17 种语言加 diff 的语法高亮，逐行独立、只加颜色不改字符 —— 去掉颜色能逐字
还原源码。

**破坏性变更：0.4.0 的旧权限词汇已移除。** `permission.mode`、
`permission.default_policy` 与旧等级名（`review`、`auto`、`edit`、`full-auto`）
不再被映射，而是**报错**。选择报错而非静默忽略是有意的：权限档决定哪些工具
不经确认就能跑，悄悄回落到默认值会让人以为自己还锁着、实际可能更松。报错会
指出确切的新写法，改一行即可 —— `mode` → `level`，`default_policy: allow` →
`level: accept-edits`，`review`/`auto` → `manual`，`edit`/`full-auto` →
`accept-edits`。运行时若有旧值绕过校验，回落到默认档，绝不解析成它当年那个
更宽松的档位。`kkcode init` 此前仍在生成 `default_policy` —— 一份 kkcode
自己会拒绝加载的配置。

**内部。** provider 的流式与非流式路径共用同一段准备逻辑，不再各自持有一份
设置解析、出网校验、凭据校验与遥测 —— 只改其中一份的安全校验不会有任何报错。
七个自包含的辅助函数从 `longagent-hybrid.mjs` 抽出：它们此前只能靠跑完整条
Ultra 流水线间接覆盖，等于基本没被测过；补上第一批直接断言时纠正了我对它们
契约的三处误解。编排主体本身未动 —— 拆它需要先做 run context 抽取。

## 0.5.8

Every background subagent had been unable to use tools. This is the first
slice of the 0.6.0 work, shipped early because the defect is live.

### English

- **Background workers could not use any tool.** The worker is a separate
  process entry point, but it never called `PermissionEngine.setTrusted()` —
  and the engine's first line refuses every check when its module-level trust
  flag is false, which is its default. So each tool call raised
  `workspace not trusted`, the loop swallowed it as a tool error, the subagent
  answered from text alone, and the task was still recorded as `completed`.
  This affected every `task(run_in_background: true)` delegation and every
  parallel Ultra stage task. The same two-layer trap was fixed for
  `ultra start/resume` in 0.5.0; that fix reached the CLI entry point and
  missed this one.
  The regression test now makes the mock provider issue a real `write` call
  and asserts the file lands on disk — the previous end-to-end test only ever
  returned plain text, which is why a completely broken tool path stayed green
  through four releases. Verified by reverting the fix: the file is absent.
- Permission denials join the silent-error patterns, so a subagent that can
  only talk is reported as failed rather than completed.
- `paint()` gains an explicit color switch (`setColorEnabled`). It read
  `process.stdout.isTTY` directly, so in a test process it always returned
  plain text — meaning **color regressions were invisible to CI**: structural
  breakage turned red, wrong colors never did. Markdown's hand-written
  strikethrough now follows the same switch instead of testing the environment
  on its own.

### 中文

- **后台子智能体的工具调用全都是坏的。** worker 是独立进程入口，却从不调用
  `PermissionEngine.setTrusted()`，而权限引擎第一行就在模块级信任标志为假时
  拒绝一切检查（默认正是假）。于是每次工具调用都抛 `workspace not trusted`，
  被会话循环吞成 tool error，子智能体只能凭文本作答，任务却照样记为
  `completed`。影响每一个 `task(run_in_background: true)` 委派与全部 Ultra
  并行阶段任务。同样的两层陷阱 0.5.0 为 `ultra start/resume` 修过一次 ——
  那次补上了 CLI 入口，漏了这个。
  回归测试现在让 mock provider 发出一次真实的 `write` 调用并断言产物落盘 ——
  此前的端到端测试永远只回纯文本，所以一条完全断掉的工具链路绿了四个版本。
  已用「撤销修复」反向验证：产物确实不存在。
- 权限拒绝加入静默错误模式表，只会说话的子智能体今后报失败而不是完成。
- `paint()` 增加显式上色开关（`setColorEnabled`）。它原先直读
  `process.stdout.isTTY`，测试进程里恒返回原文 —— 意味着**配色回归在 CI 中
  完全不可见**：结构坏了会红，颜色错了不会。markdown 里手写的删除线也改为
  跟随同一个开关，不再自行判断环境。

## 0.5.7

Works through the CodeQL backlog. Three real findings fixed, seven false
positives dismissed with reasons — and the most interesting defect was one
CodeQL did not report.

### English

- **A project config file could replace the merged config's prototype.**
  YAML and JSON both turn `__proto__:` into an own enumerable property, so the
  deep merge's `out[key] = ...` hit the prototype setter instead of writing a
  key. A `.kkcode/config.yaml` in any repository you opened could therefore
  make keys absent from the defaults resolve to attacker-supplied values —
  invisibly, since they never appear as own properties and `JSON.stringify`
  does not show them. The schema does not reject unknown top-level keys, so
  nothing stopped it earlier in the chain. Global `Object.prototype` was never
  affected. Four byte-identical copies of that merge function (config loading,
  config import, the REPL, theme loading) are now one implementation in
  `src/config/merge.mjs` that skips `__proto__`, `constructor` and `prototype`
  — the same key set `config set` has guarded since 0.3.x.
- Registry lookups encode the package name with `replaceAll` instead of
  `replace`, which substitutes only the first match.
- `verify.yml` declares `permissions: contents: read`; a test matrix that runs
  third-party dependency code has no business holding the default token scope.
- Dismissed as false positives, with reasons recorded on each alert: the
  "clear-text logging" pair (both print the *name* of an api-key env var and
  a set/missing flag, never a key), the "weak password hash" pair (sha256 as a
  model-cache fingerprint, not password storage), the "bad HTML filtering"
  finding (output goes to a terminal and to JSON; the repository renders no
  HTML), the URL-substring finding (a test assertion), and the prototype
  pollution finding in `config set` (already guarded since 0.3.x; the rule
  does not recognize a `.some()` precondition).

### 中文

- **项目配置文件可以替换合并后配置对象的原型。** YAML 与 JSON 都会把
  `__proto__:` 变成自有可枚举属性，深度合并的 `out[key] = ...` 因此命中原型
  setter 而不是写入一个键。于是你打开的任意仓库里的 `.kkcode/config.yaml`
  都能让**默认配置里不存在的键**读出攻击者写的值 —— 而且无声无息：它们从不
  作为自有属性出现，`JSON.stringify` 也看不见。schema 不拦顶层未知键，链路
  上游同样没有阻挡。全局 `Object.prototype` 始终未受影响。四份逐字相同的
  合并函数（配置加载、配置导入、REPL、主题加载）现已收敛为
  `src/config/merge.mjs` 一份实现，跳过 `__proto__`、`constructor`、
  `prototype` —— 与 `config set` 自 0.3.x 起就有的守卫同一套键。
- 版本检查对包名改用 `replaceAll` 编码；字符串模式的 `replace` 只替换第一处匹配。
- `verify.yml` 声明 `permissions: contents: read`：一个会执行第三方依赖代码的
  测试矩阵没有理由持有默认的令牌权限。
- 以下告警判为误报并在每条上记录了理由：两条「明文记录敏感信息」（打印的是
  api_key 环境变量**名**与 set/missing 状态，从不打印密钥）、两条「口令哈希
  强度不足」（sha256 用作模型缓存指纹，非口令存储）、「HTML 过滤正则有缺陷」
  （输出去向是终端与 JSON，全仓无 HTML 渲染）、URL 子串校验（一条测试断言）、
  以及 `config set` 的原型污染（自 0.3.x 已有守卫，规则未识别 `.some()` 前置校验）。

## 0.5.6

Closes seven ways the tool failed without saying so. Every item here shares a
shape: the code took a wrong turn and nothing — no error, no warning, no log
line — told anyone.

### English

- **`models.ultra.*` was unusable from YAML.** The schema knew only the three
  model roles, so any config file spelling out `models.ultra` was rejected as
  an unknown role — and a rejected file is discarded *whole*, taking every
  other setting in it along. Per-stage overrides now validate (with per-stage
  key checking), and a new test asserts the invariant that broke this:
  `DEFAULT_CONFIG` must pass its own schema.
- **`agent.ultra.goal_mode` silently did nothing.** `agent.ultra` is the 0.4.0
  alias for `agent.longagent`, so goal-mode keys written there landed at a path
  nothing reads; only the counter-intuitive `agent.ultra.ultra.goal_mode`
  worked. Misplaced keys are now hoisted into the section that runs them, with
  a deprecation notice; correctly placed values still win.
- **Preflight reported OK on a discarded config.** It read
  `configState.warnings`, a field `loadConfig` never produces, while the real
  `errors` array went unread — so the check that exists to catch a broken
  config passed with exit code 0. It now fails, names the offending key, and
  says the file was ignored in full. Startup and `doctor` say so too, instead
  of calling a whole-file discard a "warning".
- **The fast channel could burn tokens forever with nothing to show.** A
  thinking-only model spends the 32-token helper budget on reasoning and
  returns empty text, so ghost text requested a completion after every typing
  pause, rendered nothing, and — by design — recorded nothing in the audit
  chain or cost stats. Three consecutive empty replies now disable that model
  for the fast channel; `preflight` surfaces it. Network failures do not count,
  and one good reply resets it.
- The Kimi preset no longer points `models.fast` at a thinking-only model; it
  ships unset with a comment showing the cross-channel form
  (`fast: aliyun/qwen3.7-flash`).
- Release gating: publishing now also verifies `package-lock.json` matches the
  tag version and that the tagged commit is an ancestor of `origin/main`, so a
  tag on a side branch cannot bypass main's checks.
- The v0.4.0 GitHub Release, lost to a failed release run, has been recreated
  from the changelog.

### 中文

- **`models.ultra.*` 在 YAML 里根本用不了。** 校验器只认三个模型角色，写出
  `models.ultra` 的配置文件会以「未知角色」被拒 —— 而被拒的文件是**整份丢弃**，
  同一文件里其他设置一并失效。现在分阶段覆盖可以通过校验（并逐个校验阶段名），
  同时新增测试锁住肇事的不变量：`DEFAULT_CONFIG` 必须通过自己的 schema。
- **`agent.ultra.goal_mode` 静默无效。** `agent.ultra` 是 0.4.0 给
  `agent.longagent` 起的别名，写在那里的 goal 模式键会落到没人读的位置，
  只有反直觉的 `agent.ultra.ultra.goal_mode` 才真正生效。现在错位的键会自动
  归位到运行时读取的段并给出弃用提示；已经写对位置的值优先。
- **Preflight 对被丢弃的配置报 OK。** 它读的是 `configState.warnings` ——
  `loadConfig` 从不产生这个字段，而真正的 `errors` 无人读取，于是专门用来
  发现配置损坏的自检以退出码 0 通过。现在会报 fail、指出出错的键、并说明
  文件已被整份忽略；启动横幅与 `doctor` 同样不再把整份丢弃称作 warning。
- **fast 通道可能长期烧 token 却什么都产不出。** thinking-only 模型会把 32
  token 的辅助预算全花在推理上、正文为空，于是 ghost text 每次打字停顿都发
  一次请求、什么都不显示，而这类调用按设计不进审计链与成本统计。现在连续
  三次空回复即停用该模型，`preflight` 会显示原因；网络失败不计入，一次正常
  回复即清零。
- Kimi 预设不再把 `models.fast` 指向 thinking-only 模型，改为留空并在注释里
  给出跨渠道写法（`fast: aliyun/qwen3.7-flash`）。
- 发布门槛加严：现在还会校验 `package-lock.json` 与 tag 版本一致、且被打
  tag 的提交必须是 `origin/main` 的祖先，杜绝在旁支上打 tag 绕过 main 的检查。
- 补建了因发布工作流失败而缺失的 v0.4.0 GitHub Release。

## 0.5.4

Makes the CI verify matrix trustworthy again — and green on every platform.

### English

- Fix the stage-objective test stat helper matching paths with forward-slash
  `endsWith` while Windows `path.resolve` produces backslashes. Seven subtests
  had been failing on the verify matrix's Windows job since 0.4.2; separators
  are now normalized before matching. Production code was never affected —
  real filesystem paths stat correctly on every platform.
- Process change: releases are now gated on the full verify matrix
  (ubuntu 22/24, windows 22, macos 22) plus CodeQL being green on the release
  commit — previous releases only watched the ubuntu-only release workflow,
  which is how the red Windows job went unnoticed across four releases.

### 中文

- 修复 stage-objective 测试的 stat 替身用正斜杠 `endsWith` 匹配路径的问题 ——
  Windows 的 `path.resolve` 产生反斜杠，导致 verify 矩阵的 Windows job 上
  七个用例自 0.4.2 起持续失败；现比较前先归一化分隔符。生产代码从未受影响，
  真实文件系统路径在各平台均正常。
- 流程变更：发布现在以发布提交上完整 verify 矩阵（ubuntu 22/24、windows 22、
  macos 22）加 CodeQL 全绿为门槛 —— 此前只盯 ubuntu 单 job 的 release 工作流，
  红着的 Windows job 因此连续四个版本无人察觉。

## 0.5.3

Settles the debts 0.5.0 left to itself: every config key it introduced now
does what it says, and three behavioural gaps found during real-model
acceptance are closed.

### English

- Wire the five 0.5.0 config keys that were shipped inert:
  `ultra.criteria.allow_shell` (criterion commands may opt into shell
  interpretation; still off by default), `ultra.report.write_markdown`,
  `ultra.ledger.enabled`, `ultra.ledger.max_rounds_kept` (round records are
  trimmed; blocker aggregation is unaffected), and `models.ultra.report`
  (summary model priority ultra.report → fast, with provider/model qualifiers).
  The board's heartbeat-stale warning now reads `heartbeat_timeout_ms` instead
  of a hardcoded 120s.
- `ultra resume` resumes on the original run's provider and model, recorded in
  the ledger — previously a session started with `--provider aliyun` silently
  resumed on the default channel.
- Silent-error detection no longer skips tasks with no planned files. The
  fallback plan's tasks have none, so a worker reply of "provider error:
  authentication failed" was recorded as completed with zero work — the exact
  vacuous-completion shape seen in real-model acceptance. Error signatures are
  now checked regardless; file-based heuristics still require planned files.
  (`ETIMEDOUT` also joins the transient error class.)
- A manual-only goal no longer surrenders after round one while executable
  work remains. Work that is unfinished — including "completed" tasks whose
  claimed artifacts are missing — keeps the loop going under the usual stall
  and budget constraints; the final status still honestly reports
  blocked_manual.
- Repeatedly failing criteria are distilled into
  `project_memory.knownPitfalls` (≤5 per run, write-only; feeding them back
  into planning stays opt-in and off by default).
- Worktree-isolated workers inherit workspace trust from the parent repo. Trust
  is keyed by path, a worktree is a new path, so in any repo whose project
  config defines a provider the supply-chain guard refused inference inside
  worktrees — every worktree task span was a vacuous no-op that the new
  silent-error detection immediately exposed. The temporary trust record is
  revoked when the worktree is cleaned up.

### 中文

- 接通 0.5.0 引入却未生效的五个配置键：`ultra.criteria.allow_shell`（判据
  命令可显式启用 shell 解释，默认仍关）、`ultra.report.write_markdown`、
  `ultra.ledger.enabled`、`ultra.ledger.max_rounds_kept`（轮次记录裁剪，
  受阻点聚合不受影响）、`models.ultra.report`（摘要模型优先级
  ultra.report → fast，支持 provider/model 跨渠道限定）。看板的心跳超时
  提示改读 `heartbeat_timeout_ms`，不再硬编码 120 秒。
- `ultra resume` 按台账里记录的原渠道与模型续跑 —— 此前用
  `--provider aliyun` 起的会话续跑时会悄悄换回默认渠道。
- 静默错误检测不再放过没有 plannedFiles 的任务。兜底计划的任务恰好都没有，
  于是 worker 回复「provider error: authentication failed」也被记成 completed
  零产物空转 —— 真实模型验收里撞见的正是这个形态。错误签名现在一律先查；
  文件类启发式仍只对声明了文件的任务生效。（`ETIMEDOUT` 同时归入瞬时错误。）
- manual-only 目标不再在第一轮就交卷：只要还有可执行的工作没做完 ——
  包括「标记完成但产物缺失」的任务 —— 循环在停滞与预算约束下继续；
  终局状态仍如实报 blocked_manual。
- 反复失败的判据提炼进 `project_memory.knownPitfalls`（每次 ≤5 条，只写
  不读；回注规划仍是默认关闭的显式开关）。
- worktree 隔离的 worker 继承父仓库的工作区信任。信任按路径哈希存储，
  worktree 是新路径 —— 项目配置里定义了 provider 的仓库，供应链防护会在
  worktree 里拒绝一切推理，每个 worktree 任务都在空转，而新的静默错误
  检测立刻揭穿了这一点。临时信任记录随 worktree 清理一并撤销。


## 0.5.2

### English

- Add `kkcode provider` — list / switch / current for configured providers,
  plus an interactive numbered picker, all persisting through the shared
  field-merging save path (contributed by @MrMark019, thanks!). The REPL's
  `/provider` grows the same picker: bare `/provider` lists everything with the
  active model and takes a number or name; the wizard now auto-switches the
  session to a provider it just configured.
- Straighten the subcommand vocabulary from the contribution before it ships:
  `add` now *adds* (opens the wizard) and picking lives on bare `/provider` —
  upstream had `add` meaning "list & switch" and `set` meaning "add", inverted
  from what anyone would type first. `set` prints a one-line pointer for one
  release. The picker also releases any `/`-prefixed input back to normal
  command handling instead of matching it as a provider name.
- Deduplicate the config write path: the wizard's field-merging
  `saveProviderConfig` is exported and shared, so the 0.5.1 fix for wiped
  `api_key`/timeouts cannot regress in a second implementation. Covered by new
  command-level tests.

### 中文

- 新增 `kkcode provider` —— 列出 / 切换 / 查看当前 provider，外加编号交互
  选择，全部经共用的逐字段合并路径写回（来自 @MrMark019 的贡献，感谢！）。
  REPL 的 `/provider` 获得同款选择器：裸 `/provider` 列出全部（带当前模型），
  输入编号或名称即切换；向导配置完成后自动把会话切到新 provider。
- 上线前把贡献里的子命令词汇归位：`add` 现在就是**添加**（打开向导），
  列出并选择归裸 `/provider` —— 上游分支里 add 是「列出切换」而 set 是
  「添加」，与任何人的第一直觉相反。`set` 保留一个版本的指路提示。
  选择模式对 `/` 开头的输入放行回正常命令处理，不再当 provider 名去匹配。
- 写回路径去重：向导的逐字段合并 `saveProviderConfig` 导出共用 ——
  0.5.1 修掉的「抹掉 api_key/超时」事故不可能在第二份实现里复活。
  新增命令级测试覆盖。


## 0.5.1

### English

- Fix the provider wizard ignoring an inline `api_key` (issue #3). Model-catalog
  discovery only checked the preset's environment variable and failed with
  "environment variable not set" even when the user had already put `api_key`
  directly in `~/.kkcode/config.yaml`. The wizard now sees the existing provider
  config: an inline key is used for discovery (with a notice), and the error
  message — shown only when neither source exists — names both ways out.
- Fix the wizard's save step wiping fields it never touched. Saving replaced the
  whole provider entry, so re-running the wizard for an existing provider erased
  the stored `api_key`, timeout tuning and models list. Entries are now merged
  per field: what the wizard set wins, everything else survives.

### 中文

- 修复 provider 向导无视内联 `api_key`（issue #3）。模型目录发现只查预设的
  环境变量，用户明明已在 `~/.kkcode/config.yaml` 里直接写了 `api_key`，向导
  仍报「环境变量未设置」。现在向导能看到现有配置：内联密钥直接用于发现
  （并有提示），两个来源都没有时错误信息会把两条出路都说清楚。
- 修复向导保存时抹掉没动过的字段。写回原先是整条目替换 —— 对已有 provider
  重跑向导会把存好的 `api_key`、超时调优、models 列表全部清掉。现在逐字段
  合并：向导设置的生效，其余原样保留。


## 0.5.0

Ultra becomes goal-driven: it keeps working while it makes progress, and
reports honestly — with evidence — the moment it stops.

### English

- **An executable definition of done.** Acceptance criteria are now structures
  the system runs — file existence, content match, command exit codes, tests,
  gates — not prose pasted into prompts. Anything that cannot be mechanised
  becomes a `manual` criterion that no code path can auto-pass: the goal parks
  at `blocked_manual` until a human answers. `[TASK_COMPLETE]` is demoted from
  verdict to self-report; alone it never yields `completed`.
- **The goal loop.** `max_rounds` defaults to unlimited; the constraint is
  evidence of progress (criteria/gate transitions, newly completed tasks, file
  changes without verbatim-repeated errors), backed by stall detection
  (2 rounds), a 2h deadline and the token budget. `goal_mode: false` restores
  the exact 0.4.x single-round behaviour.
- **Failure is triaged, not fatal.** Stage failures route through a decision
  table — retry / degrade / defer / skip / replan — instead of 0.4.x's
  "retry or abandon everything". Permanent errors no longer burn 12 hopeless
  backoff retries; a replan feeds the ledger's failure evidence back to the
  blueprint agent, capped and deduplicated by plan signature.
- **Honest reporting.** Every round is recorded in
  `.kkcode/ultra/<session>/ledger.json`; the blocked report shows each
  criterion's verdict with the twelve lines of command output 0.4.x discarded,
  attempt counts across rounds, any dropped acceptance criterion with its
  stated reason, and optional fast-model "key judgment / next steps". Rendered
  in the REPL, `kkcode ultra report`, and `report.md`.
- **When blocked, it asks.** In a TTY: continue / give guidance / deliver
  what's done / stop — guidance steers the next round. Headless runs close over
  explicitly: an empty answer is never "continue", and a stalled unattended run
  with nothing achieved exits 2 (`blocked`), never a quiet success.
- **Sub-goals and the board.** Blueprints may decompose the objective into
  ≤6 independently deliverable sub-goals; rounds re-execute only the pending
  ones. `/board` and `kkcode ultra board --watch` render five columns — todo /
  doing / blocked / pending-check / done — where "pending-check" holds work the
  model claims but criteria have not verified.
- **Machinery that finally works**: cross-process `ultra stop` takes effect
  (the flag was written but never read); `ultra resume` actually resumes from
  the checkpoint — H0/H1/H2 are skipped, the interrupted stage continues, and
  `--guidance` steers it (0.4.x resume only cleared a flag); worker log lines
  are forwarded so H4 is no longer minutes of silence; checkpoints carry the
  plan context that makes restore real; `checkpoint_interval` and the heartbeat
  event are implemented; `models.ultra.*` per-stage overrides land.
- Statuses now tell the truth: `completed` / `partial` / `blocked` /
  `blocked_manual` / `user_stopped` / `budget_exhausted` / `deadline_exhausted`
  / `needs_objective` / `fatal`, with meaningful exit codes. Session state
  `failed` is reserved for fatal errors. H7 merges to the base branch only on
  `completed`. Research / docs / ops objectives are first-class: they skip
  scaffold and build gates and verify against document-shaped criteria.
- Deprecated with one-time notices: `no_progress_limit` / `no_progress_warning`
  (superseded by `ultra.no_progress_rounds` — note the semantic change from
  iterations to rounds). The 0.4.0 legacy mode/permission aliases keep working
  with notices; their removal moves to 0.6.0 — pulling the rug now, mid-upgrade,
  costs users more than the vocabulary costs us.

### 中文

- **可执行的「完成」定义。** 验收判据成为系统会执行的结构 —— 文件存在、内容
  匹配、命令退出码、测试、门禁 —— 而不是贴进提示词的散文。无法机器化的判据
  一律成为 `manual`：没有任何代码路径能把它自动判过，目标会停在
  `blocked_manual` 等人点头。`[TASK_COMPLETE]` 从判据降级为自我声明，单独
  永远不产生 `completed`。
- **目标循环。** `max_rounds` 默认不限；约束是进展证据（判据/门禁跃迁、新完成
  的任务、错误没有原样重复的文件变更），由停滞检测（2 轮）、2 小时时限与
  token 预算兜底。`goal_mode: false` 一行退回 0.4.x 单轮行为。
- **失败分档处置，不再一票崩塌。** stage 失败走决策表 —— 重试/降级/延后/跳过/
  重规划 —— 取代 0.4.x 的「重试，或放弃当前与所有后续 stage」。永久性错误不再
  烧 12 次无望的退避；重规划把台账里的失败证据喂回 blueprint，有次数上限，
  且按计划签名去重。
- **如实汇报。** 每一轮记入 `.kkcode/ultra/<会话>/ledger.json`；受阻报告逐条
  展示判据结论与 0.4.x 丢弃的那 12 行命令输出、跨轮尝试次数、被删除的验收
  判据及其理由，以及可选的快速模型「关键判断 / 下一步」。REPL、
  `kkcode ultra report` 与落盘的 report.md 三处同源。
- **受阻时会问你。** TTY 下四个选项：继续 / 给指引 / 交付已完成部分 / 停止 ——
  指引直接进入下一轮。无终端运行显式收口：空答案绝不当「继续」，零达成的
  停滞运行以退出码 2（blocked）结束，绝不静默通过。
- **子目标与看板。** blueprint 可把目标分解为 ≤6 个可独立交付的子目标，
  后续轮次只重跑未达成的部分。`/board` 与 `kkcode ultra board --watch` 渲染
  五列：待办 / 进行中 / 受阻 / 待验收 / 已达成 ——「待验收」收纳模型声称完成
  但判据尚未核验的工作。
- **终于真的能用的机制**：跨进程 `ultra stop` 生效（旧版把标志写盘但无人读）；
  `ultra resume` 真的从 checkpoint 续跑 —— 跳过 H0/H1/H2、从中断的 stage
  继续，`--guidance` 可以指路（0.4.x 的 resume 只清一个标志）；worker 日志
  逐行转发，H4 不再是几分钟的空白；checkpoint 补齐了让恢复成立的计划上下文；
  `checkpoint_interval` 与心跳事件落地；`models.ultra.*` 分阶段模型上线。
- 状态说真话：`completed` / `partial` / `blocked` / `blocked_manual` /
  `user_stopped` / `budget_exhausted` / `deadline_exhausted` /
  `needs_objective` / `fatal`，退出码各有含义。会话 `failed` 只留给内部错误。
  H7 只在 `completed` 时并入主干。调研 / 文档 / 运维目标成为一等公民：跳过
  脚手架与 build 门禁，按文档形态的判据核验。
- 一次性弃用提示：`no_progress_limit` / `no_progress_warning`（由
  `ultra.no_progress_rounds` 取代 —— 注意语义从迭代变为轮次）。0.4.0 的旧模式
  与权限别名继续可用并带提示；移除推迟到 0.6.0 —— 升级进行到一半抽走梯子，
  用户付出的代价远大于我们维护几个别名的成本。


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
