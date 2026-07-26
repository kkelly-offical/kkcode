/**
 * 输入框补全候选的**唯一来源**。
 *
 * ## 为什么要有这个模块
 *
 * 0.7.1 之前候选在四处各自求值：`handleUpDownSuggestions`、`applyCurrentSuggestion`、
 * `shouldApplySuggestionOnEnter` 各调一次 `slashSuggestions`，`frame-builder` 又自己调了
 * 第四次。四处独立求值时「候选有哪几种」是一份**手写清单**，而本仓库有一条明确教训：
 * 手写清单在枚举增长时会静默失效 —— 加第三种候选（`@` 文件）只要漏改其中一处，那一处
 * 就会当作「没有候选」继续走老路（比如 Enter 直接把半截 `@src/rep` 发出去）。
 *
 * 现在四处都调 `compute()`，形状统一带 `kind` 标签，写回按 `kind` 分派。
 *
 * ## 三种候选的触发语义不同，这是有意的
 *
 * - `/` 与 `$` **只认行首**：它们是「这一整行是一条命令」的声明，写回时整行替换。
 * - `@` 是**光标感知**的：它可以出现在句子中间（`看看 @src/foo.ts 为什么慢`），写回时
 *   只替换光标所在的那个 token。
 *
 * 所以判定顺序是**先看光标、再看行首**：光标停在某个 `@token` 上时出文件候选，否则回落到
 * 行首的 `/` `$`。这让 `/plan @src/a.mjs` 这种混合输入两边都能用 —— 光标在 `plan` 上给
 * 命令候选，移到 `@src/a` 上给文件候选。
 *
 * ## 文件索引是懒的
 *
 * `createFileIndex` 只在第一次真的需要文件候选时才走盘（`list()` 内部缓存）。启动时不扫，
 * 否则大仓库下 TUI 起不来。
 */

import { slashSuggestions, applySuggestionToInput, commandQuery } from "./slash-router.mjs"
import { shouldApplySuggestionOnEnter as shouldApplySlashOnEnter } from "./input-engine.mjs"
import { mentionQueryAt, applyMention } from "./file-mention.mjs"
import { createFileIndex } from "./file-index.mjs"
import { rankCandidates } from "./file-rank.mjs"

/** 一次列多少条文件候选。可见窗口只有 5 行，多出来的靠上下键滚。 */
export const MENTION_LIMIT = 30

/** 没有任何候选时的形状。**每个字段都在**，调用方不必写 `?.` 或判空。 */
export const NO_SUGGESTIONS = Object.freeze({
  kind: null,
  sigil: null,
  items: [],
  query: "",
  total: 0,
  truncated: false,
  maxFiles: 0
})

/** 选中项。索引越界一律夹紧到两端 —— 候选表会随输入变短，选中位置追不上是常态。 */
function pick(suggestions, selected) {
  const items = suggestions.items
  if (!items.length) return null
  return items[Math.max(0, Math.min(Number(selected) || 0, items.length - 1))]
}

