import test from "node:test"
import assert from "node:assert/strict"
import {
  IMAGE_KIND,
  TEXT_KIND,
  MARKER_PATTERN,
  formatMarker,
  parseMarkers,
  markerSpanAt,
  createAttachmentStore,
  normalizeNewlines,
  countTextLines
} from "../src/repl/attachments.mjs"

/**
 * 附件登记本的不变量是：**输入文本是「哪些附件会被发送」的唯一真相**。
 *
 * 这里的每一条都在钉这个支点的某一面 —— 因为一旦真相变成两处（文本 + 一份「还活着的
 * 附件」列表），失败模式就是「我明明把标记删了它还是发出去了」，而那种不一致极难复现。
 * 所以下面既测「引用到的会被解析」，也测「没引用到的自然消失」「未知 id 当普通文字」。
 */

const IMG = { kind: IMAGE_KIND, data: "AAAA", mediaType: "image/png" }
const withCRLF = (text) => text.replace(/\n/g, "\r\n")
const withCR = (text) => text.replace(/\n/g, "\r")

// --- formatMarker ---

test("formatMarker renders both kinds", () => {
  assert.equal(formatMarker({ kind: IMAGE_KIND, id: 1 }), "[Image #1]")
  assert.equal(formatMarker({ kind: TEXT_KIND, id: 2, chars: 147 }), "[Pasted text #2 +147 chars]")
})

test("a one-line paste says line, not lines", () => {
  // 单复数是用户唯一会盯着看的细节；写错了整个标记看起来就像是拼出来的
  const marker = formatMarker({ kind: TEXT_KIND, id: 3, chars: 1 })
  assert.equal(marker, "[Pasted text #3 +1 char]", `单数形态错了，实际是 ${marker}`)
  const plural = formatMarker({ kind: TEXT_KIND, id: 4, chars: 2 })
  assert.equal(plural, "[Pasted text #4 +2 chars]", `复数形态错了，实际是 ${plural}`)
})

test("every marker formatMarker produces is one MARKER_PATTERN can find", () => {
  // 防呆：格式化与解析是同一份契约的两端，任何一端漂移都会让标记变成死文字
  for (const entry of [
    { kind: IMAGE_KIND, id: 1 },
    { kind: IMAGE_KIND, id: 1234 },
    { kind: TEXT_KIND, id: 2, chars: 1 },
    { kind: TEXT_KIND, id: 3, chars: 900 }
  ]) {
    const raw = formatMarker(entry)
    const found = parseMarkers(raw)
    assert.equal(found.length, 1, `${raw} 没被解析出来`)
    assert.equal(found[0].id, entry.id, `${raw} 解析出的 id 是 ${found[0].id}`)
    assert.equal(found[0].kind, entry.kind, `${raw} 解析出的 kind 是 ${found[0].kind}`)
  }
})

test("formatMarker refuses a kind it does not know", () => {
  assert.throws(() => formatMarker({ kind: "video", id: 1 }), TypeError)
})

// --- parseMarkers ---

test("marker spans point at exactly the marker text", () => {
  // start/end 会被退格与光标移动直接用来切字符串，差一个字符就是把 `]` 留在原地
  const text = "看这张 [Image #1] 和这段 [Pasted text #2 +147 chars] 谢谢"
  const markers = parseMarkers(text)
  assert.equal(markers.length, 2, `应当解析出 2 个标记，实际 ${markers.length} 个`)
  for (const marker of markers) {
    assert.equal(text.slice(marker.start, marker.end), marker.raw,
      `span [${marker.start}, ${marker.end}) 切出来的是 ${JSON.stringify(text.slice(marker.start, marker.end))}`)
  }
  assert.deepEqual(markers.map((m) => m.kind), [IMAGE_KIND, TEXT_KIND])
  assert.deepEqual(markers.map((m) => m.id), [1, 2])
})

test("markers are returned in the order they appear, duplicates included", () => {
  const markers = parseMarkers("[Image #2]x[Image #1]y[Image #2]")
  assert.deepEqual(markers.map((m) => m.id), [2, 1, 2],
    `顺序或重复丢了，实际是 ${JSON.stringify(markers.map((m) => m.id))}`)
})

