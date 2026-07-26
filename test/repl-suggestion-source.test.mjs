import test from "node:test"
import assert from "node:assert/strict"
import { createSuggestionSource, NO_SUGGESTIONS } from "../src/repl/suggestion-source.mjs"

/**
 * 补全候选的唯一来源。
 *
 * 这个模块存在的理由是「候选此前在四处独立求值」，所以这里的断言几乎都在描述**三种候选
 * 之间的关系**，而不是某一种自己的行为（那些在 repl-slash-router 与 repl-file-mention 里
 * 已经测过了）：
 *
 *   - `/` `$` 只认行首，`@` 认光标 —— 同一行里两者都能用
 *   - 写回语义按种类分派：命令整行替换，文件只换光标处那个 token
 *   - 上下键的闸门是「有没有候选」，不再是「输入像不像命令」
 *
 * 文件索引一律注入假的，不走盘 —— 真索引的行为在 repl-file-mention 里用假 fs 测过。
 */

const SLASH_OPTIONS = {
  builtinSlash: [
    { name: "help", desc: "show help" },
    { name: "plan", desc: "plan mode" }
  ],
  customCommands: [],
  skills: [{ name: "review", type: "project" }]
}

/**
 * 假索引：记下 list() 被调过没有，用来断言「懒构建」。
 *
 * `stats()` **在建库之前一律报空**，这是真索引的语义（`createFileIndex` 的 stats 起始是
 * `{built: false, files: 0, truncated: false}`，走完盘才填上）。照着这个语义写，是因为
 * 反过来写会掩盖一个真实的顺序错误：先读 stats、后 list，第一次敲 `@` 拿到的 truncated
 * 恒为 false —— 封顶被静默吞掉，而假索引若不管顺序都报同一份数据，测试会一直绿着。
 */
function fakeIndex(files, { truncated = false, maxFiles = 20000 } = {}) {
  const calls = { list: 0, refresh: 0 }
  const built = () => calls.list > 0 || calls.refresh > 0
  return {
    calls,
    index: {
      list() { calls.list++; return files },
      refresh() { calls.refresh++; return files },
      stats() {
        return built()
          ? { built: true, files: files.length, truncated, maxFiles }
          : { built: false, files: 0, truncated: false, maxFiles }
      }
    }
  }
}

function makeSource(files = ["src/repl.mjs", "src/repl/file-index.mjs", "README.md"], options = {}) {
  const fake = fakeIndex(files, options)
  let created = 0
  const source = createSuggestionSource({
    getSlashOptions: () => SLASH_OPTIONS,
    createIndex: () => { created++; return fake.index }
  })
  return { source, fake, createdCount: () => created }
}

// --- 三种候选各自的触发条件 ---

test("行首的 / 出命令候选，$ 出技能候选", () => {
  const { source } = makeSource()
  const slash = source.compute("/he", 3)
  assert.equal(slash.kind, "slash")
  assert.equal(slash.sigil, "/")
  assert.deepEqual(slash.items.map((item) => item.name), ["help"])

  const skill = source.compute("$rev", 4)
  assert.equal(skill.kind, "skill")
  assert.equal(skill.sigil, "$")
  assert.deepEqual(skill.items.map((item) => item.name), ["review"])
})

test("普通一句话没有任何候选", () => {
  const { source } = makeSource()
  assert.deepEqual(source.compute("怎么改这个函数", 7), NO_SUGGESTIONS)
})

test("@ 在句子中间也出文件候选 —— 它是光标感知的，不是行首语义", () => {
  const { source } = makeSource()
  const input = "看看 @src/repl 为什么慢"
  const at = input.indexOf("为什么") - 1
  const hit = source.compute(input, at)
  assert.equal(hit.kind, "mention")
  assert.equal(hit.sigil, "@")
  assert.equal(hit.query, "src/repl")
  assert.deepEqual(hit.items.map((item) => item.name), ["src/repl.mjs", "src/repl/file-index.mjs"])
})

test("@ 与 / 在同一行共存：候选跟着光标走", () => {
  // 这一条守的是「两种触发语义能不能并存」。`/` 认行首、`@` 认光标，所以同一个字符串
  // 在两个光标位置必须给出两种候选 —— 只按行首判前导符的话，`/plan @…` 永远只出命令。
  const { source } = makeSource()
  const input = "/plan @src/repl"

  const onCommand = source.compute(input, 3)
  assert.equal(onCommand.kind, "slash")
  assert.deepEqual(onCommand.items.map((item) => item.name), ["plan"])

  const onMention = source.compute(input, input.length)
  assert.equal(onMention.kind, "mention")
  assert.deepEqual(onMention.items.map((item) => item.name), ["src/repl.mjs", "src/repl/file-index.mjs"])
})

test("光标停在 @ 左侧不算命中 —— 那时用户还没开始写这个引用", () => {
  const { source } = makeSource()
  const input = "看看 @src"
  assert.equal(source.compute(input, input.indexOf("@")).kind, null)
  assert.equal(source.compute(input, input.indexOf("@") + 1).kind, "mention")
})

// --- 懒构建 ---

