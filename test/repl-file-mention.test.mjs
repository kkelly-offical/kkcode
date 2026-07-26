import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import realFs from "node:fs"
import { fileURLToPath } from "node:url"
import {
  scanMentions,
  mentionQueryAt,
  formatMentionPath,
  applyMention,
  expandFileMentions,
  createFileIndex,
  createIgnoreMatcher,
  rankCandidates
} from "../src/repl/file-mention.mjs"
import { extractImageRefs } from "../src/tool/image-util.mjs"

/**
 * `@` 引用任意文件。
 *
 * 这个特性最大的风险不是它自己不工作，而是**它把既有的 `@图片路径` 链路撞坏**：在此之前
 * `@` 在本项目里只有「图片附件」一个语义（`extractImageRefs`）。所以下面有一条专门的回归
 * 网 —— 展开之后 `extractImageRefs` 必须仍然认得出那张图。
 *
 * 第二大的风险是 Windows。相对路径一律 `/` 分隔这条不变量，靠的是「喂 `path.win32` +
 * 反斜杠形态的假 fs」的那条测试，它**在 Linux 上也会红**（本项目已经在 Windows/POSIX
 * 分歧上栽过五次，每次都是等 Windows 用户报上来才知道）。
 *
 * ## 假 fs 与 pathApi 是一对，必须一起注入
 *
 * 这是 0.7.1 在 Windows 上红 17 条的原因，也是这个文件唯一需要提前知道的规矩。
 *
 * 假 fs 的键是 POSIX 形态；而 `pathApi` **不注入**时取的是 `node:path` 的平台默认值 ——
 * 在 Windows 上那就是 `path.win32`。于是 `pathApi.join("/proj", "src")` 给出 `\proj\src`，
 * 假 fs 一个键都查不到：索引空掉、展开全判 missing，一连串断言跟着倒。
 *
 * **注入了一半比完全没注入更危险。** 上一段写着「靠喂 `path.win32` 守住 Windows」，
 * win32 那一侧确实有覆盖，于是这件事看起来已经处理过了；真正漏的是 POSIX 这一侧 ——
 * 那些用例只注入了 fs，宿主是什么形态它们就是什么形态，等于把「跑在哪个平台」写进了
 * 断言。有注入口而不用，比没有注入口更难发现。
 *
 * 所以 `fakeWorkspace()` 返回的是 `{ cwd, fs, pathApi }` 三件套，调用方一律 `{ ...ws }`
 * 摊开 —— 结构上就没有「只注入 fs」这个选项。两条真实 fs 的冒烟是仅有的例外，它们用
 * 宿主的 fs，就必须配宿主的 path，那里显式写出 `pathApi: path` 表明是故意的。
 *
 * 复核办法：把 `file-index.mjs` / `file-mention.mjs` 里 `pathApi` 的默认值临时改成
 * `nodePath.win32`（Windows 上的真实情形），整个文件必须仍然全绿。
 *
 * 索引与展开一律用注入的假 fs，不依赖真实仓库的文件布局 —— 那样测试会随仓库改动而漂。
 * 末尾留两条真实 fs 的冒烟，确保接口和 node:fs 真的对得上。
 */

// --- 假文件系统 ---

/**
 * 一个假工作区：`{ cwd, fs, pathApi }`。三件套一起给，调用方 `{ ...ws }` 摊开即可。
 *
 * 为什么是三件套而不是只给 fs，见文件头「假 fs 与 pathApi 是一对」。简单说：假 fs 的
 * 键是 POSIX 形态，`pathApi` 漏注入时会取到宿主的平台默认值，Windows 上一个键都查不到。
 *
 * fs 部分是最小可用的 `{ readdirSync, statSync, readFileSync, existsSync }`：
 *
 * - `sep` / `root`：设成 Windows 形态就能复现「路径分隔符」那类分歧。`pathApi` 跟着
 *   `sep` 走 —— 反斜杠形态的假 fs 配 `path.win32`，正斜杠形态配 `path.posix`。
 * - `dirents: false`（默认）：readdirSync 忽略 withFileTypes 只给名字，逼实现走 stat 回退 ——
 *   真实世界里的老实现与各种 fs 垫片就是这么表现的。
 * - `links: { linked: "" }`：`linked` 是一个指向 `""`（根）的符号链接。**statSync 会跟随它**
 *   （真实 fs 就是这个语义），lstatSync 不会。用来造真正的环。
 * - `lstat: false`：不提供 lstatSync，模拟只有 statSync 的实现 —— 那时链接看起来就是普通目录。
 */
