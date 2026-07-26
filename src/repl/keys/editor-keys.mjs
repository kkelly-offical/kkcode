/**
 * 输入框按键：光标、行编辑、删除、选区、补全/ghost、历史、若干视图开关。
 *
 * 非模态：未命中的按键继续往下走。最后一条 `insert` 兜底接住可打印字符。
 *
 * ## 忙碌闸门：从作用域搬进了单个处理器（0.7.2）
 *
 * 这个作用域曾经整体挂着 `active: (ctx) => !ctx.ui.busy` —— 拆分前那句孤零零的
 * `if (ui.busy) return`。后果是模型一开始干活，用户敲的**每个字符都被丢弃**：
 * 想到下一句只能盯着 spinner 干等，等完再从头打。
 *
 * 现在输入框在忙碌时照常可编辑，Enter 不提交而是 `queuePrompt` 排队。代价是
 * 那一句话原先**一次性挡住了这张表里的所有东西**，拿掉之后每条都得自己想过：
 *
 * | 处理器 | 忙碌时 | 为什么 |
 * |---|---|---|
 * | submit | **改为排队** | Enter 把当前输入交给 `queuePrompt`，没被明确拒绝才清空输入框 |
 * | cycleMode | **挡住** | 模式决定这一回合怎么走，中途换会让一个回合跨两种模式 |
 * | clearTranscript | **挡住** | 回合还在往 transcript 里写，清掉之后增量落进空表 |
 * | rewind | **挡住** | 回溯要改会话历史，而正在跑的回合还引用着它 |
 * | 三个 Esc 处理器 | 到不了 | 忙碌时 Esc 归 `scroll.pauseTurn`，它排在本作用域之前 |
 * | paste / 插入 / 删除 / 行编辑 / 光标 / 历史 | 照常 | 只动输入框这一个字符串，与回合无关 |
 * | tabComplete / acceptGhost | 照常 | 也只是把文本写进输入框 |
 * | toggleThinking / toggleDetails / toggleDashboard / toggleAutoCopy | 照常 | 纯视图开关，不碰回合状态 |
 *
 * 还有两处忙碌闸门**不在这个文件里**，改动没有碰它们：`repl.mjs` 里括号粘贴的
 * `else if (!ui.busy)`，以及 `onData` 里 Shift+Enter 换行序列的 `if (ui.busy) return`。
 *
 * ## 入口不要多（0.7.2 定的规矩）
 *
 * **能力不能少，入口不要多**：同一个动作不该有第二个键位。多一个别名不会让谁多做
 * 成一件事，只会多一个要记、要写进帮助、要在冲突时权衡的东西 —— 而键位是有限的，
 * 这次 Ctrl+E 能腾出来给行尾，正是因为它此前只是个别名。
 *
 * 已经砍掉的两个别名：
 *   - Ctrl+E 展开/折叠 → 与 Ctrl+O 同义，让给「逻辑行尾」
 *   - Alt+Backspace 删前词 → 与 Ctrl+W 同义，直接删掉
 *
 * 看着像别名、实际不是的三处，别再来一次：
 *   - **Ctrl+J 与 Shift+Enter 都插入换行**：很多终端根本不发 Shift+Enter 的独立
 *     序列（帮助里那句 "if terminal supports" 就是这个意思）。砍掉 Ctrl+J，那些
 *     终端里就没法插换行了 —— 这是能力少了，不是入口少了。
 *   - **Tab 与 Ctrl+F 都能接受 ghost**：Tab 只在**没有候选**时才轮到 ghost，有候选
 *     时它是补全；Ctrl+F 则在任何状态下都接受 ghost。两者的可用区间不重合。
 *   - **Home/End 与 Ctrl+A/Ctrl+E**：前者是整段输入的首尾，后者是**当前逻辑行**的
 *     首尾。单行输入时恰好一样，多行时是两件事，缺一件就没法一步跳到整段开头
 *     （Ctrl+Home / Ctrl+End 已经被滚动占了）。
 */