test("索引在第一次需要文件候选之前不建", () => {
  // 启动时扫全仓会让大仓库下的 TUI 起不来。命令候选走的是另一条路，一次盘都不该碰。
  const { source, fake, createdCount } = makeSource()
  assert.equal(createdCount(), 0)
  source.compute("/help", 5)
  source.compute("普通输入", 4)
  assert.equal(createdCount(), 0, "命令候选不该碰文件索引")
  assert.equal(fake.calls.list, 0)

  source.compute("@src", 4)
  assert.equal(createdCount(), 1)
  assert.ok(fake.calls.list > 0)
  assert.equal(source.indexBuilt(), true)
})

test("同一次按键里问四遍候选，索引只列一遍", () => {
  // 渲染、上下键、Tab、Enter 都会问一次候选。两万条路径排四遍是白烧的。
  const { source, fake } = makeSource()
  for (let i = 0; i < 4; i++) source.compute("@src/rep", 8)
  assert.equal(fake.calls.list, 1)
  // 输入变了就必须重算，否则候选会停在上一个字符上
  source.compute("@src/repl", 9)
  assert.equal(fake.calls.list, 2)
})

test("refresh 重建索引并清掉缓存", () => {
  const { source, fake } = makeSource()
  source.compute("@src", 4)
  source.refresh()
  assert.equal(fake.calls.refresh, 1)
  source.compute("@src", 4)
  assert.equal(fake.calls.list, 2, "刷新之后再问必须重新列，不能吃旧缓存")
})

// --- 封顶要说出来 ---

test("第一次敲 @ 就要报出封顶 —— 统计要在建库之后读", () => {
  // 索引是懒的，truncated 是走完盘才知道的。先读 stats 后 list 的话，第一次敲 `@`
  // 拿到的是建库前的空统计，封顶被静默吞掉 —— 而用户几乎总是在第一次敲 `@` 时看它。
  const { source } = makeSource(["a.mjs"], { truncated: true, maxFiles: 500 })
  const hit = source.compute("@a", 2)
  assert.equal(hit.truncated, true)
  assert.equal(hit.maxFiles, 500)
  assert.equal(hit.total, 1)
})

// --- 写回按种类分派 ---

test("命令候选整行替换，文件候选只换光标处那个 token", () => {
  const { source } = makeSource()

  const slash = source.compute("/he", 3)
  const appliedSlash = source.apply("/he", 3, slash, 0)
  assert.equal(appliedSlash.text, "/help ")
  assert.equal(appliedSlash.cursor, "/help ".length)

  const input = "看看 @src/rep 为什么慢"
  const cursor = input.indexOf(" 为什么")
  const mention = source.compute(input, cursor)
  const appliedMention = source.apply(input, cursor, mention, 0)
  assert.equal(appliedMention.text, "看看 @src/repl.mjs 为什么慢",
    "整行替换会把用户写了一半的那句话吃掉")
  assert.equal(appliedMention.cursor, "看看 @src/repl.mjs ".length)
})

test("没有候选时写回是空操作", () => {
  const { source } = makeSource()
  assert.equal(source.apply("普通输入", 4, NO_SUGGESTIONS, 0), null)
})

test("选中下标越界时夹紧到两端，不返回 undefined", () => {
  // 候选表会随输入变短，选中位置追不上是常态。
  const { source } = makeSource()
  const mention = source.compute("@src", 4)
  assert.equal(source.apply("@src", 4, mention, 99).text.startsWith("@src/"), true)
  assert.equal(source.apply("@src", 4, mention, -3).text.startsWith("@src/"), true)
})

// --- Enter 是选中还是发送 ---

test("Enter：打全了就发送，没打全先选中", () => {
  const { source } = makeSource()
  const partial = source.compute("@src/rep", 8)
  assert.equal(source.shouldApplyOnEnter("@src/rep", partial, 0), true)

  const complete = source.compute("@src/repl.mjs", 13)
  assert.equal(source.shouldApplyOnEnter("@src/repl.mjs", complete, 0), false,
    "路径已经完整时再要求先 Enter 选一次，就成了每次都得多按一下的机关")
})

test("Enter 在命令候选上沿用原有判据", () => {
  const { source } = makeSource()
  assert.equal(source.shouldApplyOnEnter("/he", source.compute("/he", 3), 0), true)
  assert.equal(source.shouldApplyOnEnter("/help", source.compute("/help", 5), 0), false)
  assert.equal(source.shouldApplyOnEnter("/help foo", source.compute("/help foo", 9), 0), false,
    "带参数的命令行是要执行的，不是要补全的")
})

// --- 上下键的闸门 ---

test("上下键的闸门是「有没有候选」，不是「输入像不像命令」", () => {
  // 此前的闸门是 isCommandLikeInput（行首是不是 / 或 $），对句中的 @ 恒为假 ——
  // 于是上下键会去翻历史，把用户正在写的那句话整个换掉。
  const { source } = makeSource()
  const mention = source.compute("看看 @src", 9)
  assert.equal(source.nextSelection(mention, 0, "down"), 1)
  assert.equal(source.nextSelection(mention, 1, "up"), 0)
})

test("没有候选时上下键交还给历史导航", () => {
  const { source } = makeSource()
  assert.equal(source.nextSelection(NO_SUGGESTIONS, 0, "up"), null)
})

test("选中位置在两端夹紧，不会滚出候选表", () => {
  const { source } = makeSource()
  const mention = source.compute("@src", 4)
  assert.equal(source.nextSelection(mention, 0, "up"), 0)
  assert.equal(source.nextSelection(mention, 99, "down"), mention.items.length - 1)
})