function fakeWorkspace({
  files = {},
  root = "/proj",
  sep = "/",
  unreadable = [],
  links = {},
  dirents = false,
  lstat = true
} = {}) {
  const fileKeys = new Set(Object.keys(files))
  const dirKeys = new Set([""])
  for (const key of fileKeys) {
    const parts = key.split("/")
    for (let i = 1; i < parts.length; i++) dirKeys.add(parts.slice(0, i).join("/"))
  }
  const unreadableSet = new Set(unreadable)
  const calls = { readdir: 0, readFile: 0 }
  const inodes = new Map()
  const inoOf = (key) => {
    if (!inodes.has(key)) inodes.set(key, inodes.size + 1)
    return inodes.get(key)
  }

  const rel = (abs) => {
    const text = String(abs)
    const stripped = text.startsWith(root) ? text.slice(root.length) : text
    return stripped.split(sep).filter(Boolean).join("/")
  }
  /** 跟随路径上的每一段链接 —— statSync / readdirSync 的语义。 */
  const follow = (key) => {
    let acc = ""
    for (const part of key ? key.split("/") : []) {
      acc = acc ? `${acc}/${part}` : part
      if (Object.hasOwn(links, acc)) acc = links[acc]
    }
    return acc
  }
  const kindOf = (key) => {
    if (Object.hasOwn(links, key)) return "symlink"
    if (fileKeys.has(key)) return "file"
    if (dirKeys.has(key)) return "dir"
    return null
  }
  const childrenOf = (dir) => {
    const prefix = dir ? `${dir}/` : ""
    const names = new Set()
    for (const key of [...fileKeys, ...dirKeys, ...Object.keys(links)]) {
      if (!key || !key.startsWith(prefix)) continue
      const remainder = key.slice(prefix.length)
      if (remainder) names.add(remainder.split("/")[0])
    }
    return [...names].sort()
  }
  const fail = (code, target) => {
    const err = new Error(`${code}: ${target}`)
    err.code = code
    throw err
  }
  const statFor = (key) => {
    const kind = kindOf(key)
    if (!kind) fail("ENOENT", key)
    const isDir = kind !== "file"
    return {
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isSymbolicLink: () => false,
      dev: 1,
      ino: inoOf(key),
      size: isDir ? 0 : Buffer.byteLength(files[key] ?? "")
    }
  }

  const fake = {
    calls,
    readdirSync(dir, options) {
      calls.readdir++
      const key = follow(rel(dir))
      if (unreadableSet.has(key)) fail("EACCES", key)
      if (!dirKeys.has(key)) fail("ENOTDIR", key)
      const names = childrenOf(key)
      if (!dirents || !options?.withFileTypes) return names
      return names.map((name) => {
        const kind = kindOf(key ? `${key}/${name}` : name)
        return {
          name,
          isDirectory: () => kind === "dir",
          isFile: () => kind === "file",
          isSymbolicLink: () => kind === "symlink"
        }
      })
    },
    // statSync 跟随链接，lstatSync 不跟随 —— 这一条差别就是「会不会转出环来」的分水岭
    statSync: (target) => statFor(follow(rel(target))),
    existsSync: (target) => kindOf(follow(rel(target))) !== null,
    readFileSync(target, encoding) {
      calls.readFile++
      const key = follow(rel(target))
      if (!fileKeys.has(key)) fail("ENOENT", key)
      const content = files[key]
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8")
      return encoding ? buffer.toString(encoding) : buffer
    }
  }
  if (lstat) {
    fake.lstatSync = (target) => {
      const key = rel(target)
      if (Object.hasOwn(links, key)) {
        return { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true, dev: 1, ino: inoOf(key) }
      }
      return statFor(key)
    }
  }
  // pathApi 跟着 sep 走。这个绑定就是「一对」的落点 —— 假 fs 认什么分隔符，
  // 路径运算就得用什么分隔符，两者对不上的话假数据根本查不到。
  return { cwd: root, fs: fake, pathApi: sep === "\\" ? path.win32 : path.posix }
}

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1

// --- 1. 词法：mentionQueryAt ---

