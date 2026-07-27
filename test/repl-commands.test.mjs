import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import {
  resolveCommand,
  buildBuiltinSlashCatalog,
  allCommandNames,
  splitCommandLine
} from "../src/repl/commands/registry.mjs"
import { sessionCommands } from "../src/repl/commands/session.mjs"
import { providerCommands } from "../src/repl/commands/provider.mjs"
import { permissionCommands } from "../src/repl/commands/permission.mjs"
import { modeCommands } from "../src/repl/commands/mode.mjs"
import { authoringCommands } from "../src/repl/commands/authoring.mjs"
import { DEFAULT_SLASH_ALIASES } from "../src/repl/slash-router.mjs"

/**
 * 命令层的行为测试。
 *
 * 拆分之前，这些性质只能**用正则断言源码文本**（`test/overlay-panel.test.mjs` 里
 * 五处 `readFile(repl.mjs)` + 正则、`test/repl-slash-catalog.test.mjs` 整个文件）——
 * 因为 `processInputLine` 是 repl.mjs 里的私有函数，1090 行、49 个顺序 if，
 * 测试够不着。那种断言只能验证「源码里出现了某个字符串」，且一移动代码就失效。
 *
 * 现在命令是可导入的数据，于是可以真的调用它们、看它们往哪个通道写了什么。
 */

const ALL = [
  ...sessionCommands,
  ...providerCommands,
  ...permissionCommands,
  ...modeCommands,
  ...authoringCommands
]

/** 记录命令往各通道写了什么。print 的第二个参数决定通道。 */
function makeCmd(patch = {}) {
  const writes = { transcript: [], notice: [], panel: [], info: [] }
  const cmd = {
    line: "",
    normalized: "",
    name: "",
    args: "",
    state: {
      sessionId: "ses_test",
      mode: "agent",
      modeId: "agent",
      model: "test-model",
      providerType: "test"
    },
    ctx: {
      configState: { config: structuredClone(DEFAULT_CONFIG), source: {} },
      themeState: { theme: DEFAULT_THEME },
      trustState: { trusted: false }
    },
    print: (text, options = {}) => {
      const channel = options.channel === "notice" ? "notice"
        : options.channel === "panel" ? "panel"
        : "transcript"
      writes[channel].push({ text: String(text ?? ""), ...options })
    },
    showInfo: (title, text, options = {}) => {
      writes.info.push({ title, text: typeof text === "function" ? "(函数)" : String(text ?? ""), ...options })
    },
    providersConfigured: ["test", "other"],
    customCommands: [],
    setCustomCommands: () => {},
    providerPicker: null,
    setProviderPicker: () => {},
    pendingImages: [],
    clearPendingImages: () => {},
    streamSink: null,
    showTurnStatus: false,
    signal: null,
    suspendTui: null,
    openPanel: null,
    switchActiveProvider: async () => {},
    switchModeInPlace: (state, ctx, modeId) => {
      state.modeId = modeId
      state.mode = modeId
      return { modeId, mode: modeId, label: modeId, icon: "●", hint: "test" }
    },
    runPromptTurn: async () => ({ exit: false, turnResult: null }),
    ...patch
  }
  return { cmd, writes }
}

function find(name) {
  const entry = ALL.find((item) => item.names.includes(name))
  assert.ok(entry, `注册表里找不到 /${name}`)
  return entry
}

async function run(name, args = "", patch = {}) {
  const entry = find(name)
  const { cmd, writes } = makeCmd({ name, args, normalized: `/${name}${args ? ` ${args}` : ""}`, ...patch })
  const action = await entry.run(cmd)
  return { action, writes, cmd }
}

// --- 匹配：必须和拆分前那 49 个 if 完全一致 ---

