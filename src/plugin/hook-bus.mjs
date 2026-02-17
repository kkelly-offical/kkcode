import path from "node:path"
import { access, readdir } from "node:fs/promises"
import { pathToFileURL, fileURLToPath } from "node:url"

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

const state = {
  loaded: false,
  hooks: [],
  errors: []
}

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

export async function initHookBus(cwd = process.cwd()) {
  if (state.loaded) return state
  // Built-in hooks ship with kkcode (lowest priority — user hooks can override)
  const builtinHooks = path.join(__dirname, "builtin-hooks")
  const userRoot = process.env.USERPROFILE || process.env.HOME || cwd
  const userHooks = path.join(userRoot, ".kkcode", "hooks")
  const projectHooks = path.join(cwd, ".kkcode", "hooks")
  // Load order: builtin → user → project (later hooks in chain take priority)
  const files = [...(await discover(builtinHooks)), ...(await discover(userHooks)), ...(await discover(projectHooks))]
  for (const file of files) {
    const loaded = await loadModule(file)
    if (loaded.error) {
      state.errors.push(loaded.error)
      continue
    }
    if (loaded.hook) state.hooks.push(loaded.hook)
  }
  state.loaded = true
  return state
}

async function applyTransformChain(initial, chain) {
  let current = initial
  for (const fn of chain) {
    const next = await fn(current)
    if (next !== undefined) current = next
  }
  return current
}

export const HookBus = {
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