import { on } from "../key-dispatch.mjs"
import { markerSpanAt } from "../attachments.mjs"
import {
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordAfter,
  deleteWordBefore,
  lineEnd,
  lineStart,
  wordEndAfter,
  wordStartBefore
} from "../line-editing.mjs"

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
  queuePrompt,
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

  /**
   * 行编辑的落点：把 `line-editing.mjs` 算出的 `{ text, cursor }` 写回输入框。
   * 这张表里**不做光标算术** —— grapheme 边界、逻辑行、词分类全在那个纯函数
   * 模块里，有 48 条测试守着；在这里重算一遍等于开第二套定义。
   */
  const applyLineEdit = (ui, result) => {
    ui.input = result.text
    ui.inputCursor = result.cursor
    onInputChanged()
    resetSuggestion(ui)
    requestRender()
  }

  /**
   * 删除类按键的统一入口：**有选区时先删选区**，与退格 / Delete / 插入同一条优先级。
   * 否则框选一段再按 Ctrl+W，删掉的会是选区左边那个词，而选区原样留着。
   */
  const deleteWith = (ui, compute) => {
    if (deleteInputSelection()) {
      resetSuggestion(ui)
      requestRender()
      return
    }
    applyLineEdit(ui, compute(ui.input, ui.inputCursor))
  }

  /** 光标移动只改位置，不动候选态 —— 与既有的 left/right 保持一致。 */
  const moveCursorTo = (position) => { setCursor(position); requestRender() }

  /**
   * 回合进行中挡住一个按键，并说清为什么没反应。
   *
   * 静悄悄地 no-op 是不行的：忙碌时输入框现在是活的，用户按了没反应会以为是
   * 卡住了而不是被拒绝。
   */
  const blockWhileBusy = (reason) => {
    showToast(reason, { topic: "busy", tone: "warning" })
    requestRender()
  }

  return {
    id: "editor",
    // 这里曾经是 `active: (ctx) => !ctx.ui.busy`。忙碌时的取舍改为逐个处理器
    // 判断，见文件头那张表。
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
        run: async ({ ui }) => {
          if (ui.busy) {
            // 忙碌时 Enter 是**排队**而不是提交：想到下一句就能打下来，不必等
            // spinner 停，更不能在这里真的 submit —— 那是并发发起第二个回合。
            //
            // `queuePrompt(text)` 是同步的，**返回值不是契约的一部分**：去空白、
            // 判空、上限、提示都归它，这里不重复一遍。
            //
            // 但只要它明确说了 `false`（今天的实现在空白与队列满时就是这样），
            // 就**不能清空输入框** —— 清了的话用户刚打的一段话既没排上队也没了，
            // 没有任何地方还留着它，而提示只说了「队列已满」。
            // 只认严格的 false：返回 undefined（真把返回值当无意义）时照常清空。
            if (await queuePrompt(ui.input) === false) return
            ui.input = ""
            ui.inputCursor = 0
            resetSuggestion(ui)
            cancelGhost()
            requestRender()
            return
          }
          await submitCurrentInput()
          requestExitIfQuitting()
        }
      },
      {
        id: "newlineCtrlJ",
        when: on.ctrl("j"),
        run: () => { insertAtCursor("\n"); requestRender() }
      },

      // --- emacs 行编辑（0.7.2）。全部走 line-editing.mjs 的纯函数 ---
      //
      // 没有 kill ring，所以没有 Ctrl+Y yank：那个键位早已是「选中即复制」开关。
      // 删掉的文本找不回来，这是明确的取舍 —— 详见 line-editing.mjs 的 deleteRange。

      {
        id: "logicalLineStart",
        // Ctrl+A 去**当前逻辑行**的行首，不是整个输入的开头：Shift+Enter 会在
        // ui.input 里放真的 `\n`，多行输入里飞到最上面几乎总不是用户想要的。
        // （裸 Home 仍是整段输入的开头，见下面的 lineStart —— 两者不同是既有行为。）
        when: on.ctrl("a"),
        run: ({ ui }) => moveCursorTo(lineStart(ui.input, ui.inputCursor))
      },
      {
        id: "logicalLineEnd",
        // **行为变更**：Ctrl+E 此前与 Ctrl+O 并列绑在「展开/折叠最近的可展开块」上。
        // 现在它是行尾，展开折叠由 Ctrl+O 单独承担（外加鼠标点击）。
        // 理由：Ctrl+A/Ctrl+E 是 readline 里肌肉记忆最深的一对，缺了行尾而行首在，
        // 比让展开折叠少一个别名更难受。
        when: on.ctrl("e"),
        run: ({ ui }) => moveCursorTo(lineEnd(ui.input, ui.inputCursor))
      },
      {
        id: "wordLeft",
        when: on.meta("b"),
        run: ({ ui }) => moveCursorTo(wordStartBefore(ui.input, ui.inputCursor))
      },
      {
        id: "wordRight",
        when: on.meta("f"),
        run: ({ ui }) => moveCursorTo(wordEndAfter(ui.input, ui.inputCursor))
      },
      {
        id: "deleteWordBefore",
        // **只有 Ctrl+W**。Alt+Backspace 曾经作为同义键一起接在这里，按「入口不要多」
        // 砍掉了 —— 它没带来任何 Ctrl+W 做不到的事。
        //
        // 砍掉之后 Alt+Backspace 会落到下面的 `backspace`（`on.key("backspace")` 不看
        // meta），删掉一个字符。这是刻意不管的：为了让它彻底没反应还得再写一个处理器，
        // 而「少删了几个字」比多一个要记的键位便宜。
        when: on.ctrl("w"),
        run: ({ ui }) => deleteWith(ui, deleteWordBefore)
      },
      {
        id: "deleteWordAfter",
        when: on.meta("d"),
        run: ({ ui }) => deleteWith(ui, deleteWordAfter)
      },
      {
        id: "deleteToLineStart",
        // 光标已在行首时是 no-op，不会把上一行接过来 —— 与 Ctrl+K 故意不对称，
        // 原因写在 line-editing.mjs 的 deleteToLineStart 上。
        when: on.ctrl("u"),
        run: ({ ui }) => deleteWith(ui, deleteToLineStart)
      },
      {
        id: "deleteToLineEnd",
        // 光标已在行尾时删掉那个换行符、把下一行接上来（emacs kill-line 语义）。
        when: on.ctrl("k"),
        run: ({ ui }) => deleteWith(ui, deleteToLineEnd)
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
      // --- Esc 的三级语义 ---
      //
      // 三条都**只在空闲时到得了**：忙碌时 Esc 归 `scroll.pauseTurn`（中断回合），
      // 那个作用域排在本作用域之前。作用域顺序是 lifecycle → 9 个浮层 → scroll →
      // editor，editor 在最后。`test/repl-editor-keys` 里有一条钉住它。
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
        // `!busy` 是第二道闸：忙碌时的 Esc 早被 `scroll.pauseTurn` 接走，按说到不了
        // 这里。但回溯会改会话历史，而正在跑的回合还引用着它 —— 万一哪天有人调了
        // 作用域顺序或改了 pauseTurn 的条件，代价是用户丢掉一轮对话，
        // 不该只由「谁排在前面」这一条隐式规则兜着。
        when: (ctx) => ctx.key.name === "escape" && !ctx.ui.input && !ctx.ui.busy,
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
        run: ({ ui }) => {
          // 忙碌时失效：模式决定这一回合怎么走（审批级别、路由）。中途换掉，
          // 同一个回合会前半按旧模式、后半按新模式。
          // 拦截写在 run 里而不是 when 里 —— when 返回 false 的话 Shift+Tab 会
          // 落到下一条 `tabComplete` 上，忙碌时按 Shift+Tab 反倒去补全了。
          if (ui.busy) {
            blockWhileBusy("Turn in progress — mode switch is disabled")
            return
          }
          cycleModeForwardAndNotify()
        }
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
        // **只剩 Ctrl+O**（0.7.2）。此前 Ctrl+E 与它并列绑定，现在 Ctrl+E 是行尾 ——
        // 见上面的 logicalLineEnd。折叠块仍有两条路进得去：Ctrl+O 与鼠标点击。
        when: on.ctrl("o"),
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
        run: ({ ui }) => {
          // 忙碌时失效：回合还在往 transcript 里写。清掉之后，后续增量会落进一张
          // 空表 —— 用户既看不到这一回合的开头，也无从判断它是不是还在跑。
          if (ui.busy) {
            blockWhileBusy("Turn in progress — clear the transcript after it finishes")
            return
          }
          transcript.clear()
          requestRender()
        }
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