test("every form the old router accepted still resolves", () => {
  // 拆分前的分发有三种写法：判等、数组 includes、判前缀。这里把每种形态都过一遍。
  const forms = [
    "/exit", "/quit", "/q", "/help", "/h", "/?", "/keys", "/k", "/session", "/s",
    "/status", "/clear", "/cls", "/dash", "/dashboard", "/home", "/commands",
    "/reload", "/trust", "/untrust", "/compact", "/new", "/n", "/history",
    "/resume", "/resume ses_x", "/r", "/r ses_x", "/undo", "/profile",
    "/profile edit", "/like", "/plan", "/plan 做个东西", "/board", "/assistant",
    "/agent", "/code", "/coding", "/longagent", "/ultra", "/yolo", "/longagent 目标",
    "/ultra 目标", "/ultra 4stage", "/mode", "/m", "/mode agent", "/m agent",
    "/provider", "/p", "/provider add", "/provider edit x", "/p kimi", "/model",
    "/model refresh", "/model k3", "/permission", "/permission show",
    "/permission save user", "/permission forget 0", "/paste", "/paste 看这个图",
    "/create-skill", "/create-skill 做点事", "/agents", "/tasks",
    "/tasks stop bg_1", "/create-agent", "/create-agent 做点事"
  ]
  for (const form of forms) {
    assert.ok(resolveCommand(form, ALL), `「${form}」应被某条命令接住`)
  }
})

test("forms the old router rejected still fall through to the prompt path", () => {
  // 拆分前 `normalized === "/undo"` 的判等意味着 `/undo foo` **不匹配**，会落到
  // 提示词路径报「unknown slash command」。这不是好设计，但改它就是行为变化，
  // 而这次是纯结构改动 —— argMode: "none" 就是为了保住这个语义。
  const forms = [
    "/undo foo", "/status extra", "/profile 别的", "/clear now",
    "/agents all", "/board x", "/unknown", "/", "/trust me"
  ]
  for (const form of forms) {
    assert.equal(resolveCommand(form, ALL), null, `「${form}」不该被命令接住`)
  }
})

test("splitCommandLine separates name from args", () => {
  assert.deepEqual(splitCommandLine("/permission save user"), { name: "permission", args: "save user" })
  assert.deepEqual(splitCommandLine("/status"), { name: "status", args: "" })
  assert.deepEqual(splitCommandLine("/plan  两个空格"), { name: "plan", args: "两个空格" })
  assert.equal(splitCommandLine("没有斜杠"), null)
})

test("no two commands claim the same name", () => {
  const seen = new Map()
  for (const entry of ALL) {
    for (const name of entry.names) {
      assert.ok(!seen.has(name), `/${name} 被 ${seen.get(name)} 和 ${entry.names[0]} 同时声明`)
      seen.set(name, entry.names[0])
    }
  }
})

// --- 目录：与分发同源，不再是两份手写清单 ---

test("the completion catalog is derived from the registry, so it cannot drift", () => {
  const catalog = buildBuiltinSlashCatalog(ALL)
  const names = allCommandNames(ALL)
  // 目录里的每一条都必须真的能执行 —— 此前「补全里有但分发不认」只能靠扫源码发现
  for (const row of catalog) {
    assert.ok(names.has(row.name), `目录里的 /${row.name} 没有对应的命令`)
    assert.ok(row.desc && row.desc.length > 0, `/${row.name} 缺描述`)
  }
  // 反向：能执行但既不在目录里、也不是别名的，等于用户永远发现不了它
  const catalogNames = new Set(catalog.map((row) => row.name))
  const aliasTargets = new Set(Object.keys(DEFAULT_SLASH_ALIASES).map((key) => key.slice(1)))
  const invisible = [...names].filter((name) => {
    if (catalogNames.has(name)) return false
    if (aliasTargets.has(name)) return false
    const entry = ALL.find((item) => item.names.includes(name))
    return entry.names[0] === name  // 主名不在目录里才算问题，别名不算
  })
  assert.deepEqual(invisible, [], `可执行但补全里看不到: ${invisible.join(", ")}`)
})

test("catalog rows are unique", () => {
  const catalog = buildBuiltinSlashCatalog(ALL)
  const names = catalog.map((row) => row.name)
  assert.equal(new Set(names).size, names.length, `目录有重复条目: ${names.join(" ")}`)
})

// --- 输出通道：按性质分，不按长度分 ---

