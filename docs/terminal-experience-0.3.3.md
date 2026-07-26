# KK Code 0.3.3 terminal experience

This document describes the interactive terminal contract introduced in
KK Code 0.3.3. It applies to the full-screen REPL on Windows, macOS, Linux, and
remote shells.

## Default interaction

`ui.terminal.alternate_screen: auto` and `ui.terminal.mouse: auto` enable the
application terminal protocol on a capable TTY.

- Drag in the transcript to select text. With `copy_on_select: true`, releasing
  the mouse immediately requests a clipboard copy.
- Use the wheel to scroll the conversation without moving the composer.
- Click inside the composer to place the hardware cursor. Unicode grapheme,
  CJK, emoji, combining-mark, tab, and wrapped-line widths are accounted for.
- Click a `▸` Thinking or tool row to expand it; click again to collapse it.
- Right-click an existing application selection or press `Ctrl+C` to copy it.
- Bracketed paste inserts multiline text atomically, so embedded newlines do
  not submit several prompts.

The renderer restores the real terminal cursor after every frame, allowing a
compliant terminal and IME to anchor its candidate window to the actual input
position instead of the bottom-right corner. Real desktop behavior is covered
by the manual acceptance matrix below.

## Thinking, Markdown, tools, and toasts

- During model reasoning, the bottom activity row animates and displays
  `Thinking · Ns`.
- When reasoning ends, its detail becomes a collapsed transcript item. Press
  `Ctrl+T` to toggle the latest Thinking item.
- Assistant text is rendered as terminal-safe Markdown. Streaming updates are
  rebuilt from the accumulated source so formatting does not depend on network
  chunk boundaries.
- Tool summaries are muted gray. Editing tools show a compact line summary and
  keep bounded red `-` / green `+` details behind a collapsible row.
- Press `Ctrl+E` or `Ctrl+O` (or click it) to toggle the latest expandable Thinking or tool block.
- Mode, model, provider, permission, reconnect, dashboard, and clipboard notices
  replace each other by topic in a transient bottom toast.

## Clipboard paths

KK Code emits OSC 52 first, which supports many local terminals and remote
SSH/tmux workflows. It also tries a local platform fallback:

| Platform | Local fallback |
| --- | --- |
| Windows | PowerShell `Set-Clipboard` |
| macOS | `pbcopy` |
| Linux Wayland | `wl-copy`, then X11 fallbacks |
| Linux X11 | `xclip` or `xsel`, then `wl-copy` |
| SSH / remote shell | OSC 52 only, so the clipboard belongs to the local terminal |

Terminal security settings may disable OSC 52. Enable clipboard access in the
terminal, install one of the listed Linux clipboard commands, or use the native
selection fallback below.

OSC 52 has no acknowledgement channel. KK Code therefore says `Copied` only
when a platform clipboard command confirms success. If OSC 52 is the only
available path, the toast says `Copy requested` so a terminal permission denial
is never reported as a successful copy.

## Native terminal selection fallback

Some terminal emulators reserve a modifier such as Shift for native selection
while an application has mouse tracking enabled. When that behavior is not
available or not desired, return mouse handling entirely to the terminal:

```yaml
ui:
  terminal:
    alternate_screen: never
    mouse: never
    bracketed_paste: true
    copy_on_select: true
    toast_duration_ms: 2600
```

With `mouse: never`, native terminal selection and copying work on the currently
visible terminal frame. Mouse reports, including wheel reports, are no longer
sent to KK Code, so the wheel does **not** browse the KK Code transcript.
Application click-to-expand and click-to-place-cursor are unavailable as well.
Use `Ctrl+Up` / `Ctrl+Down` or `Ctrl+Home` / `Ctrl+End` to browse application
history.

`alternate_screen: never` preserves scrollback that already belongs to the
normal terminal screen, but KK Code uses row-addressed redraws: the emulator
must not be expected to retain every previous KK Code frame as durable native
scrollback. This setting is therefore a selection fallback, not a replacement
for KK Code's transcript navigation.

Modes accept `auto`, `always`, `never`, or the equivalent booleans. `TERM=dumb`
disables automatic alternate-screen and mouse features.

