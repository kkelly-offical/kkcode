import { PACKAGE_VERSION } from "./version.mjs"
import { maybeNotifyUpdateOnStartup } from "./update/checker.mjs"
import { notifyUpdateToast } from "./update/startup-toast.mjs"
import { buildPreflightReport } from "./cli/preflight.mjs"
import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"
import { emitKeypressEvents } from "node:readline"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { buildContext, printContextWarnings, resolveExtensionPolicy } from "./context.mjs"
import { ensureEventSinks, newSessionId, routeMode } from "./session/engine.mjs"
import { summarizeRouteDecision } from "./session/engine.mjs"
import { buildAgentContinuationPrompt, summarizeAgentTransaction } from "./session/agent-transaction.mjs"
import {
  emitAgentContinuationInterrupted,
  emitAgentContinuationResumed,
  emitRouteDecisionEvent
} from "./session/routing-observability.mjs"
import { listProviders } from "./provider/router.mjs"
import { loadCustomCommands, applyCommandTemplate } from "./command/custom-commands.mjs"
import { SkillRegistry } from "./skill/registry.mjs"
import { renderMarkdown } from "./theme/markdown.mjs"
import { listSessions } from "./session/store.mjs"
import { ToolRegistry } from "./tool/registry.mjs"
import { McpRegistry } from "./mcp/registry.mjs"
import { initHookBus } from "./plugin/hook-bus.mjs"
import { renderReplDashboard } from "./ui/repl-dashboard.mjs"
import { buildRouteFeedback } from "./ui/repl-route-feedback.mjs"
import { renderReplStatusLine, renderStartupScreen } from "./ui/repl-status-view.mjs"
import { paint } from "./theme/color.mjs"
import { PermissionEngine } from "./permission/engine.mjs"
import { setPermissionPromptHandler } from "./permission/prompt.mjs"
import { setQuestionPromptHandler } from "./tool/question-prompt.mjs"
import { createActivityRenderer } from "./ui/activity-renderer.mjs"
import { reduceAppState } from "./ui/app-state.mjs"
import { EventBus } from "./core/events.mjs"
import { EVENT_TYPES } from "./core/constants.mjs"
import { readClipboardImage, readClipboardText } from "./tool/image-util.mjs"
import { userRootDir, memoryFilePath } from "./storage/paths.mjs"
import { loadProfile, runOnboarding } from "./onboarding.mjs"
import {
  configuredProviders,
  loadHistoryLines,
  saveHistoryLines,
  clearScreen,
  resolveProviderDefaultModel,
  createInitialReplState,
  collectMcpStatusLines,
  startSplash
} from "./repl/core-shell.mjs"
import { runReplController } from "./repl/controller-entry.mjs"
import { collectInput, resolveHistoryNavigation } from "./repl/input-engine.mjs"
export { collectInput } from "./repl/input-engine.mjs"
// 帧度量与拼装原语。此前 repl.mjs 自带一份，与 repl-dashboard / activity-renderer /
// repl-help / text-layout 各自的副本互不一致 —— 见 frame-primitives.mjs 的说明。
import { stripAnsi, displayWidth, pageSize } from "./repl/frame-primitives.mjs"
import { buildFrame as buildFrameLines } from "./repl/frame-builder.mjs"
import { normalizeSlashAlias } from "./repl/slash-router.mjs"
// 补全候选（斜杠 / 技能 / `@` 文件）的唯一来源。此前候选在四处独立求值 ——
// 三处在这个文件里、一处在 frame-builder 里，加第三种候选就是四处手写清单。
import { createSuggestionSource } from "./repl/suggestion-source.mjs"
// 命令层。目录与分发同源，命令本体按领域分文件 —— 此前是一个 1090 行的
// 顺序 if 链，加一条命令要在两份手写清单里各改一处。
import { resolveCommand, buildBuiltinSlashCatalog } from "./repl/commands/registry.mjs"
import { sessionCommands } from "./repl/commands/session.mjs"
import { providerCommands } from "./repl/commands/provider.mjs"
import { permissionCommands } from "./repl/commands/permission.mjs"
import { modeCommands } from "./repl/commands/mode.mjs"
import { authoringCommands } from "./repl/commands/authoring.mjs"
import { presentPromptTurn } from "./repl/turn-presenter.mjs"
import { loadProviderModelItems } from "./repl/provider-catalog.mjs"
import { persistLearnedGrant } from "./repl/config-persistence.mjs"
import { createRenderScheduler } from "./repl/render-scheduler.mjs"
import { createListenerRegistry } from "./repl/listener-registry.mjs"
import { subscribeSessionEvents } from "./repl/event-bridge.mjs"
import { createMouseSelection, screenRowFromAbsolute } from "./repl/mouse-selection.mjs"
import { createPromptQueue } from "./repl/prompt-queue.mjs"
import { createOverlayController } from "./repl/overlay-controller.mjs"
import { createTerminalSession } from "./repl/terminal-session.mjs"
import { createKeyDispatcher } from "./repl/key-dispatch.mjs"
import { createOverlayKeyScopes } from "./repl/keys/overlay-keys.mjs"
import { createLifecycleKeyScope, createScrollKeyScope } from "./repl/keys/global-keys.mjs"
import { createEditorKeyScope } from "./repl/keys/editor-keys.mjs"
import { createTranscriptWriter } from "./repl/transcript-writer.mjs"
import { createReplUiState, openUserOverlay, closeUserOverlay } from "./repl/ui-state.mjs"
import { createAttachmentInput } from "./repl/attachment-input.mjs"
import { createPromptOutbox } from "./repl/prompt-outbox.mjs"
import { createNotifier } from "./repl/notify.mjs"
import { createGhostPredictor } from "./repl/ghost-predictor.mjs"
import { buildReplRuntimeSnapshot } from "./repl/runtime-facade.mjs"
import { POLICY_CHOICES, PERMISSION_PROMPT_VALUES } from "./repl/permission-flow.mjs"
import { nextModeId } from "./core/modes.mjs"
import {
  applyModeSelection,
  resolveModeId,
  switchModeInPlace,
  MODE_PICKER_CHOICES
} from "./repl/mode-flow.mjs"
import { describeRule } from "./permission/learned-rules.mjs"
import { createInputDecoderChain } from "./repl/input-decoders.mjs"
import {
  enterTerminalSequence,
  exitTerminalSequence,
  normalizeMouseSelection,
  renderTerminalFrame,
  resolveTerminalFeatures
} from "./repl/terminal-protocol.mjs"
import { moveGraphemeCursor, splitTextByCellRange } from "./repl/text-layout.mjs"
import { copyTerminalText } from "./repl/clipboard.mjs"
import { createTranscriptModel } from "./ui/transcript-model.mjs"
import { createToastStore } from "./ui/toast-store.mjs"
import { shouldApplyActiveTurnEvent } from "./ui/event-scope.mjs"
import { createFrameBatcher } from "./ui/frame-batcher.mjs"
import { buildThinkingTranscriptItem, finishThinking as finishThinkingState } from "./ui/thinking-state.mjs"
import { rewindLastTurn } from "./session/rewind.mjs"
import { setMarkdownColors } from "./theme/markdown.mjs"
import { sanitizeTerminalStyledText, sanitizeTerminalText } from "./theme/terminal-sanitize.mjs"

const HIST_DIR = userRootDir()
const HIST_FILE = join(HIST_DIR, "repl_history")
const HIST_SIZE = 500
const MAX_TUI_LOG_LINES = 1200
/** 连按两下 Esc 判定为回溯的时间窗 */
const DOUBLE_ESCAPE_MS = 1200
const MAX_MODEL_PICKER_VISIBLE = 8
const TUI_FRAME_MS = 16
const BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const ESCAPE_SEQUENCE_TIMEOUT_MS = 35
const KEYPRESS_ESCAPE_TIMEOUT_MS = 10



/**
 * 内建斜杠命令。目录（补全菜单）与分发（谁来处理）从此**同源** ——
 * 此前是两份手写清单，加命令时只改分发是最自然的疏忽。
 */
const BUILTIN_COMMANDS = [
  ...sessionCommands,
  ...providerCommands,
  ...permissionCommands,
  ...modeCommands,
  ...authoringCommands
]

const BUILTIN_SLASH = buildBuiltinSlashCatalog(BUILTIN_COMMANDS)

// 模型目录的取用点有三处（/model、切 provider 后的提示、启动预热），
// 实现已移到 repl/provider-catalog.mjs；这里转发导出保持既有调用方不变。
export { loadProviderModelItems }

function slashRouterOptions(customCommands = []) {
  return {
    builtinSlash: BUILTIN_SLASH,
    customCommands,
    skills: SkillRegistry.isReady() ? SkillRegistry.list() : []
  }
}

/**
 * 一行输入 → 一个动作。
 *
 * 曾经是 1090 行、49 个顺序 `if`；现在只做四件事：拦截两种输入模式、查注册表、
 * 跑命令、剩下的当提示词。命令本体在 `repl/commands/*.mjs`。
 *
 * 返回的 action 必须是**对象** —— 三个调用点直接读它的字段。裸 null 曾让行模式的
 * REPL 整个崩掉（v0.6.0 → v0.6.14），所以调用点也做了归一化兜底。
 */