test("read-only queries go to the info overlay, never the transcript", async () => {
  // 这些命令回答的是「现在的状态是什么」。进了对话记录就会随会话发给模型、
  // 被 /clear 清掉、且关不掉。拆分前这条只能用正则在 repl.mjs 里找
  // `showInfo("runtime status"` 这样的字面量。
  for (const [name, args] of [["help", ""], ["keys", ""], ["permission", "show"], ["agents", ""]]) {
    const { writes } = await run(name, args)
    assert.equal(writes.info.length, 1, `/${name} 应该开一个信息浮层`)
    assert.deepEqual(writes.transcript, [], `/${name} 不该往对话记录写东西`)
  }
})

test("command errors are toasts, not conversation", async () => {
  // 「usage: …」是对被拒命令的反馈，不是对话内容。
  const cases = [
    ["model", "", null],                       // 占位，下面单独覆盖
    ["permission", "forget 不是数字", /usage: \/permission forget/],
    ["permission", "non-tty 乱写", /usage: \/permission non-tty/],
    ["permission", "save 乱写", /usage: \/permission save/],
    ["provider", "edit", /usage: \/provider edit/],
    ["create-skill", "", /usage: \/create-skill/],
    ["create-agent", "", /usage: \/create-agent/],
    ["mode", "不存在的模式", /unknown mode/]
  ]
  for (const [name, args, pattern] of cases) {
    if (!pattern) continue
    const { writes } = await run(name, args)
    const noticeText = writes.notice.map((w) => w.text).join("\n")
    assert.match(noticeText, pattern, `/${name} ${args} 的报错应走 notice 通道`)
    const errorTone = writes.notice.some((w) => w.tone === "error")
    assert.ok(errorTone, `/${name} ${args} 的报错应带 tone: "error"`)
  }
})

test("action confirmations are toasts", async () => {
  const { writes } = await run("new")
  assert.match(writes.notice.map((w) => w.text).join("\n"), /new session: ses_/)
  assert.deepEqual(writes.transcript, [], "「刚发生了什么」不属于对话内容")

  const session = await run("session")
  assert.match(session.writes.notice.map((w) => w.text).join("\n"), /session=ses_test/)
})

