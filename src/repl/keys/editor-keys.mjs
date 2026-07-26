/**
 * 输入框按键：光标、删除、选区、补全/ghost、历史、若干视图开关。
 *
 * 整个作用域只在**不忙碌**时激活 —— 对应拆分前那句孤零零的 `if (ui.busy) return`。
 * 那句话此前是一条看不见的分界线：它上面的按键忙碌时也生效（滚动、中断），
 * 下面的不生效。现在它是作用域的 `active`，读代码的人不必自己去数在闸门的哪一侧。
 *
 * 非模态：未命中的按键继续往下走。最后一条 `insert` 兜底接住可打印字符。
 */

import { on } from "../key-dispatch.mjs"
import { markerSpanAt } from "../attachments.mjs"

export function createEditorKeyScope({
  requestRender,
  showToast,
  transcript,
  insertAtCursor,
  attachImage,
  insertPastedText,
  deleteInputSelection,
  moveCursor,
  setCursor,
  moveGraphemeCursor,
  onInputChanged,
  acceptGhost,
  cancelGhost,
  hasSuggestions,
  shouldApplySuggestionOnEnter,
  applyCurrentSuggestion,
  handleUpDownSuggestions,
  navigateHistory,
  submitCurrentInput,
  requestExitIfQuitting,
  cycleModeForwardAndNotify,
  handleRewind,
  readClipboardImage,
  readClipboardText,
  doubleEscapeMs
}) {
  /** 补全候选的选中态在几乎每次改动输入后都要归零，抽出来免得漏。 */
  const resetSuggestion = (ui) => {
    ui.selectedSuggestion = 0
    ui.suggestionOffset = 0
  }

  return {
    id: "editor",
    // 拆分前这里是一句孤零零的 `if (ui.busy) return`
    active: (ctx) => !ctx.ui.busy,
    handlers: [
      {
        id: "paste",
        when: on.ctrl("v"),
        run: async ({ ui }) => {
          showToast("Reading clipboard…", { topic: "clipboard", tone: "info", durationMs: 0 })
          requestRender()
          const clipBlock = await readClipboardImage({
            onStatus: (msg) => {
              if (msg) showToast(msg, { topic: "clipboard", tone: "info", durationMs: 0 })
              requestRender()
            }
          })
          if (clipBlock && clipBlock.type === "image") {
            // 图片进登记本，光标处插一个 `[Image #N]` 标记。标记就是「这里有张图」的
            // 提示本身 —— 看得见、删得掉、位置明确，而且提交时它决定这张图发不发。
            const marker = attachImage(clipBlock)
            showToast(`Image attached · ${marker}`, { topic: "clipboard", tone: "success" })
            requestRender()
            return
          }
          if (clipBlock && clipBlock.type === "error") {
            showToast(`Paste failed: ${clipBlock.message}`, { topic: "clipboard", tone: "error", durationMs: 5000 })
            requestRender()
            return
          }
          // 剪贴板里没有图片 —— 退回文本粘贴
          const clipText = await readClipboardText()
          if (clipText) {
            // 走与括号粘贴同一条入口：够长就折叠成 `[Pasted text #N +M lines]`。
            // 两条粘贴路径共用一份折叠策略，免得同样的文本从 Ctrl+V 进来会折、
            // 从终端粘贴进来不会折。
            showToast(insertPastedText(clipText), { topic: "clipboard", tone: "success" })
          } else {
            showToast("Clipboard is empty", { topic: "clipboard", tone: "warning" })
          }
          requestRender()
        }
      },
      {
        id: "newlineShiftEnter",
        when: (ctx) => ctx.key.name === "return" && Boolean(ctx.key.shift),
        run: () => { insertAtCursor("\n"); requestRender() }
      },
      {
        id: "acceptSuggestion",
        when: (ctx) => ctx.key.name === "return" && shouldApplySuggestionOnEnter(),
        run: ({ ui }) => {
          applyCurrentSuggestion()
          resetSuggestion(ui)
          requestRender()
        }
      },
      {
        id: "submit",
        when: on.key("return"),
        run: async () => {
          await submitCurrentInput()
          requestExitIfQuitting()
        }
      },
      {
        id: "newlineCtrlJ",
        when: on.ctrl("j"),
        run: () => { insertAtCursor("\n"); requestRender() }
      },
      {
        id: "backspace",
        when: on.key("backspace"),
        run: ({ ui }) => {
          if (!deleteInputSelection() && ui.inputCursor > 0) {
            // 光标停在 `[Image #1]` 的右括号之后时，退格删掉**整个标记**。
            // 按字素删只会留下 `[Image #1` 这样的残骸 —— 它既不再匹配标记（那张图
            // 于是悄悄不发了），看上去又还像个标记，用户无从判断发生了什么。
            const marker = markerSpanAt(ui.input, ui.inputCursor)
            const previousCursor = marker ? marker.start : moveGraphemeCursor(ui.input, ui.inputCursor, -1)
            const head = ui.input.slice(0, previousCursor)
            const tail = ui.input.slice(ui.inputCursor)
            ui.input = `${head}${tail}`
            ui.inputCursor = previousCursor
            onInputChanged()
          }
          resetSuggestion(ui)
          requestRender()
        }
      },
      {
        id: "delete",
        when: on.key("delete"),
        run: ({ ui }) => {
          if (!deleteInputSelection()) {
            const nextCursor = moveGraphemeCursor(ui.input, ui.inputCursor, 1)
            const head = ui.input.slice(0, ui.inputCursor)
            const tail = ui.input.slice(nextCursor)
            ui.input = `${head}${tail}`
            onInputChanged()
          }
          resetSuggestion(ui)
          requestRender()
        }
      },
      {
        id: "dismissGhost",
        // Esc 分三级：先撤 ghost，再清空输入，输入已空时连按两下才回溯
        when: (ctx) => ctx.key.name === "escape" && Boolean(ctx.ui.ghostText),
        run: ({ ui }) => {
          ui.ghostText = ""
          cancelGhost()
          requestRender()
        }
      },
      {
        id: "rewind",
        when: (ctx) => ctx.key.name === "escape" && !ctx.ui.input,
        run: ({ ui }) => {
          // 说错了、模型跑偏了、或只是想换个问法，应该能退回去重来，而不是
          // 被迫在一段已经歪掉的上下文里继续往前顶。
          // 只回溯对话，不动磁盘 —— 文件改动归 /undo，退一句话很轻，
          // 退一批文件改动有风险，不该被同一个手势同时触发。
          const now = Date.now()
          if (ui.lastEscapeAt && now - ui.lastEscapeAt < doubleEscapeMs) {
            ui.lastEscapeAt = 0
            void handleRewind()
            return
          }
          ui.lastEscapeAt = now
          showToast("再按一次 Esc 回溯上一轮", { topic: "rewind", tone: "info", durationMs: doubleEscapeMs })
          requestRender()
        }
      },
      {
        id: "clearInput",
        when: on.key("escape"),
        run: ({ ui }) => {
          ui.input = ""
          ui.inputCursor = 0
          resetSuggestion(ui)
          cancelGhost()
          requestRender()
        }
      },
      {
        id: "cycleMode",
        when: (ctx) => ctx.key.name === "tab" && Boolean(ctx.key.shift),
        run: () => cycleModeForwardAndNotify()
      },
      {
        id: "tabComplete",
        when: on.key("tab"),
        run: ({ ui }) => {
          // Tab 早已被补全占用，仅在没有候选时才用于接受 ghost。
          // 候选有三种（`/` 命令、`$` 技能、`@` 文件），写回语义各不相同 ——
          // 分派在 applyCurrentSuggestion 背后的 suggestion-source 里，这张表不认种类。
          if (!hasSuggestions(ui) && acceptGhost()) return
          applyCurrentSuggestion()
        }
      },
      {
        id: "acceptGhost",
        // Ctrl+F 无歧义地接受 ghost，不与补全争抢
        when: on.ctrl("f"),
        run: () => { acceptGhost() }
      },
      { id: "left", when: on.key("left"), run: () => { moveCursor(-1); requestRender() } },
      { id: "right", when: on.key("right"), run: () => { moveCursor(1); requestRender() } },
      {
        id: "lineStart",
        // 带 ctrl/shift 的 home/end 已被 scroll 作用域接走，这里只剩裸键。
        // 拆分前这里还重复写了一遍 ctrl/shift 分支 —— 不可达的死代码。
        when: on.key("home"),
        run: () => { setCursor(0); requestRender() }
      },
      {
        id: "lineEnd",
        when: on.key("end"),
        run: ({ ui }) => { setCursor(ui.input.length); requestRender() }
      },
      {
        id: "historyOrSuggestion",
        when: on.anyKey("up", "down"),
        run: ({ key }) => {
          // 有补全候选时上下键在候选间移动，没有才翻历史
          if (!handleUpDownSuggestions(key.name)) navigateHistory(key.name)
          requestRender()
        }
      },
      {
        id: "toggleThinking",
        when: on.ctrl("t"),
        run: ({ ui }) => {
          if (ui.lastThinkingId) {
            transcript.toggleLog(ui.lastThinkingId)
            showToast("Thinking details toggled", { topic: "thinking", tone: "info" })
          } else {
            showToast("No thinking details in this turn", { topic: "thinking", tone: "info" })
          }
          requestRender()
        }
      },
      {
        id: "toggleDetails",
        // Ctrl+O 与 Ctrl+E 并列绑定：折叠块该有多条路进得去（鼠标点击、
        // Ctrl+E、Ctrl+O），而不是只记得住一个组合键。
        when: (ctx) => ctx.key.ctrl && (ctx.key.name === "e" || ctx.key.name === "o"),
        run: () => {
          const expandable = transcript.getItems().findLast((item) => item.collapsible && item.details.length)
          if (expandable) {
            transcript.toggleLog(expandable.id)
            showToast(`${expandable.kind} details ${expandable.expanded ? "collapsed" : "expanded"}`,
              { topic: "details", tone: "info" })
          } else {
            showToast("No expandable details", { topic: "details", tone: "info" })
          }
          requestRender()
        }
      },
      {
        id: "toggleDashboard",
        when: on.ctrl("b"),
        run: ({ ui }) => { ui.showDashboard = !ui.showDashboard; requestRender() }
      },
      {
        id: "toggleAutoCopy",
        when: on.ctrl("y"),
        run: ({ ui }) => {
          ui.autoCopy = !ui.autoCopy
          showToast(`Auto-copy ${ui.autoCopy ? "ON" : "OFF"}`, {
            topic: "auto-copy",
            tone: ui.autoCopy ? "success" : "info"
          })
          requestRender()
        }
      },
      {
        id: "clearTranscript",
        when: (ctx) => ctx.key.ctrl && ctx.key.name === "l" && !ctx.key.shift,
        run: () => { transcript.clear(); requestRender() }
      },
      {
        id: "insert",
        when: on.printable,
        run: ({ ui, str }) => {
          deleteInputSelection()  // 有选择时先删除选中文本
          insertAtCursor(str)
          resetSuggestion(ui)
          requestRender()
        }
      }
    ]
  }
}
