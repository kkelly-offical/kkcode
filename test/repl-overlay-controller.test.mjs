import test from "node:test"
import assert from "node:assert/strict"
import { createOverlayController } from "../src/repl/overlay-controller.mjs"
import { createReplUiState, activeUserOverlay } from "../src/repl/ui-state.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"

/**
 * 六个用户浮层的开/关/确认。
 *
 * 此前这块只能用正则断言源码（找 `ui.input = \`/provider \`` 这样的字面量）——
 * 那种断言一移动代码就失效，而且验不了行为。控制器现在可导入，可以真的开、
 * 真的确认，看它做了什么。
 */

function harness({ providerType = "kimi", model = "k3" } = {}) {
  const calls = []
  const ui = createReplUiState()
  const state = { providerType, model, modeId: "agent", mode: "agent", sessionId: "ses_1" }
  const ctx = { configState: { config: structuredClone(DEFAULT_CONFIG) } }
  const controller = createOverlayController({
    ui,
    state,
    ctx,
    requestRender: () => {},
    showToast: (message, options) => calls.push(`toast[${options?.topic}](${message})`),
    submitCurrentInput: async () => calls.push(`submit(${ui.input})`),
    selectModeAndNotify: (modeId) => calls.push(`mode(${modeId})`),
    clearPermissionSession: (id) => calls.push(`clearSession(${id})`),
    terminalColumns: () => 100
  })
  return { controller, ui, state, ctx, calls }
}

const PROVIDERS = [{ name: "kimi", label: "kimi" }, { name: "openai", label: "openai" }]
const MODELS = [
  { provider: "kimi", model: "k3", label: "kimi/k3" },
  { provider: "openai", model: "gpt", label: "openai/gpt" }
]
const SESSIONS = [{ id: "ses_a", label: "甲" }, { id: "ses_b", label: "乙" }]

// --- 开：空列表要说话，不要开一个空框 ---

test("opening a picker with nothing to pick says so instead of showing an empty box", () => {
  const cases = [
    ["openProviderPicker", "provider"],
    ["openSessionPicker", "session"],
    ["openModelPicker", "model"]
  ]
  for (const [method, topic] of cases) {
    const { controller, ui, calls } = harness()
    const opened = controller[method]([])
    assert.equal(opened, false, `${method} 空列表不该打开`)
    assert.equal(activeUserOverlay(ui), null)
    assert.ok(calls.some((c) => c.startsWith(`toast[${topic}]`)), `${method} 应给出提示`)
  }
})

test("a picker preselects what is currently in effect", () => {
  const provider = harness({ providerType: "openai" })
  provider.controller.openProviderPicker(PROVIDERS)
  assert.equal(provider.ui.providerPicker.selected, 1, "当前渠道要被预选中")

  const model = harness({ providerType: "openai", model: "gpt" })
  model.controller.openModelPicker(MODELS)
  assert.equal(model.ui.modelPicker.selected, 1, "当前模型要被预选中")
})

test("an unknown current value falls back to the first row rather than a negative index", () => {
  const { controller, ui } = harness({ providerType: "根本没有这个渠道" })
  controller.openProviderPicker(PROVIDERS)
  assert.equal(ui.providerPicker.selected, 0)
})

test("opening one picker closes another", () => {
  // 互斥由 ui-state 保证，这里确认控制器确实走了那条路
  const { controller, ui } = harness()
  controller.openModelPicker(MODELS)
  controller.openProviderPicker(PROVIDERS)
  assert.equal(activeUserOverlay(ui), "providerPicker")
  assert.equal(ui.modelPicker, null)
})

// --- 确认：有既有命令路径的，必须走那条路 ---

test("confirming a provider goes through the normal submit path", async () => {
  // 切渠道要重取模型目录、校验凭据、回写状态。那些逻辑只应存在一处 ——
  // 在选择器里再实现一遍，两份迟早分叉，而分叉的那半没有测试覆盖。
  const { controller, ui, calls } = harness({ providerType: "kimi" })
  controller.openProviderPicker(PROVIDERS)
  ui.providerPicker.selected = 1
  await controller.confirmProviderPicker()
  assert.deepEqual(calls, ["submit(/provider openai)"], "必须复用 /provider 命令，而不是自己切")
  assert.equal(activeUserOverlay(ui), null, "确认后浮层要关掉")
})

test("confirming a session goes through the normal submit path", async () => {
  const { controller, ui, calls } = harness()
  controller.openSessionPicker(SESSIONS)
  ui.sessionPicker.selected = 1
  await controller.confirmSessionPicker()
  assert.deepEqual(calls, ["submit(/resume ses_b)"], "续跑要恢复渠道/模型/历史，只应有一处实现")
})

test("picking the provider already in effect says so and does not re-submit", async () => {
  const { controller, ui, calls } = harness({ providerType: "kimi" })
  controller.openProviderPicker(PROVIDERS)
  ui.providerPicker.selected = 0
  await controller.confirmProviderPicker()
  assert.ok(!calls.some((c) => c.startsWith("submit(")), "已经是当前渠道就不该再跑一遍切换")
  assert.ok(calls.some((c) => c.includes("已是当前渠道")))
})