test("a model id carrying terminal control characters is rejected", async () => {
  // 这是安全相关的一条：模型 id 会被打进状态栏，带转义序列的 id 能改写终端。
  // validateModelId 拦的正是这个（空格与中文是合法的）。
  const ESC = String.fromCharCode(27)
  const { writes, cmd } = await run("model", `k3${ESC}[31m`)
  assert.equal(cmd.state.model, "test-model", "非法 id 不该改动当前模型")
  const notice = writes.notice.map((w) => w.text).join("\n")
  assert.match(notice, /invalid model id/)
  assert.doesNotMatch(notice, /\[31m/, "报错本身也不能把原始转义序列打出去")
})

test("a valid model id switches the model and says so once", async () => {
  const { writes, cmd } = await run("model", "k3-turbo")
  assert.equal(cmd.state.model, "k3-turbo")
  assert.equal(writes.notice.length, 1)
  assert.match(writes.notice[0].text, /model switched: k3-turbo/)
})

// --- 双形态命令：裸命令与带参走不同的路 ---

test("bare /mode opens the picker, /mode <id> switches directly", async () => {
  const bare = await run("mode")
  assert.equal(bare.action.openModePicker, true)

  const withArg = await run("mode", "plan")
  assert.ok(!withArg.action.openModePicker, "带参数不该同时开选择器")
  assert.equal(withArg.cmd.state.modeId, "plan")
})

test("bare /plan switches mode; /plan <goal> rewrites into a planning prompt", async () => {
  const bare = await run("plan")
  assert.equal(bare.cmd.state.modeId, "plan")
  assert.ok(!bare.action.rewrite, "裸 /plan 是切模式，不该改写输入")

  const withGoal = await run("plan", "把目录整理一下")
  assert.equal(withGoal.cmd.state.mode, "plan")
  assert.match(withGoal.action.rewrite, /read-only development plan/)
  assert.match(withGoal.action.rewrite, /Request: 把目录整理一下/)
})

test("/ultra <goal> switches to ultra and hands the goal to the model", async () => {
  const { action, cmd } = await run("ultra", "做一个待办应用")
  assert.equal(cmd.state.modeId, "ultra")
  assert.equal(action.rewrite, "做一个待办应用", "目标原样交给模型，不再包装")
})

test("/ultra 4stage reports the removal instead of running it", async () => {
  const { action, writes } = await run("ultra", "4stage")
  assert.ok(!action.rewrite, "不该把 4stage 当目标发给模型")
  assert.match(writes.transcript.map((w) => w.text).join("\n"), /已移除/)
})

test("bare /provider asks for a picker when a frame exists, prints a list otherwise", async () => {
  const withFrame = await run("provider", "", { openPanel: () => {} })
  assert.equal(withFrame.action.openProviderPicker, true)
  assert.equal(withFrame.action.providerPickerItems.length, 2)

  // 行模式：没有帧可浮，回落到编号列表 + 进入编号输入态
  let pickerSet = null
  const lineMode = await run("provider", "", { openPanel: null, setProviderPicker: (v) => { pickerSet = v } })
  assert.ok(!lineMode.action.openProviderPicker)
  assert.deepEqual(pickerSet, ["test", "other"], "行模式应进入编号选择态")
  assert.match(lineMode.writes.transcript.map((w) => w.text).join("\n"), /1\. test/)
})

test("/provider add cancels cleanly when the form cannot interact; set only points at add", async () => {
  // 0.7.3 起 add 走提问浮层表单（wizard-form.mjs）。这个 harness 没有注册
  // 提问 handler 也不是 TTY，askQuestionInteractive 返回全空 —— 表单必须把它
  // 当成取消：不写任何配置、给一句人话，而不是拿空串配出一个残废 provider。
  const added = await run("provider", "add")
  assert.ok(!added.action.exit)
  assert.match(added.writes.notice.map((w) => w.text).join("\n"), /取消|未写入/)

  const set = await run("provider", "set")
  assert.match(set.writes.transcript.map((w) => w.text).join("\n"), /已更名/)
})

test("/provider edit <name> refuses an unknown provider", async () => {
  const { writes } = await run("provider", "edit 不存在")
  assert.match(writes.notice.map((w) => w.text).join("\n"), /未找到/)
})

// --- action 契约 ---

test("every command returns an action object, never null", async () => {
  // 裸 null 曾让行模式的 REPL 整个崩掉（v0.6.0 → v0.6.14）：三个调用点直接
  // 读 action.cleared。这条遍历所有不需要网络与用户交互的命令。
  const safe = [
    ["exit", ""], ["session", ""], ["clear", ""], ["new", ""], ["help", ""],
    ["keys", ""], ["agents", ""], ["permission", "show"], ["permission", "cycle"],
    ["permission", "list"], ["permission", "session-clear"], ["mode", ""],
    ["mode", "plan"], ["plan", ""], ["agent", ""], ["code", ""], ["yolo", ""],
    ["assistant", ""], ["ultra", ""], ["model", "k3"], ["provider", "乱写"]
  ]
  for (const [name, args] of safe) {
    const { action } = await run(name, args)
    assert.equal(typeof action, "object", `/${name} ${args} 返回了 ${typeof action}`)
    assert.notEqual(action, null, `/${name} ${args} 返回了 null`)
  }
})

test("only /exit asks to exit", async () => {
  const exit = await run("exit")
  assert.equal(exit.action.exit, true)
  for (const [name, args] of [["clear", ""], ["new", ""], ["session", ""], ["help", ""]]) {
    const { action } = await run(name, args)
    assert.ok(!action.exit, `/${name} 不该请求退出`)
  }
})

test("/clear signals a transcript clear without printing anything", async () => {
  const { action, writes } = await run("clear")
  assert.equal(action.cleared, true)
  assert.deepEqual(writes.transcript, [])
  assert.deepEqual(writes.notice, [])
})
