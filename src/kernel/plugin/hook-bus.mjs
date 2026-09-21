import { runtimeCwd } from "../core/runtime-context.mjs"
import { runtimeDependency } from '../core/runtime-context.mjs'
import path from "node:path"
import { access, readdir } from "node:fs/promises"
import { pathToFileURL, fileURLToPath } from "node:url"
import { userRootDir } from "../../storage/paths.mjs"
import { discoverLocalPluginManifests } from "./manifest-loader.mjs"
import { noteDeprecation, deprecatedSingletonAlias } from "../core/deprecations.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HOOK_EVENTS = [
  "chat.params",
  "chat.message",
  "messages.transform",
  "tool.before",
  "tool.after",
  "event",
  "session.compacting"
]

function normalizeHook(mod, source) {
  const hook = mod.default || mod
  if (!hook || typeof hook !== "object") return null
  return {
    source,
    name: hook.name || path.basename(source),
    chat: hook.chat || {},
    tool: hook.tool || {},
    event: typeof hook.event === "function" ? hook.event : null,
    session: hook.session || {}
  }
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function discover(dir) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && [".mjs", ".js"].includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
}

async function loadModule(file) {
  try {
    const mod = await import(pathToFileURL(file).href)
    return { hook: normalizeHook(mod, file), error: null }
  } catch (error) {
    return { hook: null, error: `${file}: ${error.message}` }
  }
}

async function applyTransformChain(initial, chain) {
  let current = initial
  for (const fn of chain) {
    const next = await fn(current)
    if (next !== undefined) current = next
  }
  return current
}

/**
 * HookBus 工厂（1.0.0 阶段 2a）：hook 列表 / 错误 / 签名缓存收编为实例字段
 * （M3 §四.2），每个 kernel 实例一份。`initialize` 即原模块级 initHookBus。
 */
