import test from "node:test"
import assert from "node:assert/strict"
import { splitGraphemes } from "../src/repl/text-layout.mjs"
import {
  deleteRange,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordAfter,
  deleteWordBefore,
  lineEnd,
  lineStart,
  searchHistory,
  wordEndAfter,
  wordStartBefore
} from "../src/repl/line-editing.mjs"

/**
 * 行编辑内核的测试。
 *
 * 每一条都对应一个具体会被用户按出来的情形，而不是为了覆盖率凑数：
 * 输入框里有真的换行符（Shift+Enter），有中文（没有空格可依），有 emoji
 * （一个可见字符十几个 code unit）。这三样任何一样处理错了，光标都会
 * 落到 grapheme 中间，进而让 text-layout 的行布局与终端硬件光标错位。
 */

/** 一段文本上所有合法的光标位置。断言「cursor 在 grapheme 边界上」用它。 */
function boundariesOf(text) {
  return new Set([0, ...splitGraphemes(text).map((part) => part.end)])
}

/**
 * 测试素材里的不可见字符一律写成转义。源码里出现字面的零宽连接符、表意空格、
 * 组合记号时，编辑器里根本看不出来 —— 被谁顺手删掉一个，测试会静默地退化成
 * 在测另一件事，而且仍然是绿的。
 */
