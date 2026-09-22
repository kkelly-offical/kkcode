import { runtimeCwd } from "../../kernel/index.mjs"
/**
 * 会话与工作区状态类命令：开新会话、续跑、历史、压缩、回滚、清屏、看板。
 *
 * 这些命令的共同点是**只动会话状态或只查询状态**，不碰 provider/权限配置。
 * 输出通道按性质分：查询走 `showInfo`（浮层，不进对话记录），报告刚发生了什么
 * 走 `notice`（瞬时提示），需要回看的内容才留在对话记录里。
 */

import { LongAgentManager, loadLedger, rewindLastTurn } from "../../kernel/index.mjs"
import { buildBoardModel, renderUltraBoard } from "../../ui/ultra-board.mjs"
import { renderRuntimeDashboardView } from "../../ui/repl-status-view.mjs"
import { runBtwQuery } from "../btw-query.mjs"
import { paint } from "../../theme/color.mjs"
import { ageLabel, padRight } from "../../util/frame-primitives.mjs"
import { buildReplRuntimeSnapshot } from "../runtime-facade.mjs"
import { buildOperatorSnapshot } from "../operator-surface.mjs"

export const sessionCommands = [
  {
    names: ["exit", "quit", "q"],
    desc: "quit",
    argMode: "none",
    run: () => ({ exit: true })
  },

  {
    names: ["session", "s"],
    desc: "show session id",
    argMode: "none",
    run: ({ print, state }) => {
      // 单行事实，不值得占一条对话记录
      print(`session=${state.sessionId}`, { channel: "notice", topic: "session" })
      return { exit: false }
    }
  },

  {
    names: ["btw"],
    desc: "ask a side question — sees the conversation, never changes it",
    argMode: "required",
    accepts: "<question>",
    run: async ({ args, showInfo, print, state, ctx }) => {
      // 旁路问答（0.7.5）：带着当前对话的上下文问一个「顺便问一下」，
      // 不写入会话、不触发工具。答案走只读浮层 —— 它和 /status 一样是
      // 查询，进对话记录就会被发给模型、被 /clear 清掉。
      print("(btw) 正在思考…", { channel: "notice", topic: "btw" })
      const result = await runBtwQuery({
        question: args,
        sessionId: state.sessionId,
        state,
        configState: ctx.configState
      })
      if (!result.ok) {
        print(`btw 失败：${result.error}`, { channel: "notice", topic: "btw", tone: "error" })
        return { exit: false }
      }
      showInfo(`btw · ${args.slice(0, 40)}${args.length > 40 ? "…" : ""}`, result.answer, { maxRows: 16 })
      return { exit: false }
    }
  },

  {
    names: ["status"],
    desc: "runtime state",
    argMode: "none",
    run: async ({ showInfo, state, ctx, customCommands, providersConfigured }) => {
      // 注册表走 kernel 句柄（1.0.0 阶段 2c）：进程级默认注册表在首个回合前
      // 不初始化，直接读会拿到空清单
      const runtimeView = await buildReplRuntimeSnapshot({
        cwd: runtimeCwd(),
        state,
        customCommands,
        providers: providersConfigured,
        mcpRegistry: ctx.kernel.extensions.mcp,
        skillRegistry: ctx.kernel.extensions.skills,
        recoveryEnabled: ctx.configState.config.session?.recovery !== false,
        config: ctx.configState.config
      })
      runtimeView.operatorSnapshot = buildOperatorSnapshot({
        runtimeSummary: runtimeView.runtimeSummary,
        backgroundSummary: runtimeView.backgroundSummary
      })
      // 内容按浮层内宽排版：runtime 视图自己也画框，宽度不匹配时它的边框会被
      // 折成两段（实测截图里就是 `+-----` 换行成 `---+`）。
      //
      // 钳到 60 是因为这个视图有 60 列的最小宽度 —— 请求更窄它照样输出 60 格宽的
      // 行。与其让它在窄终端里悄悄溢出，不如按最小宽度排版然后由浮层裁掉右边
      // （浮层对自带边框的内容裁而不折）。`/board` 一直是这么做的，这里对齐。
      const remote = ctx.remoteService
      const remoteSummary = remote ? `Remote: ${remote.metadata.profile?.name || '未登录'} · ${remote.metadata.profile?.organization || '未绑定组织'} · ${remote.remoteStatus || 'offline'}\n` : ''
      showInfo("runtime status", (innerWidth) => remoteSummary + renderRuntimeDashboardView({
        theme: ctx.themeState.theme,
        columns: Math.max(60, innerWidth),
        ...runtimeView
      }), { maxRows: 18 })
      return { exit: false }
    }
  },

  {
    names: ["clear", "cls"],
    desc: "clear terminal",
    catalog: [
      { name: "clear", desc: "clear terminal" },
      { name: "cls", desc: "clear terminal (alias of /clear)" }
    ],
    argMode: "none",
    run: () => ({ exit: false, cleared: true })
  },

  {
    names: ["dash", "dashboard", "home"],
    desc: "redraw dashboard",
    catalog: [
      { name: "dash", desc: "redraw dashboard" },
      { name: "dashboard", desc: "redraw dashboard (alias of /dash)" },
      { name: "home", desc: "back to the dashboard view" }
    ],
    argMode: "none",
    run: async ({ ctx }) => {
      const recent = await ctx.kernel.sessions.listSessions({ cwd: runtimeCwd(), limit: 6, includeChildren: false }).catch(() => [])
      return { exit: false, dashboardRefresh: true, recentSessions: recent }
    }
  },

  {
    names: ["compact"],
    desc: "summarize conversation to free context",
    argMode: "none",
    run: async ({ print, state, ctx }) => {
      try {
        // 进度是瞬时提示：压缩完成后这条就该消失，不该留在对话记录里
        print("compacting conversation...", { channel: "notice", topic: "compact" })
        const result = await ctx.kernel.sessions.compactSession({
          sessionId: state.sessionId,
          model: state.model,
          providerType: state.providerType,
          configState: ctx.configState
        })
        if (result.compacted) {
          print(`compacted: ${result.summarizedCount} messages summarized, ${result.keptCount} kept`, { channel: "notice", topic: "command" })
        } else {
          print(`skipped: ${result.reason}`, { channel: "notice", topic: "command" })
        }
      } catch (err) {
        print(`compact failed: ${err.message}`, { channel: "notice", topic: "command", tone: "error" })
      }
      return { exit: false }
    }
  },

  {
    names: ["new", "n"],
    desc: "new session",
    argMode: "none",
    run: ({ print, state, ctx }) => {
      state.sessionId = ctx.kernel.turns.newSessionId()
      print(`new session: ${state.sessionId}`, { channel: "notice", topic: "command" })
      return { exit: false }
    }
  },

  {
    names: ["history"],
    desc: "list sessions",
    argMode: "none",
    run: async ({ print, showInfo, ctx }) => {
      const sessions = await ctx.kernel.sessions.listSessions({ cwd: runtimeCwd(), limit: 20, includeChildren: false })
      if (!sessions.length) {
        print("no sessions found", { channel: "notice", topic: "session" })
        return { exit: false }
      }
      const rows = sessions.map((s) => {
        const age = ageLabel(Date.now() - s.updatedAt)
        const title = s.title || `${s.mode}:${s.model || "?"}`
        const titleClipped = title.length > 35 ? title.slice(0, 32) + "..." : title
        return `  ${s.id.slice(0, 12)}  ${padRight(titleClipped, 36)} ${padRight(s.mode, 9)} ${padRight(s.status || "-", 10)} ${age}`
      })
      // 浮层能滚，所以取 20 条而不是 8 条 —— 此前的条数上限是为了不刷屏
      showInfo(`sessions (${sessions.length})`, [
        `  ${padRight("id", 12)}  ${padRight("title", 36)} ${padRight("mode", 9)} ${padRight("status", 10)} age`,
        ...rows,
        "",
        "  /resume <id> 续跑其中一个"
      ].join("\n"))
      return { exit: false }
    }
  },

  {
    names: ["resume", "r"],
    desc: "resume session",
    argMode: "optional",
    run: async ({ args, print, state, openPanel, ctx }) => {
      const sessions = await ctx.kernel.sessions.listSessions({ cwd: runtimeCwd(), limit: 20, includeChildren: false })

      if (!sessions.length) {
        print("no sessions found in current directory", { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }

      let target = null

      if (!args) {
        // 裸 /resume 是「列出并选一个」，和 /provider 同构 —— 走选择器，
        // Enter 直接续跑，不必让用户在滚动的对话记录里数编号再手敲。
        const items = sessions.map((session) => {
          const title = session.title || `${session.mode}:${session.model || "?"}`
          const age = ageLabel(Date.now() - session.updatedAt)
          return {
            id: session.id,
            label: title.length > 45 ? `${title.slice(0, 42)}...` : title,
            desc: `${session.mode} · ${session.status || "-"} · ${age}`
          }
        })
        if (openPanel) {
          return { exit: false, openSessionPicker: true, sessionPickerItems: items }
        }
        // 行模式：没有帧可浮，回落到编号列表
        print(`\n  Sessions in ${paint(runtimeCwd(), "cyan")}:\n`)
        items.forEach((item, i) => {
          const num = paint(`  ${String(i + 1).padStart(2)}.`, "yellow")
          print(`${num} ${padRight(item.label, 46)} ${paint(item.desc, null, { dim: true })}`)
        })
        print(`\n  usage: ${paint("/resume <number>", "yellow")} or ${paint("/resume <session-id>", "yellow")}`)
        return { exit: false }
      }

      // Try numeric index first (1-based)
      const idx = parseInt(args, 10)
      if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
        target = sessions[idx - 1]
      } else {
        // Fallback to ID prefix match
        target = sessions.find((s) => s.id === args || s.id.startsWith(args)) || null
      }

      if (!target) {
        print(`no session matching "${args}"`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }

      state.sessionId = target.id
      state.mode = target.mode || state.mode
      state.providerType = target.providerType || state.providerType
      state.model = target.model || state.model
      const title = target.title || `${target.mode}:${target.model || "?"}`
      print(`resumed: ${paint(title, "cyan")} (${target.mode}, ${target.model || "?"})`, { channel: "notice", topic: "command" })
      const msgs = await ctx.kernel.sessions.getConversationHistory(target.id, 3)
      for (const m of msgs) {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        const preview = text.length > 84 ? `${text.slice(0, 84)}...` : text
        // 续跑会话的尾部预览：是「那份会话里有什么」的上下文，留在滚动区，
        // 但以弱化的 system 样式呈现 —— 它不是本次会话的对话内容
        print(`  [${m.role}] ${preview}`, { kind: "system", tone: "muted" })
      }
      return { exit: false }
    }
  },

  {
    names: ["undo"],
    desc: "undo last code changes",
    argMode: "none",
    run: async ({ print, state, ctx }) => {
      const language = ctx.configState.config.language || "en"
      const cwd = runtimeCwd()
      const confirmation = await ctx.kernel.sessions.confirmRollback({ cwd, sessionId: state.sessionId, language })
      // /undo 的回执折成一条可展开的记录：内容可回看，但不以多行提示刷屏
      print(confirmation.message, { channel: "panel", title: "undo" })
      if (!confirmation.confirmed) return { exit: false }
      const result = await ctx.kernel.sessions.executeRollback({
        cwd,
        commitHash: confirmation.commitHash,
        sessionId: state.sessionId,
        language
      })
      print(result.message, { channel: "panel", title: "undo" })
      return { exit: false }
    }
  },

  {
    names: ["rewind"],
    desc: "remove the last conversation turn (does not undo files)",
    argMode: "none",
    run: async ({ print, state }) => {
      const result = await rewindLastTurn(state.sessionId)
      print(result.ok ? `rewound ${result.removed} messages; files were not changed` : `rewind skipped: ${result.reason}`, { channel: "notice", topic: "session" })
      return { exit: false, rewound: result }
    }
  },

  {
    names: ["board"],
    desc: "ultra goal board",
    argMode: "none",
    run: async ({ print, showInfo, state }) => {
      // 目标看板：判据 + stage/task 投影成五列（待办/进行中/受阻/待验收/已达成）。
      // 数据来自会话状态与台账 —— 与 `kkcode ultra board` 是同一条码。
      const record = await LongAgentManager.get(state.sessionId)
      if (!record?.goal && !record?.stagePlan) {
        print("当前会话还没有 Ultra 目标。用 /ultra 模式跑一个目标后再看。", { channel: "notice", topic: "board", tone: "warn" })
        return { exit: false }
      }
      const ledger = await loadLedger(state.sessionId)
      const lastRound = ledger?.data.rounds[ledger.data.rounds.length - 1]
      const verification = lastRound?.criteria?.length
        ? { results: lastRound.criteria, subGoals: [] }
        : null
      const board = buildBoardModel({
        goal: record.goal, stagePlan: record.stagePlan,
        taskProgress: record.taskProgress || {}, verification
      })
      showInfo("ultra board",
        (innerWidth) => renderUltraBoard(board, { width: Math.max(60, innerWidth), paint }).join("\n"),
        { maxRows: 20 })
      return { exit: false }
    }
  }
]