test("confirming a model just sets the two fields — there is no command to reuse", async () => {
  const { controller, ui, state, calls } = harness({ providerType: "kimi", model: "k3" })
  controller.openModelPicker(MODELS)
  ui.modelPicker.selected = 1
  controller.confirmModelPicker()
  assert.equal(state.providerType, "openai")
  assert.equal(state.model, "gpt")
  assert.ok(!calls.some((c) => c.startsWith("submit(")), "没有既有命令路径可复用时就直接改")
  assert.equal(activeUserOverlay(ui), null)
})

test("confirming with nothing open is a no-op", async () => {
  const { controller, calls } = harness()
  await controller.confirmProviderPicker()
  await controller.confirmSessionPicker()
  controller.confirmModelPicker()
  controller.confirmModePicker()
  controller.confirmPolicyPicker()
  assert.deepEqual(calls, [])
})

test("cancelling closes without doing anything", async () => {
  const { controller, ui, state, calls } = harness()
  controller.openModelPicker(MODELS)
  controller.closeModelPicker()
  assert.equal(activeUserOverlay(ui), null)
  assert.equal(state.model, "k3", "取消不该改动任何东西")
  assert.deepEqual(calls, [])
})

// --- 模式与策略 ---

test("confirming a mode delegates to the shared mode switch", () => {
  const { controller, ui, calls } = harness()
  controller.openModePicker()
  ui.modePicker.selected = 0
  controller.confirmModePicker()
  assert.ok(calls.some((c) => c.startsWith("mode(")), "切模式要走共用的那一处，不是自己写一遍")
  assert.equal(activeUserOverlay(ui), null)
})

test("confirming a policy writes it back and reports the change", () => {
  const { controller, ui, ctx, calls } = harness()
  controller.openPolicyPicker()
  ui.policyPicker.selected = 0
  controller.confirmPolicyPicker()
  assert.ok(ctx.configState.config.permission, "档位要落回运行期配置")
  assert.equal(activeUserOverlay(ui), null)
})

// --- 信息浮层 ---

test("an info panel from a string wraps; one from a function does not", () => {
  // 传函数意味着「我会按给定宽度自己排版」= 自带边框。折行会把它画的框折成两段。
  const { controller, ui } = harness()
  controller.openInfoPanel("散文", "第一行\n第二行")
  assert.equal(ui.infoPanel.wrap, true)
  assert.deepEqual(ui.infoPanel.lines, ["第一行", "第二行"])

  controller.openInfoPanel("自带边框", (width) => `+${"-".repeat(width - 2)}+`)
  assert.equal(ui.infoPanel.wrap, false, "自带边框的内容必须裁剪而不是折行")
  assert.equal(ui.infoPanel.renderedAt, 96, "内宽 = 终端宽 − 4")
})

test("scrolling is clamped to what the renderer measured", () => {
  const { controller, ui } = harness()
  controller.openInfoPanel("t", "a\nb\nc")
  ui.infoPanel.maxOffset = 2   // 渲染层回写：内容有多长要排完版才知道
  controller.scrollInfoPanel(10)
  assert.equal(ui.infoPanel.offset, 2, "不该滚过内容末尾")
  controller.scrollInfoPanel(-10)
  assert.equal(ui.infoPanel.offset, 0, "也不该滚过开头")
})

test("closing reports whether there was anything to close", () => {
  const { controller } = harness()
  assert.equal(controller.closeInfoPanel(), false, "没开就返回 false —— Esc 要据此决定是否继续传递")
  controller.openInfoPanel("t", "x")
  assert.equal(controller.closeInfoPanel(), true)
})

test("self-framed content is re-laid-out on resize, plain text is not", () => {
  let columns = 100
  const calls = []
  const ui = createReplUiState()
  const controller = createOverlayController({
    ui,
    state: { providerType: "p", model: "m", sessionId: "s", mode: "agent", modeId: "agent" },
    ctx: { configState: { config: structuredClone(DEFAULT_CONFIG) } },
    requestRender: () => {},
    showToast: () => {},
    submitCurrentInput: async () => {},
    selectModeAndNotify: () => {},
    clearPermissionSession: () => {},
    terminalColumns: () => columns
  })

  controller.openInfoPanel("框", (width) => { calls.push(width); return "+".repeat(width) })
  assert.deepEqual(calls, [96])
  assert.equal(controller.relayoutInfoPanel(), false, "宽度没变就不该重排")
  columns = 60
  assert.equal(controller.relayoutInfoPanel(), true)
  assert.deepEqual(calls, [96, 56], "新宽度要重新排一遍，否则边框会被折断")
  assert.equal(ui.infoPanel.offset, 0, "重排后滚动位置要归零，否则会指向不存在的行")

  controller.openInfoPanel("散文", "就是一段文字")
  columns = 40
  assert.equal(controller.relayoutInfoPanel(), false, "没有排版函数的内容不需要重排")
})