test("刚敲下 @ 就该有一个空 query，而不是 null", () => {
  // 空 query 是合法状态：菜单此时要列出前 N 个文件。返回 null 的话用户会以为补全没生效
  assert.deepEqual(mentionQueryAt("@", 1), { query: "", start: 0, end: 1 })
  assert.deepEqual(mentionQueryAt("write @", 7), { query: "", start: 6, end: 7 })
})

test("光标在 token 内部与右端都命中，在 @ 左侧不命中", () => {
  const text = "see @src/repl.mjs now"
  assert.equal(mentionQueryAt(text, 4), null, "光标停在 @ 之前时用户还没开始写这个引用")
  // query 始终是**整个 token** 的载荷，与光标在 token 内的哪一格无关 —— 因为
  // applyMention 替换的也是整个 token，两者必须看同一个东西
  assert.equal(mentionQueryAt(text, 5).query, "src/repl.mjs")
  assert.equal(mentionQueryAt(text, 8).query, "src/repl.mjs")
  const atEnd = mentionQueryAt(text, 17)
  assert.deepEqual(atEnd, { query: "src/repl.mjs", start: 4, end: 17 })
  assert.equal(text.slice(atEnd.start, atEnd.end), "@src/repl.mjs", "start/end 必须框住 token 原文")
  assert.equal(mentionQueryAt(text, 18), null, "光标越过 token 后的空格就不再是它")
})

test("a@b 不是 mention —— 否则每个邮箱都会触发一次文件查找", () => {
  assert.equal(mentionQueryAt("mail foo@bar.com", 12), null)
  assert.equal(mentionQueryAt("mail foo@bar.com", 16), null)
  assert.deepEqual(scanMentions("mail foo@bar.com"), [])
})

test("引号包裹的路径能整段读出来（终端拖拽含空格的文件就是这个形态）", () => {
  const text = 'open @"my docs/a b.ts" ok'
  assert.deepEqual(mentionQueryAt(text, 21), { query: "my docs/a b.ts", start: 5, end: 22 })
  assert.equal(text.slice(5, 22), '@"my docs/a b.ts"')
})

test("未闭合的引号也要能补全 —— 正在打字的中途本来就是未闭合的", () => {
  const hit = mentionQueryAt('open @"my doc', 13)
  assert.deepEqual(hit, { query: "my doc", start: 5, end: 13 })
})

test("反斜杠转义的空格属于同一个 token（shell 补全给的就是这个形态）", () => {
  const text = "open @my\\ docs/a\\ b.ts done"
  const hit = mentionQueryAt(text, 22)
  assert.equal(hit.query, "my docs/a b.ts", "转义空格要还原成真空格，否则拿去匹配索引匹配不上")
  assert.equal(text.slice(hit.start, hit.end), "@my\\ docs/a\\ b.ts")
})

test("一行里有多个 mention 时命中光标所在的那个", () => {
  const text = "@aaa @bbb"
  assert.equal(mentionQueryAt(text, 4).query, "aaa")
  assert.equal(mentionQueryAt(text, 9).query, "bbb")
  assert.equal(mentionQueryAt(text, 5), null, "光标停在第二个 @ 左侧：两个 token 都不该命中")
  assert.equal(mentionQueryAt(text, 6).query, "bbb")
})

test("换行后的行首也是词边界", () => {
  const hit = mentionQueryAt("first line\n@src/a.ts", 20)
  assert.deepEqual(hit, { query: "src/a.ts", start: 11, end: 20 })
})

// --- 2. 索引 ---

test("默认忽略清单生效", () => {
  const ws = fakeWorkspace({
    files: {
      "a.txt": "", "src/keep.ts": "",
      "node_modules/pkg/index.js": "", ".git/config": "", "dist/bundle.js": "", "target/out.rs": ""
    }
  })
  const index = createFileIndex({ ...ws })
  assert.deepEqual(index.list(), ["a.txt", "src/keep.ts"])
})

test(".gitignore 生效：前导 / 锚定、尾部 / 限目录、! 反选", () => {
  const ws = fakeWorkspace({
    files: {
      ".gitignore": "# 注释\n\n*.log\n!keep.log\n/root-only.txt\nsub/nested/\n",
      "a.log": "", "keep.log": "",
      "root-only.txt": "", "sub/root-only.txt": "",
      "sub/nested/deep.txt": "", "sub/keep.txt": ""
    }
  })
  const index = createFileIndex({ ...ws })
  assert.deepEqual(index.list(), [".gitignore", "keep.log", "sub/keep.txt", "sub/root-only.txt"])
})