export function createSuggestionSource({
  getSlashOptions = () => ({}),
  cwd = process.cwd(),
  createIndex = createFileIndex,
  limit = MENTION_LIMIT
} = {}) {
  let index = null
  // 一格缓存。一次按键会问四次候选（渲染、上下键、Tab、Enter），排序两万条路径四遍
  // 没必要。只缓存文件那一支：它只依赖 input/cursor 与索引内容，而索引只有 refresh()
  // 能改。斜杠那一支不缓存 —— 它读的 SkillRegistry 会在会话中途就绪，缓存会把
  // 「技能还没加载完」那一瞬间的空清单钉死。
  let cache = null

  const ensureIndex = () => (index = index || createIndex({ cwd }))

  function mentionSuggestions(hit, input, cursor) {
    if (cache && cache.input === input && cache.cursor === cursor) return cache.result
    const files = ensureIndex()
    // **先 list() 再 stats()**。索引是懒的，第一次 list() 才走盘，而 `truncated` 是走完盘
    // 才知道的。反过来写的话，第一次敲 `@` 拿到的是建库前的空统计 —— 于是封顶被静默吞掉，
    // 恰好是「封顶要说出来」这条不变量想防的那个场面。
    const list = files.list()
    const stats = files.stats()
    const result = {
      kind: "mention",
      sigil: "@",
      query: hit.query,
      items: rankCandidates(list, hit.query, { limit })
        .map((candidate) => ({ name: candidate.path, desc: "", matched: candidate.matched })),
      total: stats.files,
      truncated: Boolean(stats.truncated),
      maxFiles: Number(stats.maxFiles) || 0
    }
    cache = { input, cursor, result }
    return result
  }

  function commandSuggestions(input) {
    const query = commandQuery(input)
    if (!query) return NO_SUGGESTIONS
    return {
      ...NO_SUGGESTIONS,
      kind: query.prefix === "$" ? "skill" : "slash",
      sigil: query.prefix,
      query: query.token,
      items: slashSuggestions(input, getSlashOptions())
    }
  }

  return {
    /**
     * 光标处该出哪一类候选。
     * @returns {{kind: string|null, sigil: string|null, items: Array, query: string,
     *            total: number, truncated: boolean, maxFiles: number}}
     */
    compute(input, cursor) {
      const text = String(input ?? "")
      const at = Number.isFinite(Number(cursor)) ? Number(cursor) : text.length
      const hit = mentionQueryAt(text, at)
      if (hit) return mentionSuggestions(hit, text, at)
      return commandSuggestions(text)
    },

    /**
     * 上下键在候选间移动。返回新的选中下标；没有候选时返回 null，调用方据此回落到翻历史。
     *
     * 此前这里的闸门是 `isCommandLikeInput(ui.input)`（行首是不是 `/` 或 `$`），对 `@`
     * 不成立 —— 句中的 `@` 会被判成「不像命令」，于是上下键去翻历史、把用户正在写的那
     * 句话整个换掉。现在闸门就是「有没有候选」，与候选种类无关。
     */
    nextSelection(suggestions, selected, keyName) {
      const total = suggestions.items.length
      if (!total) return null
      const current = Math.max(0, Math.min(Number(selected) || 0, total - 1))
      return keyName === "up" ? Math.max(0, current - 1) : Math.min(total - 1, current + 1)
    },

    /**
     * 写回选中的候选。**按 kind 分派**：
     *
     * - 命令：整行替换（`applySuggestionToInput`），光标到行尾 —— 命令占据整行。
     * - 文件：只替换光标处那一个 token（`applyMention`），光标落在它之后 —— 引用是句子的
     *   一部分，整行替换会把用户写了一半的那句话吃掉。
     *
     * @returns {{text: string, cursor: number}|null} 没有候选时返回 null
     */
    apply(input, cursor, suggestions, selected) {
      const chosen = pick(suggestions, selected)
      if (!chosen) return null
      if (suggestions.kind === "mention") return applyMention(input, cursor, chosen.name)
      const text = applySuggestionToInput(input, chosen.name)
      return { text, cursor: text.length }
    },

    /**
     * Enter 是「选中」还是「发送」。
     *
     * 文件候选沿用命令候选的判据：**打全了就发送**。用户把 `@src/repl.mjs` 完整打出来时
     * 再要求他先 Enter 选一次、再 Enter 发送，就成了一个每次都得多按一下的机关。
     */
    shouldApplyOnEnter(input, suggestions, selected) {
      if (suggestions.kind === "mention") {
        const chosen = pick(suggestions, selected)
        return Boolean(chosen && chosen.name !== suggestions.query)
      }
      return shouldApplySlashOnEnter(input, suggestions.items, selected)
    },

    /** 重建文件索引（新建/删除文件后）。唯一的失效入口，顺带清掉候选缓存。 */
    refresh() {
      cache = null
      return ensureIndex().refresh()
    },

    /** 索引是否已经建过 —— 给测试断言「启动时不扫盘」用。 */
    indexBuilt() {
      return Boolean(index && index.stats().built)
    }
  }
}