const ZWJ = "\u200D"
/** 家庭 emoji：4 个人 + 3 个 ZWJ = 11 个 code unit、1 个可见字符。 */
const FAMILY = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`
/** 日本国旗、中国国旗：各由两个区域指示符组成一个簇。 */
const FLAG_JP = "\u{1F1EF}\u{1F1F5}"
const FLAG_CN = "\u{1F1E8}\u{1F1F3}"
/** "cafe" + U+0301 组合尖音符 —— 分解形式，5 个 code unit、4 个可见字符。 */
const CAFE = "cafe\u0301"
/** U+3000 表意空格：落在 CJK 符号区里，但它是空白。 */
const IDEO_SPACE = "\u3000"

// 素材本身要先站得住：下面几十条断言全建立在「这些串确实是多码点单簇」之上。
// 若哪天 FAMILY 被写成了 4 个独立 emoji，所有「不劈开」的断言都会变得无意义
// 而且照样绿 —— 这一条是那种情况的唯一防线。
test("测试素材确实是多码点的单个 grapheme 簇", () => {
  assert.equal(FAMILY.length, 11)
  assert.equal(splitGraphemes(FAMILY).length, 1)
  assert.equal(FLAG_JP.length, 4)
  assert.equal(splitGraphemes(FLAG_JP).length, 1)
  assert.equal(CAFE.length, 5)
  assert.equal(splitGraphemes(CAFE).length, 4)
  assert.equal(IDEO_SPACE.length, 1)
})

// --- lineStart / lineEnd：逻辑行，不是视觉行 ---

test("单行文本里行首恒为 0、行尾恒为末尾", () => {
  assert.equal(lineStart("hello", 0), 0)
  assert.equal(lineStart("hello", 3), 0)
  assert.equal(lineEnd("hello", 0), 5)
  assert.equal(lineEnd("hello", 3), 5)
})

test("多行文本里 Ctrl+A/E 停在当前逻辑行，不飞到整段的两端", () => {
  // 这正是「行是逻辑行」的意义：输入框支持 Shift+Enter，第二行按 Ctrl+A
  // 应当停在第二行开头，而不是回到整个输入的最前面。
  const text = "abc\ndef\nghi"
  assert.equal(lineStart(text, 5), 4)
  assert.equal(lineEnd(text, 5), 7)
  assert.equal(lineStart(text, 9), 8)
  assert.equal(lineEnd(text, 9), 11)
})

test("光标恰在换行符前后时行首行尾各归各的行", () => {
  // 换行符属于上一行的末尾。index 3 是换行符之前（第一行行尾），
  // index 4 是换行符之后（第二行行首）—— 差一个位置，答案完全不同。
  const text = "abc\ndef"
  assert.equal(lineStart(text, 3), 0)
  assert.equal(lineEnd(text, 3), 3)
  assert.equal(lineStart(text, 4), 4)
  assert.equal(lineEnd(text, 4), 7)
})

test("空行上行首等于行尾", () => {
  // "abc\n\ndef" 的 index 4 是那个空行。行首行尾都该是 4，不能跑到相邻行去。
  const text = "abc\n\ndef"
  assert.equal(lineStart(text, 4), 4)
  assert.equal(lineEnd(text, 4), 4)
})

test("空文本与越界 index 都被夹住而不是抛错", () => {
  assert.equal(lineStart("", 0), 0)
  assert.equal(lineEnd("", 0), 0)
  assert.equal(lineStart("abc", -5), 0)
  assert.equal(lineEnd("abc", 999), 3)
  assert.equal(lineStart("abc", 999), 0)
})

test("文本以换行符开头时行首不会错位到 1", () => {
  // lastIndexOf 一类的写法在 index 为 0 时会把开头那个换行符也算进去，
  // 于是行首变成 1、Ctrl+A 把光标推到第二个字符上。这条钉住 0。
  assert.equal(lineStart("\nabc", 0), 0)
  assert.equal(lineStart("\nabc", 1), 1)
})

// --- 按词移动：英文 ---

test("Alt+B/F 在英文单词之间移动", () => {
  const text = "hello world"
  assert.equal(wordStartBefore(text, 11), 6)
  assert.equal(wordEndAfter(text, 0), 5)
})

test("移动时先跳过光标方向上的连续空白，再吃掉一个词", () => {
  // emacs 语义。光标停在 "bar" 前面，Alt+B 该越过那三个空格落到 "foo" 的开头，
  // 而不是停在空白与 "foo" 的交界上。
  const text = "foo   bar"
  assert.equal(wordStartBefore(text, 6), 0)
  assert.equal(wordEndAfter(text, 3), 9)
})

test("标点自成一个词，不与相邻单词粘连", () => {
  const text = "foo, bar"
  assert.equal(wordEndAfter(text, 0), 3)   // foo
  assert.equal(wordEndAfter(text, 3), 4)   // 那个逗号
  assert.equal(wordEndAfter(text, 4), 8)   // bar
  assert.equal(wordStartBefore(text, 4), 3)
})

test("snake_case 与 kebab-case 算一个词", () => {
  // `_` 与 `-` 被算进单词字符，否则 Ctrl+W 删一个标识符要按三次。
  assert.equal(wordStartBefore("call snake_case here", 15), 5)
  assert.equal(wordStartBefore("call kebab-case here", 15), 5)
  assert.equal(wordEndAfter("snake_case here", 0), 10)
})

test("驼峰不拆 —— 这是选择，不是遗漏", () => {
  // camelCase 全是字母、同属单词类，因此是一个词。拆驼峰会让 Ctrl+W 在写英文
  // 散文时变得话痨；要拆驼峰的人用的是 IDE，不是 REPL 输入框。
  assert.equal(wordStartBefore("camelCase", 9), 0)
  assert.equal(wordEndAfter("camelCase", 0), 9)
})

// --- 按词移动：中文 ---

test("连续汉字算一个词", () => {
  // 不做分词、不引词典。整串同类即一个词。
  const text = "这是一段中文"
  assert.equal(wordStartBefore(text, text.length), 0)
  assert.equal(wordEndAfter(text, 0), text.length)
})

test("中英之间是词边界", () => {
  // "写代码code"：中文与拉丁字母跨类，边界在 index 3。中文没有空格可依，
  // 这条边界是中文写作时 Ctrl+W 唯一能停下来的地方。
  const text = "写代码code"
  assert.equal(wordStartBefore(text, text.length), 3)
  assert.equal(wordEndAfter(text, 0), 3)
  assert.equal(wordStartBefore(text, 3), 0)
})

test("ASCII 标点在中文之间是边界", () => {
  // 半角逗号属「其它标点」类，与两侧的汉字跨类。
  assert.equal(wordStartBefore("你好,世界", 5), 3)
})

test("全角标点被归进 CJK 类，因此不构成词边界", () => {
  // 这是任务定死的分类（「CJK（含中日韩统一表意文字、假名、全角标点）」）。
  // 后果要说在明处：整句同类，Ctrl+W 一次吞掉整句而不是停在全角逗号上 ——
  // 与上一条的半角逗号形成对照。若哪天改成「全角标点是词边界」，改的是
  // line-editing.mjs 里 FULLWIDTH_PUNCT_RANGES 的归属，这条要跟着改。
  assert.equal(wordStartBefore("你好，世界", 5), 0)
  // 全角标点与拉丁字母之间仍然是边界（跨类）
  assert.equal(wordStartBefore("你好，abc", 6), 3)
})

test("全角空格算空白而不算 CJK", () => {
  // U+3000 落在 CJK 符号区里，但它是空白。若被误判成 CJK，wordEndAfter 会把它
  // 自己当成一个词、停在 index 2；正确答案是越过它一路吃到 "b"。
  const text = `a${IDEO_SPACE}b`
  assert.equal(wordEndAfter(text, 0), 1)
  assert.equal(wordEndAfter(text, 1), 3)
})

test("假名与汉字同属 CJK 类", () => {
  // 日文同样没有空格；假名不该被当成「其它」而与汉字割开。
  const text = "こんにちは世界"
  assert.equal(wordStartBefore(text, text.length), 0)
})

// --- emoji 与组合字符：按词删除不能劈开 ---

test("ZWJ 家庭 emoji 被整簇删除", () => {
  // 11 个 code unit、1 个可见字符。删一半会在输入框里留下半个家庭。
  const text = `hi ${FAMILY}`
  const result = deleteWordBefore(text, text.length)
  assert.equal(result.text, "hi ")
  assert.equal(result.removed, FAMILY)
  assert.equal(result.cursor, 3)
})

test("ZWJ 家庭 emoji 向后删也不会被劈开", () => {
  const text = `${FAMILY}ok`
  const result = deleteWordAfter(text, 0)
  assert.equal(result.text, "ok")
  assert.equal(result.removed, FAMILY)
})

test("带变音符的拉丁字母不会与基字符分家", () => {
  // 若按 code unit 删，会剩下一个孤零零的组合记号，它会挂到前一个字符上。
  const text = `ab ${CAFE}`
  const result = deleteWordBefore(text, text.length)
  assert.equal(result.text, "ab ")
  assert.equal(result.removed, CAFE)
})

test("落在组合字符中间的 index 被夹到簇边界", () => {
  // index 4 在 "e" 与组合尖音符之间。deleteRange 必须把它夹回 3，
  // 于是删掉的是整个带音标的字母而不是半个簇。
  const result = deleteRange(CAFE, 4, 5)
  assert.equal(result.text, "caf")
  assert.equal(result.removed, CAFE.slice(3))
  assert.equal(result.removed.length, 2)
  assert.equal(result.cursor, 3)
})

test("区域指示符旗帜被整簇删除", () => {
  // 旗帜是两个区域指示符组成的一个簇。删掉一半会变成一个孤立的字母符号。
  const text = `a${FLAG_JP}`
  const result = deleteWordBefore(text, text.length)
  assert.equal(result.text, "a")
  assert.equal(result.removed, FLAG_JP)
  assert.equal(result.cursor, 1)
})

// --- Ctrl+K / Ctrl+U ---

test("Ctrl+K 在行尾删掉换行符、把下一行接上来", () => {
  // emacs kill-line 的行为：连按 Ctrl+K 能把多行逐段收掉。
  // 否则在行尾按下去毫无反应，用户得改按 Delete。
  const result = deleteToLineEnd("abc\ndef", 3)
  assert.equal(result.text, "abcdef")
  assert.equal(result.cursor, 3)
  assert.equal(result.removed, "\n")
})

test("Ctrl+K 在行中只删到行尾，不碰换行符", () => {
  const result = deleteToLineEnd("abc\ndef", 1)
  assert.equal(result.text, "a\ndef")
  assert.equal(result.cursor, 1)
  assert.equal(result.removed, "bc")
})

test("Ctrl+K 在 CRLF 行尾把 CR 与 LF 一起删掉", () => {
  // 粘贴进来的文本可能带 CRLF。只删掉 LF 会留下一个孤零零的 CR。
  const result = deleteToLineEnd("abc\r\ndef", 3)
  assert.equal(result.text, "abcdef")
  assert.equal(result.removed, "\r\n")
})

test("Ctrl+K 在整段文本末尾是 no-op", () => {
  const result = deleteToLineEnd("abc", 3)
  assert.equal(result.text, "abc")
  assert.equal(result.cursor, 3)
  assert.equal(result.removed, "")
})

test("Ctrl+U 在行首是 no-op，不会把上一行接过来", () => {
  // 与 Ctrl+K 故意不对称：Ctrl+U 的肌肉记忆来自 readline 的 unix-line-discard
  // ——「清掉我这一行」。这里没有 kill ring 可以撤回（Ctrl+Y 被「选中即复制」
  // 开关占用，因此不做 yank），所以让它在行首哑掉，比悄悄吃掉上一行安全。
  const result = deleteToLineStart("abc\ndef", 4)
  assert.equal(result.text, "abc\ndef")
  assert.equal(result.cursor, 4)
  assert.equal(result.removed, "")
})

test("Ctrl+U 删到当前逻辑行的行首而不是整段开头", () => {
  const result = deleteToLineStart("abc\ndef", 6)
  assert.equal(result.text, "abc\nf")
  assert.equal(result.cursor, 4)
  assert.equal(result.removed, "de")
})

// --- 返回的 cursor 必须在 grapheme 边界上 ---

test("所有删除函数返回的 cursor 都落在 grapheme 边界上", () => {
  // 这是整个模块的不变量。光标停在簇中间不会立刻报错，而是让 text-layout
  // 算出来的硬件光标位置与实际显示错位 —— 那种 bug 极难反查到这里。
  const samples = [
    "",
    "abc",
    "abc\ndef",
    "中文abc 你好",
    `a${FAMILY}b ${CAFE}`,
    `${FLAG_JP}${FLAG_CN} ok`
  ]
  const operations = [deleteWordBefore, deleteWordAfter, deleteToLineStart, deleteToLineEnd]
  for (const text of samples) {
    const legal = boundariesOf(text)
    for (let index = -2; index <= text.length + 2; index += 1) {
      for (const operate of operations) {
        const result = operate(text, index)
        assert.ok(legal.has(result.cursor),
          `${operate.name}(${JSON.stringify(text)}, ${index}) 的 cursor ${result.cursor} 不在簇边界上`)
        // text / cursor / removed 三者必须自洽：删掉的正是 cursor 处的那一段
        assert.equal(
          result.text,
          text.slice(0, result.cursor) + text.slice(result.cursor + result.removed.length),
          `${operate.name}(${JSON.stringify(text)}, ${index}) 的 text/cursor/removed 对不上`)
      }
    }
  }
})

test("按词移动的落点也都在 grapheme 边界上", () => {
  const text = `a${FAMILY} 中文 ${CAFE}`
  const legal = boundariesOf(text)
  for (let index = -2; index <= text.length + 2; index += 1) {
    assert.ok(legal.has(wordStartBefore(text, index)), `wordStartBefore(${index}) 落在簇中间`)
    assert.ok(legal.has(wordEndAfter(text, index)), `wordEndAfter(${index}) 落在簇中间`)
  }
})

// --- 边界与幂等 ---

test("空文本上每个函数都返回空结果而不抛错", () => {
  assert.equal(wordStartBefore("", 0), 0)
  assert.equal(wordEndAfter("", 0), 0)
  for (const operate of [deleteWordBefore, deleteWordAfter, deleteToLineStart, deleteToLineEnd]) {
    assert.deepEqual(operate("", 0), { text: "", cursor: 0, removed: "" },
      `${operate.name} 在空文本上不该动`)
  }
})

test("在两端删除是 no-op：开头 Ctrl+W、结尾 Alt+D", () => {
  assert.deepEqual(deleteWordBefore("abc", 0), { text: "abc", cursor: 0, removed: "" })
  assert.deepEqual(deleteWordAfter("abc", 3), { text: "abc", cursor: 3, removed: "" })
})

test("越界的 index 被夹住而不是产生负下标或截断", () => {
  assert.deepEqual(deleteWordBefore("abc", 999), { text: "", cursor: 0, removed: "abc" })
  assert.deepEqual(deleteWordAfter("abc", -5), { text: "", cursor: 0, removed: "abc" })
  assert.equal(wordStartBefore("abc", -5), 0)
  assert.equal(wordEndAfter("abc", 999), 3)
})

test("deleteRange 认反过来的区间，两端各自被夹到边界", () => {
  assert.deepEqual(deleteRange("abcdef", 4, 2), { text: "abef", cursor: 2, removed: "cd" })
  assert.deepEqual(deleteRange("abcdef", 2, 2), { text: "abcdef", cursor: 2, removed: "" })
  assert.deepEqual(deleteRange("abc", Number.NaN, 2), { text: "c", cursor: 0, removed: "ab" })
})

test("连按 Ctrl+W 逐词后退，删空之后停在开头不再动", () => {
  // 幂等收敛：删空之后再按不该产生负下标或空转异常。
  let state = { text: "one two three", cursor: 13, removed: "" }
  for (let round = 0; round < 6; round += 1) {
    state = deleteWordBefore(state.text, state.cursor)
  }
  assert.equal(state.text, "")
  assert.equal(state.cursor, 0)
})

// --- 历史反向搜索（Ctrl+R）---

/** 最新的在数组末尾 —— 与 ui.history 的 push 顺序、loadHistoryLines 的读入顺序一致。 */
const HISTORY = ["git status", "npm test", "Git commit -m wip", "node --test"]

test("Ctrl+R 从最近一条开始往回找", () => {
  const hit = searchHistory(HISTORY, "git")
  assert.deepEqual(hit, { index: 2, entry: "Git commit -m wip", matched: [0, 3] })
})

test("连按 Ctrl+R 跳过当前这条，继续往更旧走", () => {
  // from 给的是「上一次命中的下标」，所以要从 from + direction 起算；
  // 否则连按 Ctrl+R 会原地不动。
  const hit = searchHistory(HISTORY, "git", { from: 2 })
  assert.deepEqual(hit, { index: 0, entry: "git status", matched: [0, 3] })
})

test("往更旧走到头返回 null", () => {
  assert.equal(searchHistory(HISTORY, "git", { from: 0 }), null)
  assert.equal(searchHistory(HISTORY, "根本没有这一条"), null)
})

test("direction 为 +1 时往更新的方向回来", () => {
  const hit = searchHistory(HISTORY, "git", { from: 0, direction: 1 })
  assert.deepEqual(hit, { index: 2, entry: "Git commit -m wip", matched: [0, 3] })
  assert.equal(searchHistory(HISTORY, "git", { from: 2, direction: 1 }), null)
})

test("匹配大小写不敏感", () => {
  // 历史里存的是 "Git commit"，用户打的是小写；反过来也要命中。
  assert.equal(searchHistory(HISTORY, "GIT STATUS")?.index, 0)
  assert.equal(searchHistory(HISTORY, "NPM")?.index, 1)
})

test("空 query 返回 null 而不是第一条", () => {
  // Ctrl+R 刚按下、还没输入时不该立刻跳到某条历史上去。
  assert.equal(searchHistory(HISTORY, ""), null)
  assert.equal(searchHistory(HISTORY, "", { from: 3 }), null)
  assert.equal(searchHistory(HISTORY, null), null)
  assert.equal(searchHistory(HISTORY, undefined), null)
})

test("matched 区间与 entry 对得上，且不总是从 0 开始", () => {
  // 高亮用的就是这个区间。若它总是 [0, n]，UI 会把每条的开头涂亮 —— 看着像对的。
  const hit = searchHistory(HISTORY, "test")
  assert.equal(hit.index, 3)
  assert.equal(hit.entry, "node --test")
  assert.deepEqual(hit.matched, [7, 11])
  assert.equal(hit.entry.slice(hit.matched[0], hit.matched[1]), "test")
})

test("matched 区间指向原串，大小写不同时切出来的是原串的写法", () => {
  const hit = searchHistory(["Git COMMIT -m WIP"], "commit")
  assert.deepEqual(hit.matched, [4, 10])
  assert.equal(hit.entry.slice(hit.matched[0], hit.matched[1]), "COMMIT")
})

test("条目里含 U+0130 时 matched 区间不会被算歪", () => {
  // 用 toLowerCase() 找下标的写法在这里会错位：U+0130 小写成两个 code unit，
  // 于是小写串比原串长，indexOf 得到的下标拿回原串上一切就切偏了。
  // 实现走的是正则 i 标志、直接在原串上匹配，所以下标天然可用。
  const entry = "\u0130 \u0130stanbul"
  assert.equal(entry.toLowerCase().length, entry.length + 2)   // 先钉住「小写会变长」这个前提
  const hit = searchHistory([entry], "stanbul")
  assert.deepEqual(hit.matched, [3, 10])
  assert.equal(entry.slice(hit.matched[0], hit.matched[1]), "stanbul")
})

test("query 里的正则元字符按字面量搜", () => {
  // 用户在 Ctrl+R 里打 ".*" 就是想找 ".*"，不是想匹配任意串。
  const hit = searchHistory(["plain text", "grep a.*b"], ".*")
  assert.equal(hit.index, 1)
  assert.deepEqual(hit.matched, [6, 8])
  assert.equal(searchHistory(["plain text"], ".*"), null)
})

test("非字符串条目与空历史都不会让搜索炸掉", () => {
  assert.equal(searchHistory([], "git"), null)
  assert.equal(searchHistory(null, "git"), null)
  assert.equal(searchHistory([null, undefined, 42, "git log"], "git")?.index, 3)
})

test("中文历史条目也能搜到，matched 用的是 code unit 下标", () => {
  // UI 高亮时会拿这个下标去切 entry，所以必须与 entry 的字符串下标同一套。
  const hit = searchHistory(["前缀 提交代码 后缀"], "提交")
  assert.deepEqual(hit.matched, [3, 5])
  assert.equal(hit.entry.slice(hit.matched[0], hit.matched[1]), "提交")
})