test("认不出的 .gitignore 模式跳过而不是崩", () => {
  // `[z-a]` 是一个字符类里的倒序区间，翻成正则会真的抛 SyntaxError。
  // 一份写坏的 .gitignore 不该让整个补全失灵，所以这条模式要被丢掉、其余照常生效。
  assert.throws(() => new RegExp("[z-a]"), SyntaxError, "锚点失效了：这个模式已经不会抛了")
  const isIgnored = createIgnoreMatcher({ names: [], gitignore: "bad[z-a].txt\n**/ok/\n" })
  assert.equal(isIgnored("ok", true), true)
  assert.equal(isIgnored("a/ok", true), true)
  assert.equal(isIgnored("normal.ts", false), false)

  const ws = fakeWorkspace({ files: { ".gitignore": "bad[z-a].txt\n", "keep.ts": "" } })
  assert.deepEqual(createFileIndex({ ...ws }).list(), [".gitignore", "keep.ts"])
})

test("maxFiles 封顶时 stats().truncated 为真 —— 悄悄封顶会让人以为仓库里没这个文件", () => {
  const files = {}
  for (let i = 0; i < 10; i++) files[`f${i}.txt`] = ""
  const ws = fakeWorkspace({ files })
  const capped = createFileIndex({ ...ws, maxFiles: 4 })
  assert.equal(capped.list().length, 4)
  assert.equal(capped.stats().truncated, true)
  assert.equal(capped.stats().files, 4)

  const full = createFileIndex({ ...fakeWorkspace({ files }), maxFiles: 50 })
  assert.equal(full.list().length, 10)
  assert.equal(full.stats().truncated, false, "没到顶就不该标 truncated，否则这个标记等于没有")
})

test("读不了的目录跳过而不是让整份索引失败", () => {
  const ws = fakeWorkspace({
    files: { "ok.txt": "", "locked/secret.txt": "", "other/fine.txt": "" },
    unreadable: ["locked"]
  })
  const index = createFileIndex({ ...ws })
  assert.deepEqual(index.list(), ["ok.txt", "other/fine.txt"])
  assert.equal(index.stats().unreadable, 1, "跳过了要计数，否则「少了个文件」查不出原因")
})

test("符号链接不进清单（Dirent 形态：它既不是文件也不是目录）", () => {
  const ws = fakeWorkspace({ files: { "a.txt": "" }, links: { linked: "" }, dirents: true })
  const index = createFileIndex({ ...ws })
  assert.deepEqual(index.list(), ["a.txt"])
  assert.equal(ws.fs.calls.readdir, 1, "只该读根目录一层；读了第二层说明钻进链接里去了")
})

test("指向被忽略目录的链接不会把 node_modules 从后门放进来", () => {
  // pnpm / npm workspace 会造出一堆指向 node_modules 里面的链接。dev:ino 去重挡不住这种
  // ——那棵子树本来就被忽略、从没访问过、也就没有身份记录。挡住它的是「用 lstat 而不是
  // 会跟随链接的 stat」。换成 stat 的话，下面会索引出 shortcut/index.js。
  const ws = fakeWorkspace({
    files: { "a.txt": "", "node_modules/pkg/index.js": "" },
    links: { shortcut: "node_modules/pkg" }
  })
  assert.deepEqual(createFileIndex({ ...ws }).list(), ["a.txt"])
})

test("只有 statSync 的 fs 上，指回祖先的链接不会让遍历转出一棵假树", () => {
  // 这条才是真正扛环的那一条。statSync **跟随**链接，所以 `linked` 在它眼里就是一个普通
  // 目录 —— 光靠「跳过符号链接」挡不住，靠的是 dev:ino 去重。少了那道守卫的话，下面会
  // 索引出 linked/a.txt、linked/linked/a.txt … 一路到深度上限。
  const ws = fakeWorkspace({
    files: { "a.txt": "", "sub/b.txt": "" },
    links: { linked: "" },
    lstat: false
  })
  const index = createFileIndex({ ...ws })
  assert.deepEqual(index.list(), ["a.txt", "sub/b.txt"])
  assert.equal(index.stats().dirs, 2, "走过的目录数应当是「根 + sub」，多出来的就是转环转出来的")
})