export function createHookBus() {
  const state = {
    loaded: false,
    hooks: [],
    errors: [],
    warnedPluginAlias: false,
    signature: ""
  }

  async function initialize(cwd = runtimeCwd(), config = {}, {
    allowProjectSources = true,
    force = false
  } = {}) {
    const signature = JSON.stringify({
      cwd: path.resolve(cwd),
      allowProjectSources,
      compat: config?.compat || {}
    })
    if (state.loaded && !force && state.signature === signature) return state
    state.loaded = false
    state.hooks = []
    state.errors = []
    // Built-in hooks ship with kkcode (lowest priority — user hooks can override)
    const builtinHooks = path.join(__dirname, "builtin-hooks")
    const userHooks = path.join(userRootDir(), "hooks")
    const projectPluginHooks = path.join(cwd, ".kkcode", "plugins")
    const projectHooks = path.join(cwd, ".kkcode", "hooks")
    // Load order: builtin → user → project plugin alias → project hooks
    // `.kkcode/plugins` remains a compatibility alias for hook scripts while
    // `.kkcode/hooks` is the explicit project hook path.
    const pluginAliasFiles = allowProjectSources ? await discover(projectPluginHooks) : []
    const manifestState = await discoverLocalPluginManifests(cwd, config, {
      allowProjectSources
    })
    state.errors.push(...manifestState.errors)
    const manifestHookDirs = manifestState.plugins
      .filter((plugin) => plugin.enabled !== false && plugin.hooksEnabled !== false)
      .filter((plugin) => (plugin.sourceEcosystem || plugin.ecosystem || "kkcode") === "kkcode" || config?.compat?.plugins?.execute_external_hooks === true)
      .flatMap((plugin) => plugin.hooks || [])
    const manifestHookFiles = []
    for (const dir of manifestHookDirs) manifestHookFiles.push(...await discover(dir))
    if (pluginAliasFiles.length && !state.warnedPluginAlias) {
      state.errors.push("deprecated hook path: .kkcode/plugins is a compatibility alias for loose hook scripts; prefer .kkcode/hooks or a plugin.json package boundary")
      state.warnedPluginAlias = true
    }
    const files = [
      ...(await discover(builtinHooks)),
      ...(await discover(userHooks)),
      ...pluginAliasFiles,
      ...manifestHookFiles,
      ...(allowProjectSources ? await discover(projectHooks) : [])
    ]
    for (const file of files) {
      const loaded = await loadModule(file)
      if (loaded.error) {
        state.errors.push(loaded.error)
        continue
      }
      if (loaded.hook) state.hooks.push(loaded.hook)
    }
    state.loaded = true
    state.signature = signature
    return state
  }

  return {
    initialize,
    supportedEvents() {
      return [...HOOK_EVENTS]
    },
    list() {
      return state.hooks.map((hook) => ({ name: hook.name, source: hook.source }))
    },
    errors() {
      return [...state.errors]
    },
    async chatParams(payload) {
      const chain = state.hooks
        .map((hook) => hook.chat?.params)
        .filter((fn) => typeof fn === "function")
        .map((fn) => async (current) => fn(current))
      return applyTransformChain(payload, chain)
    },
    async chatMessage(payload) {
      const chain = state.hooks
        .map((hook) => hook.chat?.message)
        .filter((fn) => typeof fn === "function")
        .map((fn) => async (current) => fn(current))
      return applyTransformChain(payload, chain)
    },
    async messagesTransform(payload) {
      const chain = state.hooks
        .map((hook) => hook.chat?.messagesTransform)
        .filter((fn) => typeof fn === "function")
        .map((fn) => async (current) => fn(current))
      return applyTransformChain(payload, chain)
    },
    async toolBefore(payload) {
      const chain = state.hooks
        .map((hook) => hook.tool?.before)
        .filter((fn) => typeof fn === "function")
        .map((fn) => async (current) => fn(current))
      return applyTransformChain(payload, chain)
    },
    async toolAfter(payload) {
      const chain = state.hooks
        .map((hook) => hook.tool?.after)
        .filter((fn) => typeof fn === "function")
        .map((fn) => async (current) => fn(current))
      return applyTransformChain(payload, chain)
    },
    async emit(eventType, payload) {
      for (const hook of state.hooks) {
        if (!hook.event) continue
        try {
          await hook.event({ type: eventType, payload })
        } catch (err) {
          console.error(`[hook-bus] emit error in ${hook.name}:`, err?.message || err)
        }
      }
    },
    async sessionCompacting(payload) {
      const chain = state.hooks
        .map((hook) => hook.session?.compacting)
        .filter((fn) => typeof fn === "function")
        .map((fn) => async (current) => fn(current))
      return applyTransformChain(payload, chain)
    }
  }
}

// 进程级默认 HookBus。2b 过渡期 executeTurn 路径（loop 懒初始化）仍读它；
// frontends 经 facade 白名单取用（repl/turn-controller.mjs 的无句柄回落）。
export const defaultHookBus = createHookBus()

/**
 * 兼容别名（deprecated）：进程级默认 HookBus 实例。旧 import 路径继续工作，
 * 每次方法调用经 deprecations.mjs 记录；新代码用 createKernel() 句柄的
 * `extensions.hooks`。
 */
export const HookBus = deprecatedSingletonAlias(
  "kernel.singleton.hook-bus",
  "模块级单例 `HookBus` 已收编为 kernel 实例字段：新代码改用 createKernel() 句柄的 `extensions.hooks`",
  defaultHookBus
)

/** 兼容别名（deprecated）：等价于默认实例的 `initialize`。 */
export function initHookBus(cwd = runtimeCwd(), config = {}, options = {}) {
  noteDeprecation(
    "kernel.singleton.hook-bus",
    "模块级 `initHookBus` 已收编为 kernel 实例方法：新代码改用 createKernel() 句柄的 `extensions.hooks.initialize`",
    { removal: "1.x" }
  )
  return runtimeDependency('hooks', defaultHookBus).initialize(cwd, config, options)
}