test("parseMarkers is not affected by MARKER_PATTERN's lastIndex", () => {
  // 模块级的 /g 正则是有状态的。复用同一个实例去 exec，第二次调用会从上次停下的地方
  // 接着找 —— 表现是「第一次粘贴好好的，第二次标记就认不出来了」。
  const text = "[Image #1] 中间 [Image #2]"
  const first = parseMarkers(text)
  const second = parseMarkers(text)
  assert.deepEqual(second, first, "连续两次调用的结果必须一致")

  // 更狠一点：外部污染 lastIndex 之后也必须从头扫。这条能抓住「把 MARKER_PATTERN
  // 直接喂给 matchAll」的写法 —— matchAll 会沿用它的 lastIndex。
  MARKER_PATTERN.lastIndex = 12
  try {
    assert.deepEqual(parseMarkers(text), first, "lastIndex 被污染后仍须从位置 0 开始扫")
  } finally {
    MARKER_PATTERN.lastIndex = 0
  }
})

test("parsing is lexical only: unknown ids are still markers", () => {
  // 解析不查登记本。是不是真有这个附件由 resolve 决定 —— 让「未知 id 当普通文字」
  // 成为一个显式决定，而不是解析失败的副作用。
  const markers = parseMarkers("[Image #99]")
  assert.equal(markers.length, 1)
  assert.equal(markers[0].id, 99)
})

test("near-misses are not markers", () => {
  for (const text of ["[Image #]", "[image #1]", "[Image 1]", "[Images #1]", "[Pasted text #1]x", "[Pasted text #1 +chars]"]) {
    const markers = parseMarkers(text)
    const expected = text === "[Pasted text #1]x" ? 1 : 0
    assert.equal(markers.length, expected,
      `${JSON.stringify(text)} 解析出了 ${markers.length} 个标记，期望 ${expected}`)
  }
})

// --- markerSpanAt ---

test("markerSpanAt only fires at the marker's right edge", () => {
  // 退格键用它：光标停在 `]` 之后按退格要整块删掉，否则会留下 `[Image #1` 这种残骸 ——
  // 既不再匹配标记，用户也看不出刚才发生了什么。
  const text = "a[Image #1]b"
  const marker = parseMarkers(text)[0]
  const hit = markerSpanAt(text, marker.end)
  assert.ok(hit, `右端 index=${marker.end} 应当命中`)
  assert.equal(hit.raw, "[Image #1]")

  assert.equal(markerSpanAt(text, marker.start), null, "左端不命中 —— 那时用户的意图是往前删")
  assert.equal(markerSpanAt(text, marker.start + 3), null, "标记内部不命中")
  assert.equal(markerSpanAt(text, 0), null, "标记之外不命中")
  assert.equal(markerSpanAt(text, text.length), null, "标记右边还有字符时，末尾不命中")
})

test("markerSpanAt picks the marker that ends at the cursor, not the first one", () => {
  const text = "[Image #1][Image #2]"
  const second = parseMarkers(text)[1]
  const hit = markerSpanAt(text, second.end)
  assert.equal(hit && hit.id, 2, `应当命中第二个标记，实际命中 ${hit && hit.id}`)
  const firstHit = markerSpanAt(text, 10)
  assert.equal(firstHit && firstHit.id, 1, "第一个标记的右端仍要能命中")
})

test("markerSpanAt on text without markers is null", () => {
  assert.equal(markerSpanAt("just words", 4), null)
})

// --- add / 编号 ---

test("ids are monotonic and never reused", () => {
  // 回收编号 = 输入框里已经存在的 `[Image #1]` 某天会指向另一张图。这是「文本是唯一
  // 真相」这条设计里唯一需要登记本自己守住的东西。
  const store = createAttachmentStore()
  const a = store.add(IMG)
  const b = store.add({ kind: TEXT_KIND, text: "x\ny" })
  assert.equal(a.id, 1)
  assert.equal(b.id, 2)
  assert.equal(a.marker, "[Image #1]")
  assert.equal(b.marker, "[Pasted text #2 +3 chars]")

  // 用户把第一个标记删掉了 —— 也就是提交的文本里根本没提它
  const resolved = store.resolve(`只留 ${b.marker}`)
  assert.deepEqual(resolved.images, [], "没被引用的图片不该被发送")

  const c = store.add(IMG)
  assert.ok(c.id > b.id, `新条目的 id 是 ${c.id}，必须大于 ${b.id}`)
})

test("reset clears content but does not rewind the counter", () => {
  const store = createAttachmentStore()
  store.add(IMG)
  store.add(IMG)
  store.reset()
  assert.equal(store.size(), 0)
  const after = store.add(IMG)
  assert.ok(after.id > 2, `reset 之后的 id 是 ${after.id}，必须继续往上走`)
  assert.equal(store.get(1), undefined, "被清掉的条目取不到")
})