test("懒构建 + 可失效：按键路径上不许走盘", () => {
  const ws = fakeWorkspace({ files: { "a.txt": "", "src/b.ts": "" } })
  const index = createFileIndex({ ...ws })
  assert.equal(ws.fs.calls.readdir, 0, "还没 list() 就走盘了 —— 建索引必须是懒的")
  index.list()
  const afterFirst = ws.fs.calls.readdir
  assert.ok(afterFirst > 0)
  index.list()
  index.list()
  assert.equal(ws.fs.calls.readdir, afterFirst, "第二次 list() 又走了盘：缓存没生效，逐键补全会卡死")
  index.refresh()
  assert.ok(ws.fs.calls.readdir > afterFirst, "refresh() 必须真的重建")
})

test("Windows 形态的 fs 也必须吐出 / 分隔的相对路径", () => {
  // 这条在 Linux 上也会红：喂 path.win32 时若用 pathApi.join 拼相对路径就会得到 `\`。
  // 排序、高亮偏移、写回输入框、注入给模型的 path 属性四处都用它做主键，变形一处就全歪。
  // 假 fs 的键仍用 / 表达层级，但它收到的绝对路径与认的分隔符都是 Windows 形态
  const winWs = fakeWorkspace({
    files: { "src/foo.ts": "", "src/deep/bar.ts": "", "top.md": "" },
    root: "C:\\proj",
    sep: "\\"
  })
  assert.equal(winWs.pathApi, path.win32, "前提没成立：反斜杠形态的假 fs 必须配 path.win32")
  const index = createFileIndex({ ...winWs })
  const listed = index.list()
  assert.deepEqual(listed, ["src/deep/bar.ts", "src/foo.ts", "top.md"])
  for (const item of listed) {
    assert.ok(!item.includes("\\"), `${item} 里还有反斜杠`)
  }
})

// --- 3. 排序 ---

test("完整路径前缀压过文件名前缀，哪怕它又长又深", () => {
  // 档间距必须跨不过去：一个连续加权的打分函数总能被某个够短的路径翻盘
  const files = ["srcaaaaaaaaaaaaaaaaaaaa/deep/nested/file.ts", "x/src.ts"]
  const ranked = rankCandidates(files, "src")
  assert.equal(ranked[0].path, "srcaaaaaaaaaaaaaaaaaaaa/deep/nested/file.ts")
  assert.equal(ranked[1].path, "x/src.ts")
})

test("文件名前缀 > 文件名子串 > 路径子序列", () => {
  const ranked = rankCandidates(["util/backlog.mjs", "util/logger.mjs", "l/o/g.ts"], "log")
  assert.deepEqual(ranked.map((item) => item.path), ["util/logger.mjs", "util/backlog.mjs", "l/o/g.ts"])
})

test("同一档里短路径优先", () => {
  const ranked = rankCandidates(["deep/deeper/deepest/foo.ts", "a/foo.ts"], "foo")
  assert.deepEqual(ranked.map((item) => item.path), ["a/foo.ts", "deep/deeper/deepest/foo.ts"])

  // 层级、命中位置全都一样，**只有长度**不同；而且短的那条字典序更大，
  // 所以这一条只能由长度本身分胜负，兜底的字典序帮不上忙
  const sameDepth = rankCandidates(["a/fooaaaaaaaa.ts", "a/foozz.ts"], "foo")
  assert.deepEqual(sameDepth.map((item) => item.path), ["a/foozz.ts", "a/fooaaaaaaaa.ts"])
})

test("分数完全相同时按字典序，输出不随入参顺序漂", () => {
  // 补全菜单每次按键都重排一次，顺序飘的话选中项会在眼皮底下跳
  const tied = ["a/yfoo.ts", "a/xfoo.ts"]
  const ranked = rankCandidates(tied, "foo")
  assert.equal(ranked[0].score, ranked[1].score, "前提没成立：这两条必须真的同分")
  assert.deepEqual(ranked.map((item) => item.path), ["a/xfoo.ts", "a/yfoo.ts"])
})

test("长度一样时层级浅的优先", () => {
  // 两条路径等长、命中位置也一样，只有层级不同 —— 唯一能分出胜负的是层级惩罚
  const ranked = rankCandidates(["aa/bb/foo.ts", "aaaaa/foo.ts"], "foo")
  assert.deepEqual(ranked.map((item) => item.path), ["aaaaa/foo.ts", "aa/bb/foo.ts"])
  assert.equal(ranked[0].path.length, ranked[1].path.length, "前提没成立：这两条路径必须等长")
})