## Manual release acceptance

Unit and pseudo-terminal tests can verify the SGR decoder, Unicode layout,
selection math, and requested hardware-cursor coordinates. They cannot prove
how a GUI terminal emulator, desktop clipboard policy, or operating-system IME
behaves. The minimum manual release matrix is:

| Environment | Manual checks |
| --- | --- |
| Windows Terminal + PowerShell 7 + Microsoft Pinyin | Drag/copy, wheel transcript navigation, composer click, wrapped CJK/emoji cursor placement, IME candidate anchoring, and Shift/native-selection fallback |
| macOS Terminal.app or iTerm2 + system Pinyin | The same mouse/cursor/IME checks plus OSC 52 and `pbcopy` behavior allowed by terminal settings |
| Linux Wayland and X11 terminals + ibus or fcitx5 | The same mouse/cursor/IME checks plus OSC 52 and the available `wl-copy`/`xclip`/`xsel` fallback |

SSH and tmux should also be sampled when they are part of the release target,
because mouse forwarding and OSC 52 permissions vary by local terminal and
multiplexer configuration.

Until this matrix has been exercised on real desktops, `0.3.3` should be
described as implementation-complete and covered by automated protocol tests,
not as manually certified for every Windows, macOS, or Linux terminal.

## Reconnect contract

Provider `retry_attempts` counts reconnects after the first request:

```yaml
provider:
  openai:
    retry_attempts: 5
    retry_base_delay_ms: 800
```

This allows at most six total requests: one initial request and five reconnects.
Authentication, context overflow, and deterministic client errors fail
immediately. Network failures, timeouts, rate limits, selected transient HTTP
statuses, and server errors are retried with bounded backoff; `Retry-After` is
honored up to the safety cap.

For streaming calls, retry is allowed only before the first outward event.
After any text, reasoning, usage, or tool-call event has reached the session,
KK Code never replays the request. Cancelling a turn interrupts both backoff and
the active request, and removes the reconnect toast.

## Keyboard reference

| Key | Action |
| --- | --- |
| `Enter` | Submit |
| `Ctrl+J` | Insert newline |
| `Ctrl+C` | Copy an active selection; otherwise interrupt/exit confirmation |
| `Ctrl+T` | Toggle latest Thinking details |
| `Ctrl+E` / `Ctrl+O` | Toggle latest expandable transcript item (clicking works too) |
| `Ctrl+Y` | Toggle automatic copy-on-select |
| `Ctrl+Z` | Unix: restore terminal state and suspend; `fg` redraws the TUI |
| `Ctrl+Up` / `Ctrl+Down` | Scroll transcript |
| `Ctrl+Home` / `Ctrl+End` | Oldest / latest transcript position |
| `Esc` | Cancel the active turn or close the current picker/prompt |

## 中文速览

- 默认启用应用内鼠标：对话区拖选后自动复制、滚轮浏览、点击输入框定位真实光标、
  点击折叠行查看 Thinking 或代码 Diff。
- 真实硬件光标会在每一帧恢复，因此中文输入法候选窗跟随输入位置，不再漂到屏幕角落。
- 模型思考时显示动画与耗时，完成后默认折叠；工具日志为浅灰色，编辑详情使用红色
  删除与绿色增加。
- 如果更喜欢终端原生选择，把 `mouse` 设为 `never`；此时只能选择/复制当前可见
  画面，终端滚轮不会浏览 KK Code 对话历史，需改用 `Ctrl+Up` / `Ctrl+Down` 等
  应用快捷键。`alternate_screen: never` 会保留已有终端 scrollback，但逐行重绘
  不会把每一帧 KK Code 对话可靠地追加为原生历史。
- 自动化测试无法代替真实桌面的鼠标、剪贴板权限和输入法候选窗验收；发布前仍需在
  Windows Terminal、macOS Terminal/iTerm2，以及 Linux Wayland/X11 终端上完成
  手工矩阵。
- `retry_attempts: 5` 表示初始请求失败后再重连 5 次，而不是总共请求 5 次。