test("add reports size and get returns the stored entry", () => {
  const store = createAttachmentStore()
  const { id } = store.add({ kind: IMAGE_KIND, data: "ZZ", mediaType: "image/jpeg", path: "/tmp/a.jpg" })
  assert.equal(store.size(), 1)
  const entry = store.get(id)
  assert.equal(entry.data, "ZZ")
  assert.equal(entry.mediaType, "image/jpeg")
  assert.equal(entry.path, "/tmp/a.jpg")
})

// --- resolve ---

test("resolve keeps an image marker in place and attaches the image", () => {
  // 标记原样留在文本里，模型才知道 `#1` 指的是句子里的哪个位置、对应哪张图
  const store = createAttachmentStore()
  const { marker } = store.add(IMG)
  const { text, images, unresolved } = store.resolve(`这是 ${marker} 请看`)
  assert.equal(text, "这是 [Image #1] 请看", `文本被改了：${JSON.stringify(text)}`)
  assert.deepEqual(images, [{ type: "image", data: "AAAA", mediaType: "image/png" }])
  assert.deepEqual(unresolved, [])
})

test("path rides along only when the entry has one", () => {
  const store = createAttachmentStore()
  const withPath = store.add({ ...IMG, path: "/tmp/shot.png" })
  const noPath = store.add(IMG)
  const { images } = store.resolve(`${withPath.marker}${noPath.marker}`)
  assert.equal(images[0].path, "/tmp/shot.png")
  assert.ok(!("path" in images[1]), `没有路径的图片不该带 path 字段，实际 ${JSON.stringify(images[1])}`)
})

test("images come back in the order the markers appear, not the order they were added", () => {
  // 调换标记顺序 = 调换发送顺序。这正是「文本是唯一真相」要买到的东西。
  const store = createAttachmentStore()
  const one = store.add({ ...IMG, data: "ONE" })
  const two = store.add({ ...IMG, data: "TWO" })
  const { images } = store.resolve(`先 ${two.marker} 后 ${one.marker}`)
  assert.deepEqual(images.map((i) => i.data), ["TWO", "ONE"],
    `顺序应当跟着文本走，实际 ${JSON.stringify(images.map((i) => i.data))}`)
})

test("the same image referenced twice is attached twice", () => {
  // 复制粘贴一个标记 = 同一张图引用两次。不需要任何额外处理，自然成立。
  const store = createAttachmentStore()
  const { marker } = store.add(IMG)
  const { images, text } = store.resolve(`${marker} 对比 ${marker}`)
  assert.equal(images.length, 2, `应当附两次，实际 ${images.length} 次`)
  assert.equal(images[0].data, images[1].data)
  assert.equal(text, "[Image #1] 对比 [Image #1]")
})

test("a text attachment expands back into the original paste, verbatim", () => {
  // 折叠纯粹是显示层的事 —— 模型应当收到用户当初粘贴的原文，不加任何包裹
  const store = createAttachmentStore()
  const pasted = "line one\nline two\nline three"
  const { marker } = store.add({ kind: TEXT_KIND, text: pasted })
  const { text, images } = store.resolve(`看看这个：\n${marker}\n有什么问题`)
  assert.equal(text, `看看这个：\n${pasted}\n有什么问题`, `展开结果不对：${JSON.stringify(text)}`)
  assert.deepEqual(images, [], "文本附件不产生 image 块")
  assert.ok(!text.includes("Pasted text"), "标记本身不该留在发给模型的文本里")
})

test("interleaved text and markers keep their relative order", () => {
  const store = createAttachmentStore()
  const img = store.add(IMG)
  const snippet = store.add({ kind: TEXT_KIND, text: "const a = 1" })
  const { text, images } = store.resolve(`A${img.marker}B${snippet.marker}C`)
  assert.equal(text, "A[Image #1]Bconst a = 1C", `实际 ${JSON.stringify(text)}`)
  assert.equal(images.length, 1)
})

test("an unknown id stays as plain text and is reported", () => {
  // 用户手打 `[Image #99]` 就应该是一句普通话 —— 既不能抛错，也不能静默吞掉
  const store = createAttachmentStore()
  const { text, images, unresolved } = store.resolve("看 [Image #99] 这个")
  assert.equal(text, "看 [Image #99] 这个", `未知标记应当原样留下，实际 ${JSON.stringify(text)}`)
  assert.deepEqual(images, [])
  assert.deepEqual(unresolved, ["[Image #99]"])
})

