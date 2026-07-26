import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  thinkingPreviewLines,
  THINKING_PREVIEW_ROWS,
  THINKING_PREVIEW_PAGE_CHARS
} from "../src/ui/thinking-preview.mjs"
import { displayWidth } from "../src/repl/frame-primitives.mjs"

/**
 * 0.6.2：思考中显示两行灰字的实时尾部。
 *
 * 此前只有一行 `Thinking · 5.1s` —— 你知道它在想，但不知道在想什么。
 * 完整思考又不能铺开：常常几百行，会把对话挤没。
 *
 * **行数必须恒定**是这里唯一的硬约束：帧的行数记账按块的实际行数计费，
 * 一个会变高的块会让对话区随模型输出上下抖动。
 *
 * 0.6.29：用户报告「两行一直在乱跳」。原因是行边界锚在尾部 —— 每多一个字符
 * 切片起点就右移一格，两行字逐字符地滚。下面「行边界稳定」一节就是这个 bug
 * 的最小化回归。
 */

/** 独立于实现的字素簇边界（测试不复用被测代码的宽度/切分逻辑）。 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
function graphemeBoundaries(text) {
  const set = new Set([0])
  for (const part of segmenter.segment(text)) set.add(part.index + part.segment.length)
  return set
}

describe("行数恒定", () => {
  it("无论输入多长多短，永远返回固定行数", () => {
    const cases = ["", "  ", "短", "一".repeat(500), "a\nb\nc\nd\ne\nf\ng"]
    for (const input of cases) {
      const lines = thinkingPreviewLines(input, 60)
      assert.equal(lines.length, THINKING_PREVIEW_ROWS, `输入 ${JSON.stringify(input.slice(0, 20))} 行数不对`)
    }
  })

  it("可以指定行数", () => {
    assert.equal(thinkingPreviewLines("abc", 60, 4).length, 4)
    assert.equal(thinkingPreviewLines("abc", 60, 1).length, 1)
  })

  it("空输入返回空行而不是 undefined", () => {
    assert.deepEqual(thinkingPreviewLines("", 60), ["", ""])
    assert.deepEqual(thinkingPreviewLines(null, 60), ["", ""])
  })

  /**
   * fixedRows 按块的实际行数计费，块高度一变整个对话区就上下抖 —— 所以
   * 「不足半行」「恰好一行」「一行多一点」这些边界都得逐个钉住，不能只测
   * 一个「够长」的输入。
   */
  it("各种长度边界都恰好返回 rows 行", () => {
    const width = 20
    const cases = [
      ["空", ""],
      ["纯空白", "   \n  \t "],
      ["半行", "x".repeat(9)],
      ["恰好一行", "x".repeat(20)],
      ["一行多一个字符", "x".repeat(21)],
      ["恰好两行", "x".repeat(40)],
      ["远超两行", "x".repeat(4000)]
    ]
    for (const [label, input] of cases) {
      const lines = thinkingPreviewLines(input, width)
      assert.equal(lines.length, THINKING_PREVIEW_ROWS, `${label}: 行数 ${lines.length}`)
      assert.ok(lines.every((line) => typeof line === "string"), `${label}: 有非字符串行`)
    }
  })
})

