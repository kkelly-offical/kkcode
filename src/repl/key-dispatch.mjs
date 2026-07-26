/**
 * 按键分派：把「哪个按键归谁管」从 685 行的 if 链变成有序数据。
 *
 * ## 为什么这件事值得单独建模
 *
 * 拆分前，按键优先级的唯一载体是**哪个 `if` 写在前面**。比如这条规则：
 *
 *   「信息浮层打开时必须先吃掉 ↑↓，否则会同时滚浮层和翻输入历史」
 *
 * 它成立仅仅因为 `if (ui.infoPanel)` 在 685 行里排在 `if (key.name === "up")`
 * 之前。没有任何东西能表达、检查或测试这条规则 —— 有人为了别的原因挪一下代码块，
 * 规则就悄悄破了。同类的还有「有可见选区时 Ctrl+C 归选区，而不是中断回合」。
 *
 * 变成有序表之后，优先级是可以断言的数据。
 *
 * ## 两个概念，对应原来两种 `if` 写法
 *
 * **有序处理器** —— 首个 `when` 命中的跑，然后停。对应 `if (...) { ...; return }`。
 *
 * **模态作用域** —— 激活时只有它自己的处理器生效，**其余按键一律被吞掉**。对应
 * 那种整块包起来、末尾有个裸 `return` 的写法：
 *
 *     if (ui.infoPanel) {
 *       if (key.name === "up") { ... return }
 *       …
 *       return          // ← 这个裸 return 就是「吞掉」
 *     }
 *
 * 吞掉是刻意的：浮层开着时按 `a` 不该悄悄改输入框内容。
 */

/**
 * @param {object} p
 * @param {Array<{id: string, active?: Function, modal?: boolean, handlers: Array}>} p.scopes
 *   按优先级从高到低排列。每个 handler 是 `{ id, when(ctx), run(ctx) }`。
 */
export function createKeyDispatcher({ scopes }) {
  for (const scope of scopes) {
    if (!scope.id) throw new Error("每个作用域都要有 id —— 测试靠它断言优先级")
    for (const handler of scope.handlers) {
      if (!handler.id) throw new Error(`作用域 ${scope.id} 里有处理器缺 id`)
      if (typeof handler.run !== "function") throw new Error(`${scope.id}.${handler.id} 缺 run`)
    }
  }

  /**
   * 分派一次按键。
   * @returns {Promise<{handled: boolean, scope: string|null, handler: string|null, swallowed: boolean}>}
   *   `handler` 是实际执行的那个处理器 id —— 测试用它断言「谁接了这个键」。
   */
  async function dispatchKey(ctx) {
    for (const scope of scopes) {
      if (scope.active && !scope.active(ctx)) continue
      for (const handler of scope.handlers) {
        if (!handler.when(ctx)) continue
        await handler.run(ctx)
        return { handled: true, scope: scope.id, handler: handler.id, swallowed: false }
      }
      if (scope.modal) {
        // 模态作用域吞掉未命中的按键：浮层开着时按 `a` 不该改到输入框
        return { handled: true, scope: scope.id, handler: null, swallowed: true }
      }
    }
    return { handled: false, scope: null, handler: null, swallowed: false }
  }

  /** 展平成 `作用域.处理器` 的有序清单。优先级断言与文档都用它。 */
  function describeOrder() {
    return scopes.flatMap((scope) =>
      scope.handlers.map((handler) => `${scope.id}.${handler.id}`)
    )
  }

  return { dispatchKey, describeOrder, scopes }
}

/** 常用谓词：省掉几十处 `key.ctrl && key.name === "x"`。 */
export const on = {
  key: (name) => (ctx) => ctx.key.name === name,
  ctrl: (name) => (ctx) => Boolean(ctx.key.ctrl) && ctx.key.name === name,
  /**
   * Alt 组合。node 的 keypress 把 `ESC` + 某键解析成 `{ name, meta: true }`，
   * 所以 Alt+B 在这里是 `on.meta("b")` 而不是某个独立的键名。
   *
   * 排除 ctrl 是为了与 `on.ctrl` **不重叠**：后者不看 meta，若这里也不看 ctrl，
   * Ctrl+Alt+B 会同时满足两条谓词，谁接到就只取决于谁写在前面 —— 那正是这张表
   * 想消灭的那种隐式规则。
   */
  meta: (name) => (ctx) => Boolean(ctx.key.meta) && !ctx.key.ctrl && ctx.key.name === name,
  anyKey: (...names) => (ctx) => names.includes(ctx.key.name),
  /** 可打印字符：不带 ctrl/meta 的非空 str。 */
  printable: (ctx) =>
    typeof ctx.str === "string" && ctx.str.length > 0 && !ctx.key.ctrl && !ctx.key.meta,
  always: () => true
}
