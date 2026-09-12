import { noteDeprecation } from "../kernel/core/deprecations.mjs"

/**
 * 计划做完之后的去向。**顺序即编号** —— 下面解析答案时的数字回落由这个数组
 * 派生，不再手写一条 `answer === "5"` 的阶梯。手写的那份在插入一个选项时会
 * 静默错位：数字还在，指向的却是隔壁那一项。
 *
 * Yolo Build 与其余几项的区别不在执行方式，而在**审批边界**：它把审批档降到
 * yolo，工具调用不再逐个确认。因此它的描述必须把代价写在脸上。
 */
const PLAN_ACTIONS = Object.freeze([
  { label: "Build", value: "assistant", description: "Switch to Agent and implement this plan" },
  { label: "Ultra Build", value: "longagent", description: "Switch to Ultra for staged multi-file delivery" },
  { label: "Compact + Build", value: "compact_assistant", description: "Compact context first, then build in Agent" },
  { label: "Compact + Ultra Build", value: "compact_longagent", description: "Compact context first, then build in Ultra" },
  { label: "Yolo Build", value: "yolo", description: "Switch to YOLO and build unattended — approvals off, no per-tool confirmation" },
  { label: "Revise Plan", value: "revise", description: "Continue editing the plan with your feedback" }
])

/**
 * 提问通道工厂（1.0.0 阶段 2a）：customPromptHandler 槽位收编为实例字段
 * （M3 §四.2）。每个 kernel 实例一个通道，由 createKernel 的
 * handlers.onQuestionPrompt 注入。
 *
 * 阶段 3b（M3 耦合点 15）：内核不再自开终端行读取。没有宿主 handler 的
 * 宿主（headless/CI/管道）得到确定性收口 —— 空答案或显式安全默认值，
 * 绝不阻塞在 stdin 上。要提问就必须经 createKernel 注入 handler。
 */
export function createQuestionPromptChannel() {
  let customPromptHandler = null

  function setQuestionPromptHandler(handler) {
    customPromptHandler = typeof handler === "function" ? handler : null
  }

  /** 当前注册的自定义处理器（没有则为 null）。kernel 组合根做保存/恢复用。 */
  function getQuestionPromptHandler() {
    return customPromptHandler
  }

  /**
   * 当前是否有 TUI 注册的提问处理器。
   *
   * 必须在**要提问的那一刻**调用，不能在启动时缓存结果 —— REPL 在退出流程里
   * 会 setQuestionPromptHandler(null)，缓存下来的判断会恰好在最需要它的时候
   * 是错的。调用方据此判断「现在问得出结果吗」，问不出就必须显式收口，
   * 不能把空答案当成用户的选择。
   */
  function hasPromptHandler() {
    return customPromptHandler !== null
  }

  async function askQuestionInteractive({ questions }) {
    if (!Array.isArray(questions) || questions.length === 0) {
      return {}
    }

    // 唯一的提问途径：宿主注册的 handler（TUI 浮层等）。
    if (customPromptHandler) {
      const answers = await customPromptHandler({ questions })
      if (answers && typeof answers === "object") return answers
    }

    // 没有 handler = 问不到人：确定性返回空答案。空答案绝不能被解读成
    // 用户的某个具体选择（见 askPlanApproval / ultra-interaction 的收口）。
    return Object.fromEntries(questions.map((q) => [q.id, ""]))
  }

  async function askPlanApproval({ plan, files = [], planPath = "" }) {
    // 没有人能回答这个问题。0.3.x 会拿到空答案，把它当成「要求修改但没给
    // 理由」，模型于是反复重写计划，直到步数耗尽——一次 `kkcode chat
    // --mode plan` 能落下五六个计划文件。这里直接收口。
    if (!customPromptHandler) {
      return {
        approved: true,
        requestChanges: false,
        action: "plan_saved",
        feedback: "",
        planPath
      }
    }

    const fileList = files.length ? `\nFiles to modify:\n${files.map(f => `  - ${f}`).join("\n")}` : ""
    const pathText = planPath ? `Plan file: ${planPath}\n\n` : ""
    const questions = [
      {
        id: "plan_approval",
        text: `Plan Next Step`,
        description: `${pathText}${plan}${fileList}`,
        options: PLAN_ACTIONS.map((action) => ({ ...action })),
        multi: false,
        allowCustom: true
      }
    ]
    const answers = await askQuestionInteractive({ questions })
    const answer = String(answers.plan_approval || "").trim().toLowerCase()
    // 纯数字才当编号。`parseInt` 会把「3 个阶段都要」读成 3，而那是一句自由文本，
    // 应当落到下面的「按修改意见处理」。
    const index = /^\d+$/.test(answer) ? Number.parseInt(answer, 10) : 0
    const chosen = PLAN_ACTIONS.find((action) => action.value === answer)
      || (index >= 1 && index <= PLAN_ACTIONS.length ? PLAN_ACTIONS[index - 1] : null)
    if (chosen && chosen.value !== "revise") {
      return { approved: true, requestChanges: false, action: chosen.value, feedback: "", planPath }
    }
    if (chosen?.value === "revise") {
      // 选了「继续改」但没给文字：自由文本修改意见走下面的自定义分支（前端
      // 浮层的 Custom 输入会带着文字回来），这里只拿到选项本身就按空反馈收口。
      return { approved: false, requestChanges: true, action: "revise", feedback: "", planPath }
    }
    // Custom text input: treat as "request changes" with the text as feedback
    return { approved: false, requestChanges: true, action: "revise", feedback: answer, planPath }
  }

  return {
    setQuestionPromptHandler,
    getQuestionPromptHandler,
    hasPromptHandler,
    askQuestionInteractive,
    askPlanApproval
  }
}

// 进程级默认通道。阶段 2b 期间内核执行路径仍经它回答提问；createKernel 会把
// 宿主 handler 同步安装到这里（带保存/恢复），直到 2c/阶段 3 改为实例注入。
export const defaultQuestionPromptChannel = createQuestionPromptChannel()

const ALIAS_KEY = "kernel.singleton.question-prompt"
const ALIAS_MESSAGE = "模块级提问提示槽位已收编为 kernel 实例字段：新代码改用 createKernel() 的 handlers.onQuestionPrompt 注入"
const noteAlias = () => noteDeprecation(ALIAS_KEY, ALIAS_MESSAGE, { removal: "1.x" })

/** 兼容别名（deprecated）：旧 import 路径继续工作，调用经 deprecations.mjs 记录。 */
export function setQuestionPromptHandler(handler) {
  noteAlias()
  return defaultQuestionPromptChannel.setQuestionPromptHandler(handler)
}

/** 兼容别名（deprecated）。 */
export function hasPromptHandler() {
  noteAlias()
  return defaultQuestionPromptChannel.hasPromptHandler()
}

/** 兼容别名（deprecated）。 */
export function askQuestionInteractive(request) {
  noteAlias()
  return defaultQuestionPromptChannel.askQuestionInteractive(request)
}

/** 兼容别名（deprecated）。 */
export function askPlanApproval(request) {
  noteAlias()
  return defaultQuestionPromptChannel.askPlanApproval(request)
}