test("matched 区间对着的是 path 的索引，不是文件名的", () => {
  // 高亮偏移错位是那种「看着能用、其实一直歪着」的缺陷，所以这里逐字回切
  const [hit] = rankCandidates(["src/ReplRouter.mjs"], "Repl")
  assert.deepEqual(hit.matched, [[4, 8]])
  assert.equal(hit.path.slice(4, 8), "Repl", "区间切出来的不是查询串本身")
})

test("大小写不敏感，但区间仍对着原始大小写的 path", () => {
  const [hit] = rankCandidates(["src/ReplRouter.mjs"], "replrouter")
  assert.equal(hit.path.slice(hit.matched[0][0], hit.matched[0][1]), "ReplRouter")
})

test("子序列命中的区间拼起来就是查询串", () => {
  const [hit] = rankCandidates(["src/repl/file-index.mjs"], "srfidx")
  assert.ok(hit, "srfidx 应当能子序列命中 src/repl/file-index.mjs")
  const pieces = hit.matched.map(([start, end]) => hit.path.slice(start, end)).join("")
  assert.equal(pieces.toLowerCase(), "srfidx")
  for (const [start, end] of hit.matched) {
    assert.ok(start >= 0 && end <= hit.path.length && start < end, `区间 ${start},${end} 越界`)
  }
})

test("空 query 返回前 limit 个并按路径排序，而不是空清单", () => {
  const ranked = rankCandidates(["z.ts", "a.ts", "m/b.ts"], "", { limit: 2 })
  assert.deepEqual(ranked.map((item) => item.path), ["a.ts", "m/b.ts"])
  assert.deepEqual(ranked[0].matched, [])
})

test("匹配不上就返回空，limit 生效", () => {
  assert.deepEqual(rankCandidates(["a.ts", "b.ts"], "zzz"), [])
  assert.equal(rankCandidates(["ax.ts", "ay.ts", "az.ts"], "a", { limit: 2 }).length, 2)
})

// --- 4. 写回输入 ---

test("补全替换的是整个 token，不是往后追加", () => {
  const out = applyMention("look at @rep here", 12, "src/repl.mjs")
  assert.equal(out.text, "look at @src/repl.mjs here")
  assert.equal(out.cursor, 22)
  assert.equal(out.text.slice(0, out.cursor), "look at @src/repl.mjs ")
})

test("句尾补全会补一个空格，光标落在它之后", () => {
  const out = applyMention("see @rep", 8, "src/repl.mjs")
  assert.equal(out.text, "see @src/repl.mjs ")
  assert.equal(out.cursor, out.text.length)
})

test("后面已经有空白就不再补一个", () => {
  const out = applyMention("@a next", 2, "b.ts")
  assert.equal(out.text, "@b.ts next", "多补一个空格的话，每次补全都会长出一串空格")
  assert.equal(out.cursor, 6)
  const atLineEnd = applyMention("@a\nnext", 2, "b.ts")
  assert.equal(atLineEnd.text, "@b.ts\nnext", "行尾不补空格，否则每次补全都在行末留个看不见的尾巴")
  assert.equal(atLineEnd.cursor, 5)
})

test("含空格的路径写回时加引号，并且能被读回来", () => {
  const out = applyMention("@my", 3, "my docs/a b.ts")
  assert.equal(out.text, '@"my docs/a b.ts" ')
  const back = mentionQueryAt(out.text, out.cursor - 1)
  assert.equal(back.query, "my docs/a b.ts", "格式化与解析必须互为逆运算")
})

test("路径里带引号时改用转义空格 —— 引号包不住它", () => {
  const weird = 'a "q" b.ts'
  assert.equal(formatMentionPath(weird), 'a\\ "q"\\ b.ts')
  const out = applyMention("@x", 2, weird)
  assert.equal(mentionQueryAt(out.text, out.cursor - 1).query, weird)
})

test("光标不在 mention 上时原样返回", () => {
  const out = applyMention("hello world", 3, "x.ts")
  assert.equal(out.text, "hello world")
  assert.equal(out.cursor, 3)
})

// --- 5. 提交时展开 ---

const SAMPLE_FILES = {
  "src/foo.ts": "export const foo = 1\n",
  "src/bar.ts": "export const bar = 2\n",
  "shot.png": "\u0089PNG fake",
  "notes/a.md": "a",
  "notes/b.md": "b",
  "notes/sub/c.md": "c",
  "data.bin": "not really binary but the extension says so",
  "weird.txt": "before\u0000after"
}