test("a marker whose kind disagrees with the stored entry is unresolved", () => {
  // id 1 存的是文本，用户却打了 `[Image #1]` —— 这不是那个附件，按未知处理
  const store = createAttachmentStore()
  store.add({ kind: TEXT_KIND, text: "hello" })
  const { text, images, unresolved } = store.resolve("[Image #1]")
  assert.equal(text, "[Image #1]")
  assert.deepEqual(images, [])
  assert.deepEqual(unresolved, ["[Image #1]"], `kind 不匹配时应当进 unresolved，实际 ${JSON.stringify(unresolved)}`)
})

test("text without markers passes through untouched", () => {
  // 绝大多数回合不带附件，走的必须是零开销路径：一个字符都不能改。
  // 注意 CRLF —— resolve 不是「顺手归一行尾」的地方，用户输入什么就发什么。
  const store = createAttachmentStore()
  store.add(IMG)
  for (const plain of ["普通的一句话", "line1\r\nline2", "", "[not a marker]"]) {
    const result = store.resolve(plain)
    assert.equal(result.text, plain, `文本被改动了：${JSON.stringify(result.text)}`)
    assert.deepEqual(result.images, [], "没有标记就没有附件")
    assert.deepEqual(result.unresolved, [])
  }
})

test("resolved image blocks are copies, not the registry's own objects", () => {
  // 下游会往内容块上挂东西（cache_control、序号…）。交出内部对象的话，改一下就把
  // 登记本污染了，而且要等到第二次引用同一张图才会暴露。
  const store = createAttachmentStore()
  const { id, marker } = store.add(IMG)
  const first = store.resolve(marker).images[0]
  assert.notEqual(first, store.get(id), "交出去的必须是新对象")
  first.data = "TAMPERED"
  first.extra = true
  const second = store.resolve(marker).images[0]
  assert.equal(second.data, "AAAA", `登记本被污染了，第二次拿到 ${second.data}`)
  assert.ok(!("extra" in second), "下游加的字段不该渗回登记本")
  assert.equal(store.get(id).data, "AAAA")
})

test("two references to one image are two distinct objects", () => {
  const store = createAttachmentStore()
  const { marker } = store.add(IMG)
  const { images } = store.resolve(`${marker}${marker}`)
  assert.notEqual(images[0], images[1], "同一张图的两次引用不能共享同一个对象")
})

// --- 淘汰 ---

test("ids keep climbing after an eviction, so a stale marker never points at a new image", () => {
  // 这是编号回收最真实的入口：淘汰之后 size 变小了，拿 size 推下一个编号就会撞上还
  // 活着的条目 —— 输入框里那个 `[Image #3]` 会悄悄变成另一张图。
  const store = createAttachmentStore({ maxEntries: 2 })
  store.add({ ...IMG, data: "A" })
  store.add({ ...IMG, data: "B" })
  const c = store.add({ ...IMG, data: "C" })
  const d = store.add({ ...IMG, data: "D" })
  assert.ok(d.id > c.id, `淘汰后分配的 id 是 ${d.id}，必须大于 ${c.id}`)
  assert.equal(store.resolve(c.marker).images[0].data, "C",
    `${c.marker} 指向的图被换掉了：${JSON.stringify(store.resolve(c.marker).images[0])}`)
})

test("the oldest entry is evicted past maxEntries and its marker degrades gracefully", () => {
  // 淘汰不能变成崩溃：输入框里可能还留着那个标记，它应当退化成普通文字
  const store = createAttachmentStore({ maxEntries: 2 })
  const a = store.add({ ...IMG, data: "A" })
  const b = store.add({ ...IMG, data: "B" })
  const c = store.add({ ...IMG, data: "C" })
  assert.equal(store.size(), 2, `容量应当是 2，实际 ${store.size()}`)
  assert.equal(store.get(a.id), undefined, "最早的条目应当被淘汰")

  const { images, unresolved, text } = store.resolve(`${a.marker}${b.marker}${c.marker}`)
  assert.deepEqual(images.map((i) => i.data), ["B", "C"], `实际 ${JSON.stringify(images.map((i) => i.data))}`)
  assert.deepEqual(unresolved, [a.marker], `被淘汰的标记应当进 unresolved，实际 ${JSON.stringify(unresolved)}`)
  assert.ok(text.startsWith(a.marker), "被淘汰的标记仍原样留在文本里")
})

// --- referencedIds ---