describe("行边界稳定 —— 用户报告的「乱跳」", () => {
  /**
   * 核心回归。旧实现把窗口锚在尾部（`flat.slice(-usable * limit)`），每多一个
   * 字符所有行的边界就整体左移一格，肉眼看到的就是两行字在逐字符地滚。
   *
   * 判据：把文本一个字符一个字符地喂进去，第一行只允许两种变化 ——
   *   a) 原样不动（还在窗口里）；
   *   b) 等于上一帧的第二行（窗口整行上滚了一行）。
   * 「同一行内容左移一格」两条都不满足，就是这条断言要抓的东西。
   */
  it("已经成型的行永不改变：要么不动，要么整行上滚", () => {
    // 每一行的内容都不重复，避免「左移一格后恰好等于上一帧某行」的巧合让断言空过
    const source = Array.from({ length: 60 }, (_, i) => `seg${i}`).join(" ")
    const width = 24
    let previous = null
    let checked = 0
    for (let n = 1; n <= source.length; n += 1) {
      const lines = thinkingPreviewLines(source.slice(0, n), width)
      if (previous && previous[0]) {
        assert.ok(
          lines[0] === previous[0] || lines[0] === previous[1],
          `第 ${n} 个字符处第一行既没保持也不是整行上滚：\n  上一帧 ${JSON.stringify(previous)}\n  这一帧 ${JSON.stringify(lines)}`
        )
        checked += 1
      }
      previous = lines
    }
    // 防止上面的循环因为第一行始终为空而一次都没断言到（空洞通过）
    assert.ok(checked > 100, `实际做出的稳定性断言只有 ${checked} 次，太少，说明没测到东西`)
  })

  it("一行填满之前，第一行保持空、内容留在最后一行", () => {
    const width = 30
    for (let n = 1; n <= width; n += 1) {
      const text = "x".repeat(n)
      const lines = thinkingPreviewLines(text, width)
      assert.equal(lines[0], "", `${n} 个字符时第一行不该有内容: ${JSON.stringify(lines)}`)
      assert.equal(lines[1], text, `${n} 个字符时内容该整段留在最后一行: ${JSON.stringify(lines)}`)
    }
    // 再多一个字符才开新行 —— 「一行显示完了，直接切换到下一行」
    const overflow = thinkingPreviewLines("x".repeat(width + 1), width)
    assert.equal(overflow[0], "x".repeat(width))
    assert.equal(overflow[1], "x")
  })

  /**
   * 实现内部有一份增量记忆（流式追加时不重折已封口的行）。它必须是**纯**
   * 记忆化：命中与否结果必须一致，否则「稳定」只是缓存的假象，一次 resize
   * 或一次重建就会跳。
   */
  it("增量喂入与一次性喂入结果一致", () => {
    const source = Array.from({ length: 400 }, (_, i) => `片段${i}`).join(" ")
    const width = 46
    let incremental = null
    for (let n = 1; n <= source.length; n += 7) incremental = thinkingPreviewLines(source.slice(0, n), width)
    incremental = thinkingPreviewLines(source, width)

    // 换一段完全不同的输入把记忆挤掉，逼出冷启动路径
    thinkingPreviewLines("zzz 另一段思考", width)
    const cold = thinkingPreviewLines(source, width)
    assert.deepEqual(incremental, cold, "增量结果与冷启动结果不一致 —— 记忆化不纯")
  })
})

describe("显示的是尾部", () => {
  it("长文本只保留最后两行的量", () => {
    const long = Array.from({ length: 50 }, (_, i) => `segment-${i}`).join(" ")
    const lines = thinkingPreviewLines(long, 40)
    assert.ok(lines.at(-1).includes("segment-49"), `尾部应含最新内容: ${lines.at(-1)}`)
    assert.ok(!lines.join("").includes("segment-0"), "不该还留着最早的内容")
  })

  it("每行不超过给定宽度", () => {
    const long = "x".repeat(500)
    for (const line of thinkingPreviewLines(long, 30)) {
      assert.ok(line.length <= 30, `行超宽: ${line.length}`)
    }
  })

  it("换行被压平 —— 段落停顿不该让窗口一跳一跳", () => {
    const lines = thinkingPreviewLines("first\n\n\nsecond", 60)
    assert.ok(lines.join(" ").includes("first second"), `换行应压成空格: ${JSON.stringify(lines)}`)
  })
})