const expandWith = (text, options = {}) => expandFileMentions(text, {
  ...fakeWorkspace({ files: SAMPLE_FILES, dirents: true }),
  ...options
})

test("普通文件的内容追加在消息末尾，原句一个字不改", () => {
  return expandWith("please read @src/foo.ts carefully").then((out) => {
    assert.ok(out.text.startsWith("please read @src/foo.ts carefully"),
      "原句被改动了：模型将无法把引用块和句子里的位置对上")
    assert.ok(out.text.includes('<file path="src/foo.ts">\nexport const foo = 1\n\n</file>'))
    assert.deepEqual(out.attached, [{ path: "src/foo.ts", kind: "file", bytes: 21, truncated: false }])
    assert.deepEqual(out.missing, [])
    assert.deepEqual(out.skipped, [])
  })
})

test("图片扩展名一律不碰 —— 那条链路归 extractImageRefs 管（回归网）", async () => {
  const input = "compare @shot.png with @src/foo.ts"
  const out = await expandWith(input)
  assert.deepEqual(out.attached.map((item) => item.path), ["src/foo.ts"],
    "图片被当成普通文件注入了，它会被读成一堆二进制或者重复附件")
  assert.deepEqual(out.skipped, [])
  assert.deepEqual(out.missing, [], "图片不该出现在 missing 里 —— 它压根不属于这条链路")
  assert.ok(out.text.includes("@shot.png"), "@shot.png 必须原样留着")

  // 真正的回归网：展开之后，既有的图片管线仍然认得出这张图
  const refs = extractImageRefs(out.text, "/proj")
  assert.deepEqual(refs.imagePaths, [path.resolve("/proj", "shot.png")])
})

test("URL 被跳过", async () => {
  const out = await expandWith("see @https://example.com/a.ts and @src/foo.ts")
  assert.deepEqual(out.attached.map((item) => item.path), ["src/foo.ts"])
  assert.deepEqual(out.missing, [], "URL 不是「不存在的文件」，不该进 missing")
})

test("不存在的路径进 missing，文本原样保留", async () => {
  const input = "we should create @src/new-thing.ts today"
  const out = await expandWith(input)
  assert.equal(out.text, input, "用户可能就是在说一个还不存在的文件，改动原文会让他看不懂")
  assert.deepEqual(out.missing, [{ path: "src/new-thing.ts", ref: "src/new-thing.ts" }])
  assert.deepEqual(out.attached, [])
})

test("目录注入的是一层列表，不是里面每个文件的内容", async () => {
  const out = await expandWith("look at @notes")
  assert.ok(out.text.includes('<dir path="notes" entries="3">'), "目录块的头不对")
  assert.ok(out.text.includes("\na.md\n") && out.text.includes("\nb.md\n"))
  assert.ok(out.text.includes("\nsub/\n"), "子目录要带一个尾斜杠，否则看不出它是目录")
  assert.ok(!out.text.includes("sub/c.md"), "只列一层，不该递归 —— 递归下去一个 src/ 就能吃光上下文")
  assert.ok(!out.text.includes("\na\n"), "列的是条目名，不该把文件内容也读进来")
  assert.equal(out.attached[0].kind, "dir")
})

test("目录条目超上限时说明省了多少，不是悄悄截断", async () => {
  const files = {}
  for (let i = 0; i < 12; i++) files[`many/f${i}.txt`] = ""
  const out = await expandFileMentions("@many", {
    ...fakeWorkspace({ files }),
    maxDirEntries: 5
  })
  assert.ok(out.text.includes("… [7 more entries omitted]"), out.text)
  assert.equal(out.attached[0].truncated, true)
})

test("二进制不注入内容，进 skipped 并说明原因", async () => {
  const byExtension = await expandWith("check @data.bin")
  assert.deepEqual(byExtension.attached, [])
  assert.deepEqual(byExtension.skipped, [{ path: "data.bin", ref: "data.bin", reason: "binary" }])

  const byContent = await expandWith("check @weird.txt")
  assert.deepEqual(byContent.skipped, [{ path: "weird.txt", ref: "weird.txt", reason: "binary" }],
    "扩展名骗人的时候要靠内容里的 NUL 认出来")
  assert.ok(!byContent.text.includes("after"), "二进制内容漏进上下文了")
})

test("同一个文件引用多次只注入一次", async () => {
  const out = await expandWith("@src/foo.ts vs @src/foo.ts vs @./src/foo.ts")
  assert.equal(countOccurrences(out.text, "<file"), 1, "重复引用被注入了多份")
  assert.equal(out.attached.length, 1)
})