async function processInputLine({
  line,
  state,
  ctx,
  providersConfigured,
  customCommands,
  setCustomCommands,
  providerPicker,
  setProviderPicker,
  print,
  streamSink = null,
  showTurnStatus = true,
  pendingImages = [],
  clearPendingImages = null,
  /**
   * 把一张图片挂到「下一条消息」上，返回给用户看的标记文本（TUI 下是 `[Image #N]`）。
   * TUI 会把标记插进输入框；行模式没有可编辑的输入框，就退化成推进待发数组、返回 ""。
   */
  attachImage = null,
  signal = null,
  suspendTui = null,
  // 只读信息浮层。TUI 会话里由 startTuiRepl 注入；行模式（无 TTY）下缺省为
  // null，此时回落到 print —— 那里没有帧可以浮，浮层无从存在。
  openPanel = null
}) {
  let normalized = normalizeSlashAlias(String(line || "").trim())

  /**
   * 只读信息的统一出口。
   *
   * 这类输出（`/status`、`/permission`、`/keys`…）是**查询当前状态**，给人看的：
   * 它不该进对话记录，否则会随会话发给模型、被 /clear 连带清掉，而且看完关不掉。
   * TUI 会话里走浮层；行模式（无 TTY，没有帧可浮）回落到折叠面板。
   */
  function showInfo(title, text, options = {}) {
    if (openPanel) {
      openPanel(title, text, options)
      return
    }
    print(typeof text === "function" ? text(Math.max(60, (process.stdout.columns || 120) - 4)) : text,
      { channel: "panel", title })
  }

  async function switchActiveProvider(name) {
    state.providerType = name
    state.model = resolveProviderDefaultModel(ctx.configState.config, name, state.model)
    print(`provider switched: ${name} (model: ${state.model})`, { channel: "notice", topic: "switch" })
    const catalog = await loadProviderModelItems(ctx.configState, name)
    if (catalog.items.length > 1) {
      print(`  可用模型 (${catalog.source}${catalog.stale ? ", stale" : ""}): ` + catalog.items.map(m => m.model).join(", "))
    }
    if (catalog.warning) print(`  模型目录提示: ${catalog.warning}`)
    if (catalog.error) print(`  模型目录不可用: ${catalog.error}；仍可使用 /model <model-id> 手动设置`)
  }

  // --- Provider 选择模式：拦截输入 ---
  if (providerPicker) {
    const list = providerPicker
    const input = normalized
    // 用户改主意敲了别的命令 —— 取消选择模式，让命令正常执行，
    // 而不是把 "/help" 当 provider 名去匹配然后报「找不到」
    if (input.startsWith("/")) {
      if (setProviderPicker) setProviderPicker(null)
      print("  已退出 provider 选择。")
    } else {
      if (setProviderPicker) setProviderPicker(null)
      if (!input) { print("  已取消。"); return { exit: false } }
      let target = null
      const num = Number(input)
      if (!isNaN(num) && num >= 1 && num <= list.length) {
        target = list[num - 1]
      } else {
        target = list.find((p) => p === input)
      }
      if (!target) { print(`  找不到 provider: "${input}"（可用: ${list.join(", ")}）`); return { exit: false } }
      if (target === state.providerType) { print(`  "${target}" 已经是当前 provider。`); return { exit: false } }
      await switchActiveProvider(target)
      return { exit: false }
    }
  }

  // 0.7.3 起 `/provider add` 走提问浮层表单（wizard-form.mjs），输入由模态作用域
  // 直接接住 —— 这里曾有一个 `wizard?.active` 拦截分支，向导输入要先穿过模式
  // 自动路由、busy spinner 和 `@` 引用解析才能到它。表单化后那条路在结构上不存在。
  if (!normalized) return { exit: false }
  if (normalized === "/") return { exit: false }

  const runPromptTurn = ({ prompt, images = [] }) => presentPromptTurn({
    prompt,
    images,
    state,
    ctx,
    print,
    streamSink,
    showTurnStatus,
    signal,
    switchModeInPlace
  })

  // --- 命令分发 ---
  const hit = resolveCommand(normalized, BUILTIN_COMMANDS)
  if (hit) {
    const outcome = await hit.entry.run({
      line,
      normalized,
      name: hit.name,
      args: hit.args,
      state,
      ctx,
      print,
      showInfo,
      providersConfigured,
      customCommands,
      setCustomCommands,
      providerPicker,
      setProviderPicker,
      pendingImages,
      clearPendingImages,
      attachImage,
      streamSink,
      showTurnStatus,
      signal,
      suspendTui,
      openPanel,
      switchActiveProvider,
      switchModeInPlace,
      runPromptTurn
    })
    // `{ rewrite }` = 改写输入后继续走提示词路径（`/plan <目标>`、`/ultra <目标>`）。
    // 改写后的文本**不再**过一遍命令分发：它是用户交给模型的目标，不是命令。
    // 拆分前这里是「重新赋值 normalized 然后顺着流下去」，于是 `/ultra /model k3`
    // 会去切模型 —— 那是 `if` 顺序的副产物，不是设计。
    if (outcome && typeof outcome.rewrite === "string") normalized = outcome.rewrite
    else return outcome || { exit: false }
  }

  // --- 提示词路径：技能与自定义命令展开，然后跑一个回合 ---
  let prompt = normalized
  if (normalized.startsWith("$") || normalized.startsWith("/")) {
    const sigil = normalized.startsWith("$") ? "$" : "/"
    const body = normalized.slice(1)
    const [name, ...argTokens] = body.split(/\s+/)
    const args = argTokens.join(" ").trim()

    const skill = SkillRegistry.isReady() ? SkillRegistry.get(name) : null
    if (sigil === "$" || skill) {
      if (!skill) {
        print(`unknown skill: $${name}`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      const expanded = await SkillRegistry.execute(name, args, {
        cwd: process.cwd(),
        mode: state.mode,
        model: state.model,
        provider: state.providerType,
        config: ctx.configState?.config || null
      })
      if (!expanded) {
        print(`skill $${name} returned no output`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      // contextFork skills return { prompt, contextFork, model }
      if (typeof expanded === "object" && expanded.contextFork) {
        prompt = expanded.prompt || ""
        if (expanded.model) state.model = expanded.model
      } else {
        prompt = expanded
      }
    } else {
      // Fallback: check raw custom commands (in case SkillRegistry not ready)
      const custom = customCommands.find((item) => item.name === name)
      if (!custom) {
        print(`unknown slash command: /${name}`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      prompt = applyCommandTemplate(custom.template, args, {
        path: process.cwd(),
        mode: state.mode,
        provider: state.providerType,
        cwd: process.cwd(),
        project: basename(process.cwd())
      })
    }
  }

  // Include any pending clipboard images with this message
  const images = pendingImages.length ? [...pendingImages] : []
  if (clearPendingImages && images.length) clearPendingImages()

  return runPromptTurn({ prompt, images })
}

async function startLineRepl({ ctx, state, providersConfigured, customCommands, recentSessions, historyLines }) {
  const rl = createInterface({ input, output, history: historyLines, historySize: HIST_SIZE })
  let localCustomCommands = customCommands
  let localProviderPicker = null
  const entered = [...historyLines]
  const lastTurn = {
    tokenMeter: {
      estimated: false,
      turn: { input: 0, output: 0 },
      session: { input: 0, output: 0 },
      global: { input: 0, output: 0 }
    },
    cost: 0,
    context: null,
    longagent: null
  }

  console.log(renderStartupScreen({
    theme: ctx.themeState.theme,
    recentSessions,
    columns: Number(process.stdout.columns || 120)
  }))

  const lineActivityRenderer = createActivityRenderer({
    theme: ctx.themeState.theme,
    output: {
      appendLog: (text) => console.log(text),
      appendStreamChunk: (chunk) => process.stdout.write(chunk)
    }
  })
  lineActivityRenderer.start()

  let linePendingImages = []

  while (true) {
    const status = renderReplStatusLine({
      state,
      configState: ctx.configState,
      theme: ctx.themeState.theme,
      tokenMeter: lastTurn.tokenMeter,
      cost: lastTurn.cost,
      costSavings: lastTurn.costSavings,
      contextMeter: lastTurn.context,
      longagentState: lastTurn.longagent
    })

    const line = await collectInput(rl, `${status}\n> `)
    if (!line) continue
    entered.push(line)

    // `|| {}` 不是防御性冗余：调用点直接读 action 的字段，而命令分支曾经
    // 返回过裸 null（/agents、/tasks，v0.6.0 起），行模式这条 while 循环没有
    // try/catch，于是整个 REPL 崩在下一行的 action.cleared 上。归一化让
    // 「某个分支忘了返回对象」退化成无害的默认动作。
    const action = (await processInputLine({
      line,
      state,
      ctx,
      providersConfigured,
      customCommands: localCustomCommands,
      setCustomCommands: (next) => {
        localCustomCommands = next
      },
      providerPicker: localProviderPicker,
      setProviderPicker: (next) => { localProviderPicker = next },
      print: (text) => console.log(text),
      pendingImages: linePendingImages,
      clearPendingImages: () => { linePendingImages = [] },
      // 行模式没有可编辑的输入框，插不了标记 —— 退回「挂着，下一条消息带上」。
      attachImage: (block) => { linePendingImages.push(block); return "" }
    })) || {}

    if (action.cleared) clearScreen()
    if (action.dashboardRefresh) {
      const runtimeView = await buildReplRuntimeSnapshot({
        cwd: process.cwd(),
        state,
        customCommands: localCustomCommands,
        providers: providersConfigured,
        mcpRegistry: McpRegistry,
        skillRegistry: SkillRegistry,
        recoveryEnabled: ctx.configState.config.session?.recovery !== false
      })
      runtimeView.recentSessions = action.recentSessions || runtimeView.recentSessions
      console.log(
        renderReplDashboard({
          theme: ctx.themeState.theme,
          ...runtimeView
        })
      )
    }

    if (action.turnResult) {
      lastTurn.tokenMeter = action.turnResult.tokenMeter || lastTurn.tokenMeter
      lastTurn.cost = Number.isFinite(action.turnResult.cost) ? action.turnResult.cost : lastTurn.cost
      lastTurn.context = action.turnResult.context || null
      lastTurn.longagent = action.turnResult.longagent || null
    }

    if (action.exit) break
  }

  lineActivityRenderer.stop()
  rl.close()
  await saveHistoryLines(HIST_FILE, HIST_SIZE, entered)
}

function startTuiFrame(features) {
  output.write(enterTerminalSequence(features))
}

function stopTuiFrame(features) {
  output.write(exitTerminalSequence(features))
}

function hasShiftEnterSequence(dataChunk) {
  const text = Buffer.isBuffer(dataChunk) ? dataChunk.toString("utf8") : String(dataChunk || "")
  if (!text || text.length < 2) return false
  return (
    text.includes("\x1b[13;2u") ||
    text.includes("\x1b[27;2;13~") ||
    text.includes("\x1b[13;2~")
  )
}

function isCommandLikeInput(line) {
  const value = String(line || "").trimStart()
  return value.startsWith("/") || value.startsWith("$")
}


async function startTuiRepl({ ctx, state, providersConfigured, customCommands, recentSessions, historyLines, mcpStatusLines = [], startupUpdatePromise = null }) {
  let localCustomCommands = customCommands
  let localRecentSessions = recentSessions
  const terminalFeatures = resolveTerminalFeatures(ctx.configState.config.ui?.terminal || {})
  const transcript = createTranscriptModel({ maxItems: MAX_TUI_LOG_LINES })
  const toastStore = createToastStore({
    durationMs: Number(ctx.configState.config.ui?.terminal?.toast_duration_ms || 2600),
    maxToasts: 3
  })
  for (const line of mcpStatusLines) transcript.appendLog(sanitizeTerminalStyledText(line))

  // TUI 状态。形状与浮层互斥不变量在 repl/ui-state.mjs（有独立测试）。
  const ui = createReplUiState({ historyLines, terminalFeatures })
  // 补全候选的唯一来源。构造在这里是安全的：它不捕获任何后面才声明的闭包，
  // 而文件索引在里面是懒的 —— 第一次真的需要文件候选才走盘，启动时不扫。
  const suggestionSource = createSuggestionSource({
    getSlashOptions: () => slashRouterOptions(localCustomCommands)
  })
  const currentSuggestions = () => suggestionSource.compute(ui.input, ui.inputCursor)
  let protocolFlushTimer = null
  let clipboardAbortController = null
  let disposed = false
  // spinner 是否要在 SIGCONT 之后接着转 —— 终端状态归 terminal-session 管，
  // 但 spinner 属于渲染层，所以这一位留在这里。
  let resumeSpinnerAfterContinue = false
  let onResize = null
  let onKey = null
  let onData = null
  let onSigint = null
  let onTerminate = null
  let onSigbreak = null
  let onProcessExit = null
  let onSuspend = null
  let onContinue = null

  /**
   * 一次性进程级监听器的登记本：挂上就登记好怎么摘。
   *
   * 此前挂载散在四处、释放是 `finally` 里十行 `if (onX) removeListener(...)`
   * 加 win32/posix 分支 —— 一份必须和挂载保持同步的手写清单。漏一项的后果是
   * 进程不退出，或者退出后仍在响应信号。
   *
   * keypress / data 不走这里：它们随终端激活与挂起反复装卸，生命周期是「多次」。
   */
  const listeners = createListenerRegistry()

  /**
   * 帧调度。差分绘制的状态（上一帧、上次宽度、是否强制全量、定时器）都关在
   * 模块里 —— 此前是这个闭包里六个谁都能改的裸 `let`。
   *
   * `canPaint` 是终端层的话事权：挂起（Ctrl+Z）或已 dispose 时写转义序列会污染
   * 用户的 shell，所以「现在能不能画」由这里回答，而不是让调度器自己去猜。
   */
  const renderScheduler = createRenderScheduler({
    buildFrame: () => buildFrame(),
    write: (text) => output.write(text),
    renderFrame: renderTerminalFrame,
    canPaint: () => !disposed && !terminal.isSuspended(),
    frameIntervalMs: TUI_FRAME_MS,
    spinnerIntervalMs: 120,
    onSpinnerTick: () => {
      ui.spinnerIndex = (ui.spinnerIndex + 1) % BUSY_SPINNER_FRAMES.length
    }
  })
  // 解构出来沿用原名：requestRender 单在 onKey 里就有 63 个调用点，
  // 改成 renderScheduler.requestRender 只是让每一处都变长，不增加任何清晰度。
  const {
    requestRender,
    paintFrame,
    cancelPendingFrame,
    startBusySpinner,
    stopBusySpinner
  } = renderScheduler

  /**
   * 输出通道。实现在 repl/transcript-writer.mjs —— 消毒规则与通道路由
   * 在那里有独立测试（此前它们在这个闭包里，测不到）。
   */
  const transcriptWriter = createTranscriptWriter({ transcript, toastStore })
  const {
    appendLog,
    updateLog,
    showToast,
    print: printTui,
    sanitizeRecord: sanitizeTranscriptRecord
  } = transcriptWriter

  notifyUpdateToast({ promise: startupUpdatePromise, showToast })

  /**
   * 回溯上一轮对话。撤回的那句输入会填回输入框 —— 「退回去改一下再问」
   * 应该是一步，而不是先退再重打一遍。
   */
  async function handleRewind() {
    if (ui.busy) {
      showToast("正在生成中，先按 Esc 中断", { topic: "rewind", tone: "warning" })
      return
    }
    try {
      const result = await rewindLastTurn(state.sessionId)
      if (!result.ok) {
        showToast(result.reason === "empty_session" ? "会话是空的，没有可回溯的内容" : "没有可回溯的轮次", {
          topic: "rewind",
          tone: "info"
        })
        return
      }
      // 对话记录同步回退到上一条用户输入之前（含它本身）
      const items = transcript.getItems()
      const lastUserIndex = items.findLastIndex((item) => item.kind === "user")
      if (lastUserIndex >= 0) {
        for (const item of items.slice(lastUserIndex)) transcript.removeLog(item.id)
      }

      if (result.prompt) {
        ui.input = result.prompt
        ui.inputCursor = result.prompt.length
      }
      showToast(`已回溯一轮（${result.removed} 条消息）· 文件改动请用 /undo`, {
        topic: "rewind",
        tone: "success"
      })
    } catch (error) {
      showToast(`回溯失败：${error?.message || error}`, { topic: "rewind", tone: "error" })
    }
    requestRender()
  }

  function appendStreamChunk() {
    // Provider text/thinking is consumed from typed EventBus deltas below.
    // Keeping the sink avoids direct stdout writes while the TUI owns the
    // screen and prevents a second Markdown rendering pass.
  }

  function renderToastLine() {
    const toast = toastStore.getToasts({ pruneExpired: false }).at(-1)
    if (!toast) return null
    const palette = {
      success: ctx.themeState.theme.semantic.success,
      warning: ctx.themeState.theme.semantic.warn,
      error: ctx.themeState.theme.semantic.error,
      info: ctx.themeState.theme.semantic.info
    }
    const symbols = { success: "✓", warning: "!", error: "✗", info: "●" }
    const tone = toast.tone in palette ? toast.tone : "info"
    return `${paint(symbols[tone], palette[tone], { bold: true })} ${paint(toast.message, palette[tone])}`
  }

  function applyThinkingTransition(transition) {
    ui.thinking = transition.state
    if (!transition.completed) return null
    const item = buildThinkingTranscriptItem({
      ...transition.completed,
      raw: sanitizeTerminalText(transition.completed.raw)
    })
    const id = appendLog(
      paint(item.summary, "#8a8a8a", { dim: true }),
      {
        ...item,
        details: item.details.map((line) => paint(`  ${line}`, "#777777"))
      }
    )
    ui.lastThinkingId = id
    return id
  }

  function finalizeThinking(now = Date.now()) {
    return applyThinkingTransition(finishThinkingState(ui.thinking, { now }))
  }

  function renderTextStreamFrame() {
    if (!ui.streamLogId && !ui.streamRaw) return
    const rendered = ctx.configState.config.ui?.markdown_render !== false
      ? renderMarkdown(ui.streamRaw)
      : sanitizeTerminalText(ui.streamRaw)
    if (!ui.streamLogId) {
      ui.streamLogId = appendLog(rendered, { kind: "assistant", status: "streaming" })
    } else {
      updateLog(ui.streamLogId, { summary: rendered, status: "streaming" })
    }
  }

  const textStreamBatcher = createFrameBatcher({
    flush: renderTextStreamFrame,
    frameMs: TUI_FRAME_MS
  })

  const ghostPredictor = createGhostPredictor({
    configState: ctx.configState,
    onGhost(ghost, forInput) {
      // 双保险：predictor 已经比对过，这里再确认一次 UI 侧输入没变
      if (ui.input !== forInput || ui.busy) return
      ui.ghostText = ghost
      requestRender()
    }
  })

  function finalizeTextStream(status = "complete") {
    textStreamBatcher.flushNow()
    if (ui.streamLogId) updateLog(ui.streamLogId, { status })
    ui.streamLogId = null
    ui.streamRaw = ""
  }

  const activityRenderer = createActivityRenderer({
    theme: ctx.themeState.theme,
    output: { appendLog, updateLog, appendStreamChunk },
    eventFilter: (event) =>
      (!event?.sessionId || event.sessionId === state.sessionId) &&
      shouldApplyActiveTurnEvent(event, {
        sessionId: state.sessionId,
        turnId: ui.activeTurnId
      })
  })

  // 注意：这里曾有一句 `if (ui.scrollOffset === 0) ui.scrollOffset = 0` ——
  // 可证明的空操作。它想表达的是「用户在底部时保持跟随」，但 scrollOffset 是
  // 到底部的距离，追加内容本来就不会改它，所以跟随是自动的。真正没实现的是
  // 反面：用户**已经向上滚**时来了新内容，视图会跟着往下漂（偏移量没随之增加）。
  const transcriptUnsub = transcript.subscribe(() => {
    requestRender()
  })
  // toast 过期要自己触发重绘。此前 store 的 subscribe 无人订阅 —— 空闲时
  // 一条提示会一直挂在屏幕上，直到用户碰下一个键才消失（忙碌时 spinner
  // 的定时重绘恰好掩盖了这一点，所以从没被注意到）。
  const toastUnsub = toastStore.subscribe(() => requestRender())

  /**
   * 会话事件 → TUI 状态。实现在 repl/event-bridge.mjs。
   *
   * 这里原本还有一句 `ui.appState = reduceAppState(ui.appState, event)` ——
   * 一套完整的 reducer，但全代码库没有一处读它（渲染走的是 transcript 模型）。
   * 实测 200 轮之后它持有 2.8 MB、200 个 block，无上限。已删除。
   */
  /**
   * 通知：终端标题、响铃、桌面通知。实现在 repl/notify.mjs。
   *
   * 构造在事件订阅之前，因为事件桥要拿着它 —— 传 null 就是完全不通知，
   * 所以这条依赖是可选的，行模式与测试都不必造一个假的。
   */
  const notifier = createNotifier({ config: ctx.configState.config })
  // 走登记本而不是往两处退出路径各加一行 —— 那正是 0.6.20 修掉的形状。
  // 不恢复标题的话，用户退出后终端标签页会一直挂着上一次的思考状态。
  listeners.add(() => notifier.dispose())

  const uiEventUnsub = subscribeSessionEvents({
    eventBus: EventBus,
    ui,
    ctx,
    state,
    notifier,
    toastStore,
    textStreamBatcher,
    requestRender,
    appendLog,
    showToast,
    applyThinkingTransition,
    finalizeThinking,
    finalizeTextStream
  })
  // Subscribe activity logs after typed stream state so a completed Thinking
  // block is inserted before the tool block that follows it.
  activityRenderer.start()

  /**
   * 工具层的两种模态提示（权限审批、提问）。实现在 repl/prompt-queue.mjs。
   *
   * 它们不参与用户浮层的互斥：每一条背后都挂着一个没有 settle 的 Promise，
   * 顺手关掉一个，那次工具调用就永远悬着。
   */
  const prompts = createPromptQueue({ ui, requestRender, notifier })
  const {
    queuePermissionPrompt,
    resolvePermissionPrompt,
    queueQuestionPrompt,
    commitCurrentQuestionAnswer,
    advanceOrSubmitQuestion,
    resolveQuestionPrompt,
    questionAcceptsTextInput,
    insertQuestionText,
    settlePendingPromptsForExit
  } = prompts


  function abortTurnAndPromptsForExit() {
    if (ui.turnAbortController) {
      ui.turnAbortController.abort()
      ui.turnAbortController = null
    }
    settlePendingPromptsForExit()
  }

  /**
   * 六个用户浮层的开/关/确认。实现在 repl/overlay-controller.mjs。
   * 互斥由 ui-state 的 openUserOverlay 保证；这里管各自的内容与确认动作。
   */
  const overlays = createOverlayController({
    ui,
    state,
    ctx,
    requestRender,
    showToast,
    submitCurrentInput: () => submitCurrentInput(),
    selectModeAndNotify: (modeId) => selectModeAndNotify(modeId),
    clearPermissionSession: (sessionId) => PermissionEngine.clearSession(sessionId)
  })
  const {
    openProviderPicker, closeProviderPicker, confirmProviderPicker,
    openSessionPicker, closeSessionPicker, confirmSessionPicker,
    openModelPicker, closeModelPicker, confirmModelPicker,
    openInfoPanel, closeInfoPanel, scrollInfoPanel, relayoutInfoPanel,
    openModePicker, closeModePicker, confirmModePicker,
    openPolicyPicker, closePolicyPicker, confirmPolicyPicker
  } = overlays


  function setInputFromHistory(value) {
    ui.input = value || ""
    ui.inputCursor = ui.input.length
    onInputChanged()
  }

  function insertAtCursor(text) {
    if (!text) return
    const head = ui.input.slice(0, ui.inputCursor)
    const tail = ui.input.slice(ui.inputCursor)
    ui.input = `${head}${text}${tail}`
    ui.inputCursor += text.length
    onInputChanged()
  }

  // 附件动作（粘图 / 粘长文本 / 提交前解析）在 repl/attachment-input.mjs。
  // 构造点必须在 showToast 之后 —— 它是上面解构出来的 const，早一步就是 TDZ，
  // 而 TDZ 在这个闭包里的表现是「单测全绿、TUI 起不来」（0.6.23 栽过一次）。
  const { attachImage, insertPastedText, resolveAttachments } = createAttachmentInput({
    store: ui.attachments,
    insertAtCursor,
    showToast
  })

  // 待发队列（模型干活时敲的消息）。实现在 repl/prompt-outbox.mjs。
  const outbox = createPromptOutbox({ ui, showToast, requestRender })

  /**
   * 提交，然后把排队的消息依次发完。
   *
   * 包在 `submitCurrentInput` **外面**而不是写进去：那个函数已经是 86 个判定点的
   * 回合状态机，被结构守卫的棘轮盯着只能变简单。排干的循环与它没有任何共享状态，
   * 放外面既不碰它的复杂度，也让「排队」这件事在一个地方读得完。
   */
  async function submitAndDrain() {
    await submitCurrentInput()
    await outbox.drain(async (text) => {
      // 按过 Esc 就是不想让它继续 —— 排在后面的都不该再发出去
      if (ui.paused) {
        outbox.clear()
        return
      }
      ui.input = text
      ui.inputCursor = text.length
      await submitCurrentInput()
    })
  }

  /**
   * 任何改动输入内容的路径都必须经过这里：作废当前 ghost 并重新排期预测。
   * 陈旧的 ghost 比没有 ghost 更糟——它会让用户以为按 Tab 补的是别的内容。
   */
  function onInputChanged() {
    if (ui.ghostText) {
      ui.ghostText = ""
      requestRender()
    }
    ghostPredictor?.schedule(ui.input, {
      busy: ui.busy,
      modal: Boolean(ui.pendingPermission || ui.pendingQuestion || ui.modelPicker || ui.policyPicker || ui.modePicker)
    })
  }

  function acceptGhost() {
    if (!ui.ghostText) return false
    const ghost = ui.ghostText
    ui.ghostText = ""
    ui.input += ghost
    ui.inputCursor = ui.input.length
    ghostPredictor?.cancel()
    requestRender()
    return true
  }

  function moveCursor(delta) {
    ui.inputCursor = moveGraphemeCursor(ui.input, ui.inputCursor, delta)
  }

  function setCursor(pos) {
    ui.inputCursor = Math.max(0, Math.min(ui.input.length, pos))
  }

  function scrollBy(delta) {
    const max = ui.scrollMeta.maxOffset || 0
    ui.scrollOffset = Math.max(0, Math.min(max, ui.scrollOffset + delta))
  }

  function scrollToTop() {
    ui.scrollOffset = ui.scrollMeta.maxOffset || 0
  }

  function scrollToBottom() {
    ui.scrollOffset = 0
  }

  // Request OSC 52 and try a platform clipboard command. OSC 52 itself cannot
  // confirm whether the terminal accepted the request, so only a successful
  // native fallback may use definitive "Copied" wording.
  async function copyToClipboard(text) {
    clipboardAbortController?.abort()
    const controller = new AbortController()
    clipboardAbortController = controller
    const result = await copyTerminalText(text, {
      output,
      signal: controller.signal
    })
    if (clipboardAbortController === controller) {
      clipboardAbortController = null
    }
    if (disposed || controller.signal.aborted) return result
    if (result.confirmed) {
      showToast("Copied selection", { topic: "clipboard", tone: "success" })
    } else if (result.requested) {
      showToast("Copy requested · terminal approval may be required", {
        topic: "clipboard",
        tone: "info",
        durationMs: 4200
      })
    } else {
      showToast("Copy failed · use the terminal copy shortcut", {
        topic: "clipboard",
        tone: "error",
        durationMs: 5000
      })
    }
    return result
  }

  // 从渲染后的屏幕行中提取纯文本（用于选择复制）
  // 对屏幕行数组应用选择高亮（反色）。选区存的是 transcript 绝对行，
  // 这里换算回当前视口的屏幕行；滚出视口的部分自然不绘制。
  function applySelectionHighlight(frameLines, sel) {
    if (!sel) return
    const {
      startRow: a1,
      startCol: c1,
      endRow: a2,
      endCol: c2,
      isClick
    } = normalizeMouseSelection({
      startRow: (sel.startAbs ?? 0) + 1,
      startCol: sel.startCol,
      endRow: (sel.endAbs ?? 0) + 1,
      endCol: sel.endCol,
      moved: sel.moved
    })
    if (isClick) return

    for (let abs = a1; abs <= a2; abs++) {
      const r = screenRowFromAbsolute(abs, ui.layoutMeta)
      if (r === null || r < 0 || r >= frameLines.length) continue
      const plain = stripAnsi(frameLines[r])
      const sc = abs === a1 ? c1 : 0
      const ec = abs === a2 ? c2 : displayWidth(plain)
      if (sc >= ec || sc >= displayWidth(plain)) continue

      const { before, selected, after } = splitTextByCellRange(plain, sc, ec)
      // \x1b[7m = 反色开始, \x1b[27m = 反色结束
      frameLines[r] = before + "\x1b[7m" + selected + "\x1b[27m" + after
    }
  }

  function buildFrame() {
    // 宽高在这里读一次并传下去 —— frame-builder 不碰 process.stdout，
    // 所以任意宽度都能在测试里断言（见 test/frame-builder.test.mjs）。
    return buildFrameLines({
      ui,
      ctx,
      state,
      transcript,
      width: Number(process.stdout.columns || 120),
      height: Number(process.stdout.rows || 40),
      suggestions: currentSuggestions(),
      applySelectionHighlight,
      renderToastLine
    })
  }

  let pendingPlanBuild = null

  async function submitCurrentInput() {
    const line = ui.input.replace(/\r/g, "")
    if (!line.trim() || ui.busy) return
    // 提交即作废预测：在途请求的结果对下一轮输入毫无意义
    ui.ghostText = ""
    ghostPredictor.cancel()
    ensureEventSinks()

    // --- Task 3: 处理中途补充需求确认 ---
    if (ui.pendingModeConfirm && !isCommandLikeInput(line)) {
      const confirm = ui.pendingModeConfirm
      ui.pendingModeConfirm = null
      const answer = line.trim().toLowerCase()
      const confirmed = ["y", "yes", "是", "继续", "ok", "好"].includes(answer)
      if (confirmed) {
        // 用户确认继续用 longagent，清除 abort 状态
        ui.longagentAborted = false
        showToast("继续使用 LongAgent", { topic: "mode", tone: "success" })
        ui.input = ""
        ui.inputCursor = 0
        requestRender()
        return
      } else {
        // 用户拒绝，切换到建议模式
        state.mode = confirm.suggestedMode
        showToast(`Mode · ${confirm.suggestedMode}`, { topic: "mode", tone: "success" })
        ui.input = ""
        ui.inputCursor = 0
        requestRender()
        return
      }
    }

    if (ui.agentAborted && state.mode === "agent" && !isCommandLikeInput(line)) {
      const summary = ui.agentTransaction
      ui.agentAborted = false
      if (summary && line.trim()) {
        submittedLine = buildAgentContinuationPrompt(summary, line.trim())
        route = routeMode(submittedLine, state.mode, { continuation: summary, continued: true })
        await EventBus.emit({
          type: EVENT_TYPES.ROUTE_DECISION,
          sessionId: state.sessionId,
          payload: {
            ...(route.observability || {}),
            promptLength: submittedLine.length,
            continuedTransaction: true
          }
        })
        await EventBus.emit({
          type: EVENT_TYPES.AGENT_CONTINUATION_RESUMED,
          sessionId: state.sessionId,
          payload: {
            topology: route.topology,
            evidence: route.evidence,
            continuationCount: Number(summary.continuationCount || 0) + 1
          }
        })
        ui.agentTransaction = summarizeAgentTransaction({
          prompt: summary.objective || line,
          route,
          previous: {
            ...summary,
            continuationCount: Number(summary.continuationCount || 0) + 1
          }
        })
        appendLog(paint(`↻ 继续当前 agent 事务（${route.explanation || route.reason}）`, ctx.themeState.theme.semantic.info))
      }
    }

    // --- Task 3: 处理 longagent 中途补充需求 ---
    if (ui.longagentAborted && state.mode === "longagent" && !isCommandLikeInput(line)) {
      const originalPrompt = ui.lastLongAgentPrompt
      ui.longagentAborted = false
      ui.lastLongAgentPrompt = null
      if (originalPrompt && line.trim()) {
        // 合并原始需求 + 补充需求，从 H0 重新规划
        const mergedPrompt = `${originalPrompt}\n\n[补充需求]\n${line.trim()}`
        appendLog(paint("已合并补充需求，从头重新规划...", ctx.themeState.theme.semantic.info))
        ui.history.push(line)
        if (ui.history.length > HIST_SIZE) ui.history.splice(0, ui.history.length - HIST_SIZE)
        ui.historyIndex = ui.history.length
        appendLog(paint("❯ ", ctx.themeState.theme.semantic.success) + paint(line, ctx.themeState.theme.roles?.user), { kind: "user" })
        appendLog("")
        ui.input = ""
        ui.inputCursor = 0
        ui.selectedSuggestion = 0
        ui.suggestionOffset = 0
        ui.busy = true
        ui.paused = false
        const aborter = new AbortController()
        ui.turnAbortController = aborter
        ui.lastLongAgentPrompt = mergedPrompt
        startBusySpinner()
        requestRender()
        try {
          const action = (await processInputLine({
            ...resolveAttachments(mergedPrompt),
            state, ctx, providersConfigured,
            customCommands: localCustomCommands,
            setCustomCommands: (next) => { localCustomCommands = next },
            providerPicker: ui.providerPicker,
            setProviderPicker: (next) => {
              // TUI 里这个回调只用来退出选择态（传 null）；行模式的编号数组
              // 不会走到这里 —— 有 openPanel 时命令走的是浮层分支。
              if (next) openUserOverlay(ui, "providerPicker", next)
              else closeUserOverlay(ui, "providerPicker")
            },
            print: printTui,
            streamSink: appendStreamChunk,
            showTurnStatus: false,
            attachImage,
            signal: aborter.signal,
            suspendTui: withSuspendedTui,
            openPanel: openInfoPanel
          })) || {}
          if (action.turnResult) {
            ui.metrics.tokenMeter = action.turnResult.tokenMeter || ui.metrics.tokenMeter
            ui.metrics.cost = Number.isFinite(action.turnResult.cost) ? action.turnResult.cost : ui.metrics.cost
            ui.metrics.costSavings = action.turnResult.costSavings ?? 0
            if (action.turnResult.context) ui.metrics.context = action.turnResult.context
            ui.metrics.longagent = action.turnResult.longagent || null
            ui.metrics.toolEvents = action.turnResult.toolEvents || []
          }
          if (action.exit) ui.quitting = true
        } catch (error) {
          if (error.name !== "AbortError") appendLog(`error: ${sanitizeTerminalText(error.message)}`)
        } finally {
          finalizeThinking()
          finalizeTextStream()
          if (aborter.signal.aborted && state.mode === "longagent") {
            ui.longagentAborted = true
            ui.lastLongAgentPrompt = mergedPrompt
            appendLog(paint("⏸ LongAgent 已中止。输入补充需求后按 Enter 可从头重新规划，或切换模式继续。", ctx.themeState.theme.semantic.warn))
          }
          ui.busy = false
          ui.turnAbortController = null
          ui.currentActivity = null
          stopBusySpinner()
          requestRender()
        }
        return
      }
    }

    let submittedLine = line
    let activeAgentContinuation = null
    let routeRequestedMode = state.mode

    if (ui.paused && ui.agentContinuation && state.mode === "agent" && !isCommandLikeInput(line)) {
      activeAgentContinuation = ui.agentContinuation
      submittedLine = buildAgentContinuationPrompt(activeAgentContinuation, line)
      ui.agentContinuation = null
      ui.paused = false
      appendLog(paint("↻ 继续当前 agent 事务…", ctx.themeState.theme.semantic.info))
      if (activeAgentContinuation.pendingNextStep) {
        appendLog(paint(`   ${activeAgentContinuation.pendingNextStep}`, ctx.themeState.theme.base.muted, { dim: true }))
      }
      await emitAgentContinuationResumed({
        sessionId: state.sessionId,
        summary: activeAgentContinuation,
        continuation: line
      })
    }

    ui.history.push(line)
    if (ui.history.length > HIST_SIZE) ui.history.splice(0, ui.history.length - HIST_SIZE)
    ui.historyIndex = ui.history.length

    appendLog(paint("❯ ", ctx.themeState.theme.semantic.success) + paint(line, ctx.themeState.theme.roles?.user), { kind: "user" })
    appendLog("")
    ui.input = ""
    ui.inputCursor = 0
    ui.selectedSuggestion = 0
    ui.suggestionOffset = 0
    ui.busy = true
    ui.paused = false
    const aborter = new AbortController()
    ui.turnAbortController = aborter

    // --- Task 1: 自动路由 ---
    let route = null
    if (!isCommandLikeInput(line)) {
      routeRequestedMode = state.mode
      route = routeMode(submittedLine, state.mode)
      const routeFeedback = buildRouteFeedback({
        route,
        currentMode: state.mode,
        routeSummary: summarizeRouteDecision(route)
      })
      await emitRouteDecisionEvent({
        sessionId: state.sessionId,
        source: "repl",
        requestedMode: routeRequestedMode,
        route,
        prompt: submittedLine,
        continuedTransaction: Boolean(activeAgentContinuation)
      })
      if (routeFeedback.changedMessage) {
        showToast(stripAnsi(routeFeedback.changedMessage), { topic: "route", tone: "info" })
        state.mode = route.mode
      } else if (routeFeedback.forcedMessage) {
        // 用户强制 longagent 但任务看起来是简单任务 → 需要确认
        ui.pendingModeConfirm = { suggestedMode: route.suggestion, originalMode: state.mode, reason: route.reason }
        appendLog(paint(routeFeedback.forcedMessage, ctx.themeState.theme.semantic.warn))
        ui.busy = false
        ui.turnAbortController = null
        stopBusySpinner()
        requestRender()
        return
      } else if (routeFeedback.suggestionMessage) {
        showToast(stripAnsi(routeFeedback.suggestionMessage), { topic: "route", tone: "info" })
      } else if (routeFeedback.stayedMessage) {
        showToast(stripAnsi(routeFeedback.stayedMessage), { topic: "route", tone: "info" })
      }
      if (routeFeedback.summaryMessage) {
        showToast(stripAnsi(routeFeedback.summaryMessage), { topic: "route-summary", tone: "info" })
      }

      if (state.mode === "agent") {
        ui.agentContinuation = summarizeAgentTransaction({
          prompt: submittedLine,
          route,
          mode: state.mode
        })
      } else {
        ui.agentContinuation = null
      }
    }

    // 记录 longagent 原始 prompt（用于 Task 3 中途补充需求）
    if (state.mode === "longagent" && !isCommandLikeInput(line)) {
      ui.lastLongAgentPrompt = submittedLine
      ui.longagentAborted = false
      ui.agentTransaction = null
      ui.agentAborted = false
    } else if (state.mode === "agent" && !isCommandLikeInput(line)) {
      ui.agentTransaction = summarizeAgentTransaction({
        prompt: ui.agentTransaction?.objective || line,
        route,
        previous: ui.agentTransaction
      })
      ui.agentAborted = false
    } else if (!isCommandLikeInput(line)) {
      ui.agentTransaction = null
      ui.agentAborted = false
    }

    startBusySpinner()
    requestRender()

    try {
      const action = (await processInputLine({
        ...resolveAttachments(submittedLine),
        state,
        ctx,
        providersConfigured,
        customCommands: localCustomCommands,
        setCustomCommands: (next) => {
          localCustomCommands = next
        },
        providerPicker: ui.providerPicker,
        setProviderPicker: (next) => {
              // TUI 里这个回调只用来退出选择态（传 null）；行模式的编号数组
              // 不会走到这里 —— 有 openPanel 时命令走的是浮层分支。
              if (next) openUserOverlay(ui, "providerPicker", next)
              else closeUserOverlay(ui, "providerPicker")
            },
        print: printTui,
        streamSink: appendStreamChunk,
        showTurnStatus: false,
        attachImage,
        signal: aborter.signal,
        suspendTui: withSuspendedTui,
        openPanel: openInfoPanel
      })) || {}

      if (action.cleared) {
        transcript.clear()
      }
      if (action.dashboardRefresh) {
        localRecentSessions = action.recentSessions || localRecentSessions
        ui.showDashboard = true
        showToast("Dashboard refreshed", { topic: "dashboard", tone: "success" })
      }
      if (action.turnResult) {
        ui.metrics.tokenMeter = action.turnResult.tokenMeter || ui.metrics.tokenMeter
        ui.metrics.cost = Number.isFinite(action.turnResult.cost) ? action.turnResult.cost : ui.metrics.cost
        ui.metrics.costSavings = action.turnResult.costSavings ?? 0
        if (action.turnResult.context) ui.metrics.context = action.turnResult.context
        ui.metrics.longagent = action.turnResult.longagent || null
        ui.metrics.toolEvents = action.turnResult.toolEvents || []
        if (state.mode === "agent" && ui.agentTransaction) {
          ui.agentTransaction = summarizeAgentTransaction({
            prompt: ui.agentTransaction.objective || line,
            route,
            previous: ui.agentTransaction,
            toolEvents: action.turnResult.toolEvents || [],
            reply: action.turnResult.reply || ""
          })
        }
      }
      // logo 显示由 Ctrl+B 手动切换，不再自动隐藏
      if (action.openModelPicker) {
        openModelPicker(action.modelPickerItems)
      }
      if (action.openProviderPicker) {
        openProviderPicker(action.providerPickerItems)
      }
      if (action.openSessionPicker) {
        openSessionPicker(action.sessionPickerItems)
      }
      if (action.openPolicyPicker) {
        openPolicyPicker()
      }
      if (action.openModePicker) {
        openModePicker()
      }
      if (action.planHandoff?.modeId) {
        // switchModeInPlace 已经改过 state；这里只同步 UI 并排队续跑
        pendingPlanBuild = action.planHandoff
        showToast(`${action.planHandoff.icon} ${action.planHandoff.label} · 开始执行计划`, {
          topic: "mode",
          tone: "success"
        })
      }
      if (action.exit) {
        ui.quitting = true
      }
    } catch (error) {
      if (error.name !== "AbortError") appendLog(`error: ${sanitizeTerminalText(error.message)}`)
    } finally {
      finalizeThinking()
      finalizeTextStream()
      // Task 3: 检测 longagent 被中止，提示用户可补充需求
      if (aborter.signal.aborted && state.mode === "longagent" && ui.lastLongAgentPrompt) {
        ui.longagentAborted = true
        appendLog(paint("⏸ LongAgent 已中止。输入补充需求后按 Enter 可从头重新规划，或切换模式继续。", ctx.themeState.theme.semantic.warn))
      } else if (aborter.signal.aborted && state.mode === "agent" && ui.agentContinuation) {
        await emitAgentContinuationInterrupted({
          sessionId: state.sessionId,
          summary: ui.agentContinuation
        })
        appendLog(paint("⏸ Agent 已中止。直接输入补充内容即可继续当前本地事务，或输入命令切换模式。", ctx.themeState.theme.semantic.warn))
      }
      ui.busy = false
      ui.turnAbortController = null
      ui.currentActivity = null
      stopBusySpinner()
      requestRender()
    }

    // Plan → Build 交接：模式已切好，直接以计划文件为输入续跑一轮。
    // pendingPlanBuild 先清空，递归深度因此固定为 1。
    if (pendingPlanBuild && !ui.quitting && !aborter.signal.aborted) {
      const handoff = pendingPlanBuild
      pendingPlanBuild = null
      const planRef = handoff.planPath ? ` at ${handoff.planPath}` : ""
      ui.input = `Implement the approved plan${planRef}. Follow it stage by stage and report what you changed.`
      ui.inputCursor = ui.input.length
      await submitCurrentInput()
    }
  }

  function handleUpDownSuggestions(keyName) {
    const next = suggestionSource.nextSelection(currentSuggestions(), ui.selectedSuggestion, keyName)
    if (next === null) return false
    ui.selectedSuggestion = next
    return true
  }

  function navigateHistory(keyName) {
    const result = resolveHistoryNavigation(ui.history, ui.historyIndex, keyName)
    if (!result.changed) return
    ui.historyIndex = result.historyIndex
    setInputFromHistory(result.value)
  }

  function applyCurrentSuggestion() {
    // 写回语义按候选种类分派（命令整行替换、文件只换光标处那个 token），
    // 分派表在 suggestion-source 里 —— 这里只负责把结果装回 ui。
    const applied = suggestionSource.apply(ui.input, ui.inputCursor, currentSuggestions(), ui.selectedSuggestion)
    if (!applied) return
    ui.input = applied.text
    ui.inputCursor = applied.cursor
    onInputChanged()
  }

  function shouldApplySuggestionOnEnter() {
    return suggestionSource.shouldApplyOnEnter(ui.input, currentSuggestions(), ui.selectedSuggestion)
  }

  /**
   * 切换模式同时写两处：state.modeId（唯一真值）与 permission.level
   * （判定链读的审批档）。state.mode 保持航道值给既有消费者。
   */
  function selectModeAndNotify(modeId, { silent = false } = {}) {
    const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})
    const next = applyModeSelection(modeId, { permissionConfig: permission })
    state.modeId = next.modeId
    state.mode = next.mode
    ctx.configState.config.permission = next.permissionConfig
    if (!silent) {
      showToast(`${next.icon} ${next.label} · ${next.hint}`, { topic: "mode", tone: "success" })
    }
    requestRender()
    return next
  }

  function cycleModeForwardAndNotify() {
    selectModeAndNotify(nextModeId(state.modeId || resolveModeId(state.mode)))
  }



  /**
   * 浮层类按键的分派表。
   *
   * 此前这是 onKey 里 326 行的顺序 `if`，按键优先级的唯一载体是「哪个 if 写在
   * 前面」—— 比如「信息浮层打开时必须先吃掉 ↑↓，否则会同时滚浮层和翻输入历史」。
   * 现在优先级是有序数据，`describeOrder()` 能把它打出来，测试能断言它。
   */
  /**
   * `finish()` 定义在退出 Promise 内部，而生命周期按键（Ctrl+C 两连击、
   * Ctrl+D）需要它。用一个可后填的引用而不是把 finish 提到外面 —— 提出来
   * 就得把 resolve 也一起提出来，那会让退出路径更难读。
   */
  let requestExitFn = () => {}

  // 鼠标模块必须建在按键分派器之前：分派器**按值**捕获 deleteInputSelection、
  // finishSelection 这些函数，晚一步声明就是 TDZ —— 而它只在 TUI 真正启动时才炸，
  // 单测走不到（本次就是被 e2e 的「TUI 没进备用屏」抓到的）。
  /**
   * 屏幕行 → transcript 绝对行。选区锚点必须存绝对行，否则边选边滚时
   * 屏幕行下的内容会变，松手取到的就是另一段文字。
   */
  /**
   * 鼠标交互：日志区选择、输入框光标与拖选、边缘自动滚动。
   * 实现在 repl/mouse-selection.mjs —— 两个定时器与拖拽状态此前是这个闭包里的
   * 裸 `let`，两千行内任何一段都能改它们。
   */
  const mouse = createMouseSelection({
    ui,
    transcript,
    requestRender,
    scrollBy,
    copyToClipboard,
    onInputChanged,
    lastPaintedFrame: () => renderScheduler.lastPaintedFrame(),
    isDisposed: () => disposed
  })
  const {
    handleMouseEvent,
    clearSelections,
    deleteInputSelection,
    finishSelection,
    stopAutoScroll
  } = mouse

  const { dispatchKey: dispatchLifecycleKey } = createKeyDispatcher({
    scopes: [createLifecycleKeyScope({
      requestRender,
      appendLog,
      showToast,
      finishSelection,
      copyToClipboard,
      suspendForJobControl,
      requestExit: () => requestExitFn(),
      state
    })]
  })

  const { dispatchKey } = createKeyDispatcher({
    scopes: [
      ...createOverlayKeyScopes({
      requestRender,
      closeInfoPanel,
      scrollInfoPanel,
      resolvePermissionPrompt,
      resolveQuestionPrompt,
      commitCurrentQuestionAnswer,
      advanceOrSubmitQuestion,
      insertQuestionText,
      moveGraphemeCursor,
      closeProviderPicker,
      confirmProviderPicker,
      closeSessionPicker,
      confirmSessionPicker,
      closeModelPicker,
      confirmModelPicker,
      closePolicyPicker,
      confirmPolicyPicker,
      closeModePicker,
      confirmModePicker,
      PERMISSION_PROMPT_VALUES,
      POLICY_CHOICES,
      MODE_PICKER_CHOICES
      }),
      createScrollKeyScope({
        requestRender,
        scrollBy,
        scrollToTop,
        scrollToBottom,
        pageSize,
        appendLog,
        state
      }),
      createEditorKeyScope({
        requestRender,
        showToast,
        transcript,
        insertAtCursor,
        attachImage,
        insertPastedText,
        // 忙碌时 Enter 走排队而不是提交；提交则换成「发完再把队列排干」的包装。
        queuePrompt: outbox.queue,
        deleteInputSelection,
        moveCursor,
        setCursor,
        moveGraphemeCursor,
        onInputChanged,
        acceptGhost,
        cancelGhost: () => ghostPredictor?.cancel(),
        hasSuggestions: (uiState) =>
          suggestionSource.compute(uiState.input, uiState.inputCursor).items.length > 0,
        shouldApplySuggestionOnEnter,
        applyCurrentSuggestion,
        handleUpDownSuggestions,
        navigateHistory,
        submitCurrentInput: submitAndDrain,
        requestExitIfQuitting: () => { if (ui.quitting) requestExitFn() },
        cycleModeForwardAndNotify,
        handleRewind,
        readClipboardImage,
        readClipboardText,
        doubleEscapeMs: DOUBLE_ESCAPE_MS
      })
    ]
  })

  // Monkey-patch stdin.emit 拦截鼠标事件，防止 readline 将其解析为键盘输入
  const _origStdinEmit = process.stdin.emit
  /**
   * 鼠标 → 焦点 → 括号粘贴。实现在 repl/input-decoders.mjs —— 三层各自扣着的
   * 跨 chunk 尾字节要按下游顺序放出来，写在这里过一次就会漏一层。
   */
  const inputDecoders = createInputDecoderChain({
    features: terminalFeatures,
    onMouseEvent: handleMouseEvent,
    onFocus: (focused) => notifier.setFocused(focused)
  })

  function dispatchPasteResult(pasted, mouseEventCount = 0, {
    immediateEscape = false
  } = {}) {
    for (const value of pasted.pastes) {
      if (questionAcceptsTextInput()) {
        insertQuestionText(value)
      } else if (!ui.busy) {
        insertPastedText(value)
      }
    }
    if (mouseEventCount > 0 || pasted.pastes.length > 0) requestRender()
    if (!pasted.text) return false
    if (immediateEscape && pasted.text === "\x1b") {
      return _origStdinEmit.call(process.stdin, "keypress", "\x1b", {
        sequence: "\x1b",
        name: "escape",
        ctrl: false,
        meta: false,
        shift: false
      })
    }
    return _origStdinEmit.call(
      process.stdin,
      "data",
      Buffer.from(pasted.text, "utf8")
    )
  }

  function cancelProtocolFlush() {
    if (protocolFlushTimer) clearTimeout(protocolFlushTimer)
    protocolFlushTimer = null
  }

  function scheduleProtocolFlush() {
    if (!inputDecoders.hasPending()) return
    cancelProtocolFlush()
    protocolFlushTimer = setTimeout(() => {
      protocolFlushTimer = null
      if (disposed || terminal.isSuspended()) return
      dispatchPasteResult(inputDecoders.flush(), 0, { immediateEscape: true })
    }, ESCAPE_SEQUENCE_TIMEOUT_MS)
    protocolFlushTimer.unref?.()
  }

  const interceptStdinEmit = function (event, ...args) {
    if (event === "data") {
      cancelProtocolFlush()
      const decoded = inputDecoders.feed(args[0])
      const emitted = dispatchPasteResult(decoded, decoded.mouseEvents)
      scheduleProtocolFlush()
      return emitted
    }
    return _origStdinEmit.call(process.stdin, event, ...args)
  }



  function detachTuiInputListeners() {
    if (onKey) process.stdin.removeListener("keypress", onKey)
    if (onData) process.stdin.removeListener("data", onData)
  }

  function attachTuiInputListeners() {
    // 先摘再挂：重复挂载会让每个按键触发两次
    if (onKey) {
      process.stdin.removeListener("keypress", onKey)
      process.stdin.on("keypress", onKey)
    }
    if (onData) {
      process.stdin.removeListener("data", onData)
      process.stdin.on("data", onData)
    }
  }

  /**
   * 终端设备的所有权。实现在 repl/terminal-session.mjs —— 原始模式、备用屏、
   * stdin 补丁都是**进程外部状态**，做错了坏的是用户的 shell，不只是显示。
   */
  const terminal = createTerminalSession({
    features: terminalFeatures,
    startFrame: startTuiFrame,
    stopFrame: stopTuiFrame,
    emitKeypressEvents,
    interceptStdinEmit,
    originalStdinEmit: _origStdinEmit,
    decoders: [inputDecoders],
    keypressEscapeTimeoutMs: KEYPRESS_ESCAPE_TIMEOUT_MS,
    cancelPendingFrame,
    cancelProtocolFlush,
    detachInputListeners: detachTuiInputListeners,
    attachInputListeners: attachTuiInputListeners,
    abortClipboard: () => {
      clipboardAbortController?.abort()
      clipboardAbortController = null
    },
    repaint: () => {
      renderScheduler.forceNextPaintFull()
      paintFrame(buildFrame())
    },
    isDisposed: () => disposed
  })

  const deactivateTerminal = (options) => terminal.deactivate(options)
  const activateTerminal = (options) => terminal.activate(options)

  /** 把终端暂时还给 cooked 模式的提示（向导、引导流程），期间不许有人画上去。 */
  async function withSuspendedTui(fn) {
    const shouldResumeSpinner = renderScheduler.isSpinnerRunning()
    stopBusySpinner()
    return terminal.withSuspended(fn, {
      onResume: () => { if (shouldResumeSpinner && ui.busy) startBusySpinner() }
    })
  }

  function suspendForJobControl() {
    const shouldResumeSpinner = renderScheduler.isSpinnerRunning() && terminal.isFrameActive()
    terminal.suspendForJobControl({
      beforeSuspend: () => {
        stopBusySpinner()
        // 挂起期间收不到鼠标事件，自动滚动必须停，否则恢复后仍在滚
        stopAutoScroll()
        resumeSpinnerAfterContinue = shouldResumeSpinner
      }
    })
  }

  function continueAfterJobControl() {
    const resumed = terminal.continueAfterJobControl()
    if (resumed && resumeSpinnerAfterContinue && ui.busy) startBusySpinner()
    resumeSpinnerAfterContinue = false
  }


  onSuspend = suspendForJobControl
  onContinue = continueAfterJobControl
  // SIGTSTP 由 terminal-session 在挂起/恢复时自己摘挂 —— 它是「有意反复装卸」
  // 的那一类，不归监听器登记本管。
  terminal.registerJobControlHandlers({ onSuspend, onResume: () => {} })
  if (process.platform !== "win32") {
    listeners.on(process, "SIGTSTP", onSuspend)
    listeners.on(process, "SIGCONT", onContinue)
  }

  try {
    // `exit` is the last synchronous point at which Node can give the shell
    // back a usable terminal after process.exit() or an uncaught exception.
    // Keep this guard installed before entering the alternate screen so even
    // a startup failure cannot strand raw mode, mouse tracking, or the cursor.
    onProcessExit = () => {
      deactivateTerminal()
    }
    listeners.on(process, "exit", onProcessExit)
    setPermissionPromptHandler(({ tool, sessionId, reason = "", pattern = "*", command = "", args = {}, risk = 0, defaultAction = "deny" }) =>
      new Promise((resolve) => {
        queuePermissionPrompt({
          tool,
          sessionId,
          reason,
          pattern,
          command,
          args,
          risk,
          defaultAction,
          resolve
        })
      })
    )
    PermissionEngine.setPersistGrantHandler(async ({ tool, pattern, command, workspace }) => {
      const result = await persistLearnedGrant({ ctx, tool, pattern, command, workspace })
      if (result.added) {
        showToast(`Always allow · ${describeRule(result.rule)}`, { topic: "permission", tone: "success" })
      } else if (result.reason === "limit") {
        showToast(`习得规则已达上限，请先 /permission forget`, { topic: "permission", tone: "warn" })
      }
      return result.added
    })
    setQuestionPromptHandler(({ questions }) =>
      new Promise((resolve) => {
        queueQuestionPrompt({ questions, resolve })
      })
    )
    activateTerminal()
    paintFrame(buildFrame())
  } catch (error) {
    disposed = true
    cancelPendingFrame()
    // 选区高亮定时器与边缘自动滚动一起停 —— 后者是「进程不退出」的经典来源
    mouse.dispose()
    textStreamBatcher.dispose()
    ghostPredictor.dispose()
    deactivateTerminal({ pauseInput: true })
    setPermissionPromptHandler(null)
    setQuestionPromptHandler(null)
    stopBusySpinner()
    activityRenderer.stop()
    uiEventUnsub()
    transcriptUnsub()
    toastUnsub()
    toastStore.dispose()
    await saveHistoryLines(HIST_FILE, HIST_SIZE, ui.history).catch(() => {})
    // 错误路径的清理与正常退出走同一个登记本，不再各写一份
    listeners.disposeAll()
    onProcessExit = null
    throw error
  }

  try {
    await new Promise((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        ui.quitting = true
        abortTurnAndPromptsForExit()
        finished = true
        resolve()
      }
      // 生命周期按键（Ctrl+C 两连击、Ctrl+D）要能触发退出，而 finish 只在这个
      // 作用域里存在 —— 把它填给上面建好的分派器。
      requestExitFn = finish

      onResize = () => {
        // 浮层内容若是按内宽排版出来的（自带边框的面板），resize 后必须重排 ——
        // 否则新宽度下它的边框会被外层折行折断。
        relayoutInfoPanel()
        requestRender({ force: true })
      }
      onKey = async (str, key = {}) => {
        if (ui.quitting) return

        // 任意按键清除日志区鼠标选择（不清除输入框选择，由具体按键处理）。
        // 这是分派之前的副作用，不是处理器 —— 它对所有按键都发生，而且不消费按键。
        // 注意它必须排在 lifecycle 之后：Ctrl+C 在选区存在时的含义是「复制」，
        // 先清掉选区就把那条规则抹了。
        const beforeLifecycle = await dispatchLifecycleKey({ ui, key, str })
        if (beforeLifecycle.handled) return
        if (ui.mouseSelection) {
          ui.mouseSelection = null
          requestRender()
        }

        const result = await dispatchKey({ ui, key, str })
        if (result.handled) return
      }
      onData = async (chunk) => {
        if (ui.quitting) return
        if (ui.busy) return
        if (!hasShiftEnterSequence(chunk)) return
        insertAtCursor("\n")
        requestRender()
      }
      onSigint = () => {
        const now = Date.now()
        if (ui.busy) {
          if (ui.turnAbortController) {
            ui.turnAbortController.abort()
            ui.turnAbortController = null
          }
          ui.paused = true
          appendLog(state.mode === "agent"
            ? "[paused] agent turn interrupted — enter a follow-up message to continue the same task"
            : "[paused] turn interrupted — enter a new message or command to continue")
          requestRender()
          return
        }
        if (now - ui.lastCtrlCTime < 2000) {
          finish()
        } else {
          ui.lastCtrlCTime = now
          showToast("Press Ctrl+C again to exit", { topic: "exit", tone: "warning" })
          requestRender()
        }
      }
      onTerminate = finish
      onSigbreak = finish

      listeners.on(process.stdout, "resize", onResize)
      attachTuiInputListeners()
      listeners.on(process, "SIGINT", onSigint)
      listeners.on(process, "SIGTERM", onTerminate)
      listeners.on(process, "SIGHUP", onTerminate)
      if (process.platform === "win32") {
        listeners.on(process, "SIGBREAK", onSigbreak)
      }
    })
  } finally {
    disposed = true
    abortTurnAndPromptsForExit()
    // 排队的帧与 spinner 一起停 —— 这两个都是「进程不退出」的经典来源
    renderScheduler.dispose()
    // 选区高亮定时器与边缘自动滚动一起停 —— 后者是「进程不退出」的经典来源
    mouse.dispose()
    textStreamBatcher.dispose()
    ghostPredictor.dispose()
    activityRenderer.stop()
    uiEventUnsub()
    transcriptUnsub()
    toastUnsub()
    toastStore.dispose()
    setPermissionPromptHandler(null)
    setQuestionPromptHandler(null)
    // 一次性进程级监听器：登记本倒着走一遍，不再是手写清单
    listeners.disposeAll()
    // keypress / data 是反复装卸的那一类，随终端一起停
    detachTuiInputListeners()
    deactivateTerminal({ pauseInput: true })
    onProcessExit = null
    await saveHistoryLines(HIST_FILE, HIST_SIZE, ui.history)
  }
}

export async function startRepl({ trust = false } = {}) {
  // First-run onboarding — must run before splash/readline to own the terminal
  const existingProfile = await loadProfile()
  if (!existingProfile || process.env.KKCODE_ONBOARDING === "1") {
    await runOnboarding()
  }

  // Trust check BEFORE splash — readline prompt must not compete with splash screen clearing
  const { checkWorkspaceTrust } = await import("./permission/workspace-trust.mjs")
  const trustState = await checkWorkspaceTrust({ cwd: process.cwd(), cliTrust: trust, isTTY: process.stdin.isTTY })

  const splash = startSplash({ version: `v${PACKAGE_VERSION}` })

  const ctx = await buildContext({ trust, trustState })
  printContextWarnings(ctx)
  // 不阻塞启动：命中本地缓存时会很快回填，preflight 读到什么就报什么
  let startupUpdateResult = null
  // TUI 路径下 stderr 提示改由 toast 承担：检查最晚 2.5s 才返回，那时 TUI 已
  // 接管屏幕，直接 console.error 会把帧写花。判据与 controller-entry 一致。
  const willUseTui = Boolean(process.stdout.isTTY && process.stdin.isTTY)
  const startupUpdatePromise = maybeNotifyUpdateOnStartup(ctx.configState.config, {
    currentVersion: PACKAGE_VERSION,
    ...(willUseTui ? { print: () => {} } : {})
  })
    .then((result) => { startupUpdateResult = result; return result })
    .catch(() => null)
  // 启动即异步刷新默认 provider 的模型目录（0.6.0）：让 /model 秒开、并把
  // API 自报的上下文长度合并进内存的 model_context。此前没有任何启动路径
  // 触发发现，列表与上限全靠上次手动 /model refresh 或人肉配置。
  // 绝不阻塞启动：失败静默，缓存 TTL 15 分钟由 catalog 层负责。
  {
    // 主题的 markdown 分组注入渲染器：换主题时对话里的 markdown 跟着变
  setMarkdownColors(ctx.themeState.theme?.markdown)
  const startupProvider = ctx.configState.config?.provider?.default
    if (startupProvider) {
      void loadProviderModelItems(ctx.configState, startupProvider).catch(() => {})
    }
  }
  const extensionPolicy = resolveExtensionPolicy(ctx.configState)

  splash.update("loading tools & MCP servers...")
  await ToolRegistry.initialize({
    config: extensionPolicy.config,
    cwd: process.cwd(),
    allowProjectSources: extensionPolicy.allowProjectSources
  })

  // Collect MCP status for later display
  const mcpHealth = McpRegistry.healthSnapshot()
  const mcpStatusLines = collectMcpStatusLines(ctx.themeState.theme, mcpHealth, McpRegistry.listTools())

  splash.update("loading skills & agents...")
  await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
  await CustomAgentRegistry.initialize(process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })

  splash.update("loading hooks & history...")
  await initHookBus(process.cwd(), extensionPolicy.config, {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  const historyLines = await loadHistoryLines(HIST_FILE, HIST_SIZE)

  splash.update("preparing workspace...")
  const state = createInitialReplState(ctx.configState.config, { newSessionIdFn: newSessionId })

  // Check if auto memory file exists
  try {
    await readFile(memoryFilePath(process.cwd()), "utf8")
    state.memoryLoaded = true
  } catch {
    state.memoryLoaded = false
  }

  const customCommands = await loadCustomCommands(process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  const providersConfigured = configuredProviders(ctx.configState.config, listProviders)
  const recentSessions = await listSessions({ cwd: process.cwd(), limit: 6, includeChildren: false }).catch(() => [])

  // 启动自检：只看「现在能不能干活」的几项，重活留给 kkcode doctor
  const preflight = buildPreflightReport({
    configState: ctx.configState,
    mcp: McpRegistry.healthSnapshot?.() || mcpHealth,
    skills: { total: SkillRegistry.list?.().length || 0 },
    update: startupUpdateResult
  })

  splash.stop()

  PermissionEngine.setTrusted(ctx.trustState?.trusted !== false)
  if (!ctx.trustState?.trusted) {
    console.log(paint("  ⚠ workspace not trusted — tools are blocked. Run /trust to enable.", ctx.themeState.theme.semantic.warning))
  }
  // 只在有问题时打印，一切正常就不打扰。update 有自己的通知路径，不在这里重复。
  const preflightProblems = preflight.problems.filter((p) => p.name !== "update")
  if (preflightProblems.length) {
    const tone = preflightProblems.some((p) => p.status === "fail")
      ? ctx.themeState.theme.semantic.error || ctx.themeState.theme.semantic.warn
      : ctx.themeState.theme.semantic.warn
    console.log(paint("  preflight", tone, { bold: true }))
    for (const problem of preflightProblems) {
      console.log(paint(`    ${problem.status}  ${problem.name}: ${problem.detail}`, tone))
    }
  }

  try {
    await runReplController({
      ctx,
      state,
      providersConfigured,
      customCommands,
      recentSessions,
      historyLines,
      mcpStatusLines,
      startupUpdatePromise,
      startTuiRepl,
      startLineRepl,
      clearScreenFn: clearScreen
    })
  } finally {
    await McpRegistry.shutdown()
  }
}