describe("按显示列宽切行，不按字符数", () => {
  /**
   * 缺陷 2：旧实现按字符数切（`slice(i, i + usable)`），而参数给的是列宽。
   * 一行 76 个汉字实际占 152 列，调用方 frame-builder 的 clipAnsiLine 会把
   * 超出的一半悄悄截掉 —— 中文界面里每行只看得见一半内容。
   */
  it("一行中文的显示列宽不超过传入的 width", () => {
    const width = 40
    const raw = "我们需要仔细分析这个问题的边界条件，然后考虑各种可能的实现方案。".repeat(6)
    const lines = thinkingPreviewLines(raw, width)
    let filled = 0
    for (const line of lines) {
      assert.ok(displayWidth(line) <= width, `中文行占 ${displayWidth(line)} 列，超过 ${width}`)
      if (displayWidth(line) > 0) filled += 1
    }
    // 若两行都是空串，上面的断言会毫无意义地通过
    assert.equal(filled, THINKING_PREVIEW_ROWS, `应该两行都有内容: ${JSON.stringify(lines)}`)
    // 中文是双列宽：一行装得下的汉字数必须明显少于列数，否则说明还在按字符切
    assert.ok(lines[0].length <= width / 2, `一行装了 ${lines[0].length} 个汉字，说明还在按字符数切行`)
  })

  it("中英混排也按列宽切", () => {
    const width = 30
    const raw = "分析 analyze 边界 boundary 条件 condition ".repeat(10)
    for (const line of thinkingPreviewLines(raw, width)) {
      assert.ok(displayWidth(line) <= width, `混排行占 ${displayWidth(line)} 列，超过 ${width}`)
    }
  })
})

describe("不劈开字素簇", () => {
  /**
   * 按码元切会把宽字符的代理对、emoji 的 ZWJ 序列、字母后面的组合重音劈成
   * 两半，终端上画出来是替换符或错位。这里不比对具体行内容，而是直接验证
   * **每个行边界都落在原文的字素簇边界上** —— 这条对任何切分实现都成立。
   */
  const samples = [
    ["中文", "我们需要仔细分析这个问题的边界条件然后给出结论".repeat(4)],
    ["emoji", "ok 😀🎉🚀 done 🔥🌟 next 🐳🧪 end ".repeat(6)],
    ["ZWJ 家庭 emoji", "家庭 👨‍👩‍👧‍👦 团队 👩‍💻 旗帜 🏳️‍🌈 结束 ".repeat(5)],
    ["组合重音", "café naïve résumé ".repeat(10)],
    ["肤色修饰", "wave 👋🏽 point 👉🏿 hand ✋🏻 ".repeat(8)]
  ]

  for (const [label, raw] of samples) {
    it(`${label}：行边界落在字素簇边界上`, () => {
      const width = 28
      const flat = raw.replace(/\s+/g, " ").trim()
      const boundaries = graphemeBoundaries(flat)
      const lines = thinkingPreviewLines(raw, width)
      const joined = lines.join("")
      // 锚点自检：窗口内容必须真的是原文的后缀，否则下面的位移全是错的
      assert.ok(flat.endsWith(joined) && joined.length > 0, `${label}: 窗口内容不是原文后缀，位移无从算起`)

      let offset = flat.length - joined.length
      assert.ok(boundaries.has(offset), `${label}: 窗口起点 ${offset} 不在字素簇边界上`)
      for (const line of lines) {
        offset += line.length
        assert.ok(boundaries.has(offset), `${label}: 行边界 ${offset} 劈开了字素簇`)
      }
      for (const line of lines) {
        assert.ok(displayWidth(line) <= width, `${label}: 行占 ${displayWidth(line)} 列，超过 ${width}`)
        assert.doesNotMatch(line, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u, `${label}: 行尾留下了孤立的高代理项`)
        assert.doesNotMatch(line, /^[\uDC00-\uDFFF]/u, `${label}: 行首是孤立的低代理项`)
        assert.doesNotMatch(line, /^‍|‍$/u, `${label}: ZWJ 序列被劈成两半`)
        assert.doesNotMatch(line, /^\p{Mark}/u, `${label}: 组合字符与它的基字被拆开`)
      }
    })
  }
})