test("referencedIds lists resolvable ids in order, deduped", () => {
  const store = createAttachmentStore()
  const a = store.add(IMG)
  const b = store.add(IMG)
  assert.deepEqual(store.referencedIds(`${b.marker}x${a.marker}y${b.marker}`), [b.id, a.id])
  assert.deepEqual(store.referencedIds("没有标记"), [])
  assert.deepEqual(store.referencedIds("[Image #99]"), [], "登记本里没有的 id 不算被引用")
  assert.deepEqual(store.referencedIds(a.marker), [a.id])
})

// --- 行尾 ---

test("line counts are identical across LF, CRLF and CR", () => {
  // 这条在 Linux 上也会红。0.6.27 的结构守卫就是因为按 `\n` 切 CRLF 文本而在 Windows
  // 上全红、Linux 全绿 —— 那次是等 CI 告诉我们的，这次不等。
  const sample = "alpha\nbeta\ngamma"
  const counts = [sample, withCRLF(sample), withCR(sample)].map((text) => {
    const store = createAttachmentStore()
    const { id } = store.add({ kind: TEXT_KIND, text })
    return store.get(id).lines
  })
  assert.deepEqual(counts, [3, 3, 3], `三种行尾数出了 ${JSON.stringify(counts)}`)
})

test("the marker's char count follows the same normalization", () => {
  const store = createAttachmentStore()
  const crlf = store.add({ kind: TEXT_KIND, text: withCRLF("a\nb\nc\nd") })
  assert.equal(crlf.marker, "[Pasted text #1 +7 chars]", `实际 ${crlf.marker}`)
  const single = store.add({ kind: TEXT_KIND, text: "只有一行" })
  assert.equal(single.marker, "[Pasted text #2 +4 chars]", `实际 ${single.marker}`)
})

test("stored text is normalized to LF, because the input box is LF", () => {
  // 存 CRLF 的话，展开之后发出去的文本里会混进 `\r`，而输入框其余部分是 `\n`
  const store = createAttachmentStore()
  const { id, marker } = store.add({ kind: TEXT_KIND, text: withCRLF("one\ntwo") })
  assert.equal(store.get(id).text, "one\ntwo", `存的原文是 ${JSON.stringify(store.get(id).text)}`)
  const { text } = store.resolve(marker)
  assert.ok(!text.includes("\r"), `展开的文本里混进了 CR：${JSON.stringify(text)}`)
  assert.equal(text, "one\ntwo")
})

test("blank lines survive normalization", () => {
  // 数行时把空行吞掉的话，行数会比用户看到的少
  assert.deepEqual(normalizeNewlines("a\r\n\r\nb"), "a\n\nb")
  assert.equal(countTextLines("a\r\n\r\nb"), 3, `实际 ${countTextLines("a\r\n\r\nb")}`)
  assert.equal(countTextLines("单行"), 1)
  assert.equal(countTextLines("trailing\n"), 2, "结尾换行意味着还有一个空行")
})

// --- 入参校验 ---

test("add rejects malformed entries with a message that says what is missing", () => {
  const store = createAttachmentStore()
  const cases = [
    [undefined, /kind/],
    [{}, /kind/],
    [{ kind: "video", data: "x" }, /kind/],
    [{ kind: IMAGE_KIND }, /data/],
    [{ kind: IMAGE_KIND, data: "" }, /data/],
    [{ kind: IMAGE_KIND, data: 123 }, /data/],
    [{ kind: TEXT_KIND }, /text/],
    [{ kind: TEXT_KIND, text: "" }, /text/],
    [{ kind: TEXT_KIND, text: ["a"] }, /text/]
  ]
  for (const [entry, message] of cases) {
    assert.throws(() => store.add(entry), (error) => {
      assert.ok(error instanceof TypeError, `${JSON.stringify(entry)} 抛的不是 TypeError：${error}`)
      assert.match(error.message, message, `${JSON.stringify(entry)} 的报错没说清缺了什么：${error.message}`)
      return true
    })
  }
  assert.equal(store.size(), 0, "被拒绝的条目不该进登记本")
})

test("a rejected add does not burn an id", () => {
  // 校验失败发生在分配编号之前 —— 否则编号会因为几次手滑而跳号，标记看起来像丢了东西
  const store = createAttachmentStore()
  assert.throws(() => store.add({ kind: IMAGE_KIND }))
  assert.equal(store.add(IMG).id, 1, "第一个成功的条目仍应当是 #1")
})