test("超过 maxFileBytes 时截断，并注明少了多少字节", async () => {
  const content = "0123456789\n".repeat(10)   // 110 字节
  const out = await expandFileMentions("@big.txt", {
    ...fakeWorkspace({ files: { "big.txt": content } }),
    maxFileBytes: 25
  })
  // 截断点落在行边界上：前两行 22 字节
  assert.ok(out.text.includes("… [truncated: 88 more bytes omitted]"), out.text)
  assert.deepEqual(out.attached, [{ path: "big.txt", kind: "file", bytes: 22, truncated: true }])
  assert.ok(!out.text.includes("0123456789\n0123456789\n0123456789"), "截断没真的生效")
})

test("总量到顶后停止追加，剩下的进 skipped", async () => {
  const ws = fakeWorkspace({ files: { "a.txt": "AAAA", "b.txt": "BBBB", "c.txt": "CCCC" } })
  const oneBlock = Buffer.byteLength('<file path="a.txt">\nAAAA\n</file>')
  const out = await expandFileMentions("@a.txt @b.txt @c.txt", {
    ...ws,
    maxTotalBytes: oneBlock + 1
  })
  assert.deepEqual(out.attached.map((item) => item.path), ["a.txt"])
  assert.deepEqual(out.skipped, [
    { path: "b.txt", ref: "b.txt", reason: "total-budget" },
    { path: "c.txt", ref: "c.txt", reason: "total-budget" }
  ], "到顶之后的每一个都要说出来，「装到一半」比「明确没装」更难排查")
  assert.ok(!out.text.includes("BBBB") && !out.text.includes("CCCC"))
})

test("没有 mention 时返回的就是原字符串，什么都不做", async () => {
  // 绝大多数回合不带引用，那条路径必须零开销、零副作用。
  // 注意这里故意塞了邮箱、连续空格、换行与行尾空格 —— 既有的 extractImageRefs 会把它们
  // 折叠掉（它 replace(/\s{2,}/g, " ").trim()），这个函数绝不可以。
  const input = "mail foo@bar.com  about the\n  indented line "
  const out = await expandWith(input)
  assert.equal(out.text, input)
  assert.deepEqual(out.attached, [])
  assert.deepEqual(out.missing, [])
  assert.deepEqual(out.skipped, [])
})

test("引号包裹与转义空格的引用都能展开", async () => {
  const ws = fakeWorkspace({ files: { "my docs/a b.ts": "spaced" } })
  const quoted = await expandFileMentions('read @"my docs/a b.ts"', { ...ws })
  assert.deepEqual(quoted.attached.map((item) => item.path), ["my docs/a b.ts"])
  const escaped = await expandFileMentions("read @my\\ docs/a\\ b.ts", { ...ws })
  assert.deepEqual(escaped.attached.map((item) => item.path), ["my docs/a b.ts"])
})

// --- 6. 真实 fs 冒烟 ---

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

// 这两条是「fs 与 pathApi 成对」规矩的**唯一例外**，也正因为是例外才要显式写出
// `pathApi: path`：它们用的是宿主的真实 fs，就必须配宿主的 path。写死成 posix 会在
// Windows 上错，不写又会被上面那条「默认值临时改成 win32」的复核误伤 —— 那时它们
// 会红，而红的原因与被测行为无关。
test("真实仓库上的索引：拿得到 package.json，拿不到 node_modules", () => {
  const index = createFileIndex({ cwd: REPO_ROOT, fs: realFs, pathApi: path })
  const files = index.list()
  assert.ok(files.includes("package.json"), "连 package.json 都没索引到")
  assert.ok(files.includes("src/repl/file-mention.mjs"))
  assert.equal(files.filter((file) => file.startsWith("node_modules/")).length, 0)
  assert.equal(index.stats().truncated, false, `仓库文件数超过了默认上限：${index.stats().files}`)
})

test("真实 fs 上的展开：node:fs 的接口对得上", async () => {
  const out = await expandFileMentions("read @package.json", { cwd: REPO_ROOT, fs: realFs, pathApi: path })
  assert.deepEqual(out.missing, [])
  assert.equal(out.attached[0]?.path, "package.json")
  assert.ok(out.text.includes('<file path="package.json">'))
  assert.ok(out.text.includes('"name"'))
})