describe("页边界不劈开字素簇", () => {
  /**
   * 实现为了给工作量封顶，每 PAGE 个**码元**强制断一次行。这个下标是按码元
   * 算的，可能正好落在代理对中间或把重音从基字上切下来 —— 那一行开头就画出
   * 半个字。这条构造出「簇正好横跨页边界」的输入把它钉住。
   *
   * 页长从实现导出，不手写常量：改了页长这条测试要跟着动，而不是静默失效。
   */
  const page = THINKING_PREVIEW_PAGE_CHARS
  const width = 28
  // 尾巴长度要恰好折出 rows 行，这样窗口第一行就是页首 —— 否则被劈开的那行
  // 早就滚出窗口，断言会对着空气成立
  const tail = "b".repeat(40)
  const cases = [
    ["组合重音横跨页边界", "é"],
    ["星际平面 emoji 横跨页边界", "😀"],
    ["ZWJ 序列横跨页边界", "👩‍💻"]
  ]

  for (const [label, cluster] of cases) {
    it(label, () => {
      // 让 cluster 的第 2 个码元正好落在页边界上
      const raw = `${"a".repeat(page - 1)}${cluster}${tail}`
      thinkingPreviewLines("###", width) // 挤掉记忆，走冷启动
      const lines = thinkingPreviewLines(raw, width)
      assert.equal(lines.length, THINKING_PREVIEW_ROWS)
      // 锚点自检：第一行必须真的是页首那一行，否则下面几条断言测不到东西
      assert.ok(
        lines[0].startsWith(cluster),
        `${label}: 窗口第一行没有从完整的簇开始，实际 ${JSON.stringify(lines[0].slice(0, 8))}`
      )
      assert.doesNotMatch(lines[0], /^[\uDC00-\uDFFF]/u, `${label}: 行首是孤立的低代理项`)
      assert.doesNotMatch(lines[0], /^\p{Mark}/u, `${label}: 行首是被切下来的组合字符`)
      assert.doesNotMatch(lines[0], /^‍/u, `${label}: 行首是被切开的 ZWJ`)
    })
  }
})

describe("工作量有上限", () => {
  /**
   * 思考流可能几万字符，而帧间隔只有 16ms（TUI_FRAME_MS）。逐字素折行大约
   * 6µs/字素，从头折 30 万字符是接近两秒 —— 每帧都做等于挂死。
   *
   * 断言写成**比值**而不是绝对毫秒：工作量有上限时，30 万字符与 1.2 万字符
   * 的冷启动开销应当在同一量级（都只折最后一两页）；一旦退化成全量遍历，
   * 前者会慢 20 倍以上。比值对机器快慢和 CI 负载都不敏感。
   */
  const build = (chars, seed) => `${seed} 我们需要仔细分析这个问题的边界条件。`.repeat(Math.ceil(chars / 20)).slice(0, chars)

  const coldCall = (text, width) => {
    // 用一段完全不同的短文本挤掉记忆，确保测到的是冷启动路径
    thinkingPreviewLines("###", width)
    const started = process.hrtime.bigint()
    const lines = thinkingPreviewLines(text, width)
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(lines.length, THINKING_PREVIEW_ROWS)
    return elapsed
  }

  it("冷启动开销不随输入长度线性增长", () => {
    const small = build(12000, "小")
    const huge = build(300000, "大")
    // 取多轮最小值，抹掉 GC 与调度噪声
    let smallMs = Infinity
    let hugeMs = Infinity
    for (let i = 0; i < 5; i += 1) {
      smallMs = Math.min(smallMs, coldCall(small, 62))
      hugeMs = Math.min(hugeMs, coldCall(huge, 62))
    }
    assert.ok(
      hugeMs < smallMs * 5 + 5,
      `30 万字符 ${hugeMs.toFixed(1)}ms vs 1.2 万字符 ${smallMs.toFixed(1)}ms —— 开销随长度线性增长，说明在做全量遍历`
    )
  })

  it("流式追加的稳态开销与已积累长度无关", () => {
    const width = 62
    const base = build(300000, "流")
    // 先把 30 万字符喂进去建立记忆，再逐字符追加：稳态只该折「在制行 + 新字符」
    thinkingPreviewLines(base, width)
    const started = process.hrtime.bigint()
    for (let i = 1; i <= 200; i += 1) thinkingPreviewLines(base + "追加".repeat(i), width)
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(elapsed < 2000, `30 万字符上追加 200 次用了 ${elapsed.toFixed(0)}ms，稳态开销没有摊平`)
  })
})

test("极窄宽度不会崩", () => {
  const lines = thinkingPreviewLines("some thinking text here", 1)
  assert.equal(lines.length, THINKING_PREVIEW_ROWS)
  assert.ok(lines.every((l) => typeof l === "string"))
})
