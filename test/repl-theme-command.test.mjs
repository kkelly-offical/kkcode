import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import YAML from "yaml"
import { authoringCommands } from "../src/repl/commands/authoring.mjs"
import { resolveCommand } from "../src/repl/commands/registry.mjs"
import { persistUiConfig } from "../src/repl/config-persistence.mjs"
import { createThemeSwitcher } from "../src/repl/theme-switch.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { LIGHT_THEME } from "../src/theme/light-theme.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"

/**
 * `/theme` 与它的落盘。
 *
 * 两种宿主形态都要覆盖：TUI 有注入的切换器（浮层与命令共用同一个实例，预览/还原
 * 才对得上），行模式没有 —— 那时命令自己造一个，否则 `/theme light` 在管道模式下
 * 会静默什么都不做。
 */

function makeCtx({ userPath = null } = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  return {
    configState: { config, source: userPath ? { userPath } : {} },
    themeState: { theme: structuredClone(DEFAULT_THEME), source: "default", errors: [], detectedBackground: null }
  }
}

function runTheme(args, extra = {}) {
  const hit = resolveCommand(`/theme${args ? ` ${args}` : ""}`, authoringCommands)
  assert.ok(hit, `/theme ${args} 应该匹配到命令`)
  const prints = []
  const cmd = {
    args: hit.args,
    print: (text, options) => prints.push({ text, ...options }),
    showInfo: () => {},
    ...extra
  }
  return { prints, result: hit.entry.run(cmd) }
}

test("/theme 进了命令注册表，裸命令与带参都认", () => {
  assert.ok(resolveCommand("/theme", authoringCommands), "裸 /theme 要开浮层")
  assert.ok(resolveCommand("/theme light", authoringCommands), "/theme <name> 要直切")
})

test("bare /theme lists the themes and asks the host for a picker", async () => {
  const ctx = makeCtx()
  const { prints, result } = runTheme("", { ctx })
  const action = await result
  assert.equal(action.openThemePicker, true, "TUI 宿主据此开浮层")
  const text = prints.map((p) => p.text).join("\n")
  // 行模式看不到浮层，清单必须打出来 —— 与 /mode 同形
  for (const id of ["dark", "light", "auto"]) assert.match(text, new RegExp(id))
  assert.match(text, /theme: dark/, "当前是哪个得说清楚")
})

test("/theme <name> switches through the injected switcher when there is one", async () => {
  // TUI 里浮层与命令必须是**同一个**切换器实例，否则 /theme 切完之后
  // 浮层里的 restore 与 current 还停在旧值上。
  const ctx = makeCtx()
  const saves = []
  const themeSwitcher = createThemeSwitcher({
    themeState: ctx.themeState,
    config: ctx.configState.config,
    saveUiConfig: (values) => { saves.push(values) }
  })
  const { prints, result } = runTheme("light", { ctx, themeSwitcher })
  await result
  assert.equal(ctx.themeState.theme.name, LIGHT_THEME.name)
  assert.deepEqual(saves, [{ theme: "light" }])
  assert.match(prints.map((p) => p.text).join("\n"), /theme switched: light/)
})

test("an unknown theme name reports the options instead of half-switching", async () => {
  const ctx = makeCtx()
  const { prints, result } = runTheme("dracula", { ctx })
  await result
  assert.equal(ctx.themeState.theme.name, DEFAULT_THEME.name, "配色不该被动过")
  const error = prints.find((p) => p.tone === "error")
  assert.ok(error, "认不出来的名字要报错，不是静默无事发生")
  assert.match(error.text, /dark \| light \| auto/, "报错要带上有哪些可选")
})

test("/theme without a host switcher still switches and persists (line mode)", async (t) => {
  // 行模式没有 TUI 宿主，命令自己造切换器。这条同时把 persistUiConfig 走通。
  const dir = await mkdtemp(join(tmpdir(), "kkcode-theme-cmd-"))
  const userPath = join(dir, "config.yaml")
  await writeFile(userPath, YAML.stringify({
    provider: { default: "test" },
    ui: { theme_file: "mine.yaml", layout: "compact" }
  }), "utf8")

  const ctx = makeCtx({ userPath })
  const { result } = runTheme("light", { ctx })
  await result

  assert.equal(ctx.themeState.theme.name, LIGHT_THEME.name, "行模式下也得真的换色")
  const written = YAML.parse(await readFile(userPath, "utf8"))
  assert.equal(written.ui.theme, "light")
  assert.equal(written.ui.theme_file, "mine.yaml", "同一节里没动过的字段不能被抹掉")
  assert.equal(written.ui.layout, "compact")
  assert.deepEqual(written.provider, { default: "test" }, "别的节更不该被动")
  t.diagnostic(`wrote ${userPath}`)
})

test("persistUiConfig merges into ui and makes it live at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kkcode-persist-ui-"))
  const userPath = join(dir, "config.yaml")
  await writeFile(userPath, YAML.stringify({ ui: { markdown_render: false } }), "utf8")

  const ctx = makeCtx({ userPath })
  const target = await persistUiConfig({ theme: "auto" }, { ctx })
  assert.equal(target, userPath)

  const written = YAML.parse(await readFile(userPath, "utf8"))
  assert.deepEqual(written.ui, { markdown_render: false, theme: "auto" })
  assert.equal(ctx.configState.config.ui.theme, "auto", "本次会话要立即一致，不用重启")
  assert.equal(ctx.configState.config.ui.layout, DEFAULT_CONFIG.ui.layout, "内存里的其它 ui 设置要留着")
})

test("persistUiConfig 直接当 saveUiConfig 回调传也是对的", async (t) => {
  // repl.mjs 就是这么接的（`saveUiConfig: persistUiConfig`）。参数顺序若反过来，
  // 这一接法会把整袋参数当 values 收下 —— 配置原样写回、主题没存上，而界面已经
  // 切好了，没有任何地方会报错。所以这条钉的是**回调形态**，不是内部实现。
  const home = await mkdtemp(join(tmpdir(), "kkcode-home-"))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
  })

  const ctx = makeCtx()
  const switcher = createThemeSwitcher({
    themeState: ctx.themeState,
    config: ctx.configState.config,
    saveUiConfig: persistUiConfig
  })
  await switcher.apply("light").saved

  const written = YAML.parse(await readFile(join(home, "config.yaml"), "utf8"))
  assert.equal(written.ui.theme, "light")
})

test("少了 values 要当场抛，而不是把配置原样写回", async () => {
  await assert.rejects(() => persistUiConfig(), /values/)
  await assert.rejects(() => persistUiConfig({}), /values/)
  await assert.rejects(() => persistUiConfig("light"), /values/)
})

test("persistUiConfig writes the user scope, never the project one", async () => {
  // 主题是「这台机器上这个人喜欢什么颜色」。写进项目级会跟着仓库提交出去，
  // 把个人口味强加给所有协作者。
  const dir = await mkdtemp(join(tmpdir(), "kkcode-persist-scope-"))
  const userPath = join(dir, "user.yaml")
  const projectPath = join(dir, "project.yaml")
  await writeFile(projectPath, YAML.stringify({ ui: { theme: "dark" } }), "utf8")

  const ctx = makeCtx({ userPath })
  ctx.configState.source.projectPath = projectPath
  await persistUiConfig({ theme: "light" }, { ctx })

  assert.equal(YAML.parse(await readFile(projectPath, "utf8")).ui.theme, "dark", "项目级配置不该被碰")
  assert.equal(YAML.parse(await readFile(userPath, "utf8")).ui.theme, "light")
})
