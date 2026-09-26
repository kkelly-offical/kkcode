import path from "node:path"
import { access, readFile, realpath, stat } from "node:fs/promises"
import YAML from "yaml"
import { DEFAULT_CONFIG } from "./defaults.mjs"
import { validateConfig } from "./schema.mjs"
import { projectConfigCandidates, userConfigCandidates, envFileCandidates, userRootDir } from "../storage/paths.mjs"
import { noteDeprecation } from "../kernel/core/deprecations.mjs"
import { FORBIDDEN_MERGE_KEYS, mergeConfigObject } from "./merge.mjs"
import { DENY_DATA_POLICY, intersectDataPolicies, normalizeDataPolicy } from "../kernel/permission/data-policy.mjs"

async function exists(file) {
  try {
    await access(file)
    return true
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false
    throw new Error('无法读取配置来源，已停止加载以避免遗漏数据出域限制')
  }
}

function parseConfigFile(filePath, content) {
  if (filePath.endsWith(".json")) return JSON.parse(content)
  return YAML.parse(content)
}

function mergeObject(base, override) {
  const merged = mergeConfigObject(base, override)
  if (base?.data_policy !== undefined || Object.hasOwn(override || {}, 'data_policy')) {
    merged.data_policy = intersectDataPolicies(base?.data_policy, override?.data_policy)
  }
  return merged
}
const forbiddenMergeKeys = new Set(FORBIDDEN_MERGE_KEYS)

/**
 * schema 校验需要看见显式 null。正式合并里 null 表示「继承低优先级值」，但若直接
 * 用那份结果校验，`permission.level: null` 会被默认值遮住，形成假绿。这里仅供
 * validation 使用：null 原样覆盖，让 schema 决定该字段是否允许 null。
 */
function mergeForValidation(base, override) {
  if (override === undefined) return base
  if (override === null) return null
  if (Array.isArray(override)) return [...override]
  if (!base || typeof base !== "object" || Array.isArray(base)) return override
  if (typeof override !== "object") return override
  const out = { ...base }
  for (const key of Object.keys(override)) {
    if (forbiddenMergeKeys.has(key)) continue
    out[key] = mergeForValidation(base[key], override[key])
  }
  return out
}

async function sameConfigFile(left, right) {
  if (!left || !right) return false
  if (path.resolve(left) === path.resolve(right)) return true
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)])
    if (a === b) return true
    const [aInfo, bInfo] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
    return aInfo.ino > 0n && aInfo.ino === bInfo.ino && aInfo.dev === bInfo.dev
  } catch { return false }
}

async function firstExisting(candidates, exclude = null) {
  for (const candidate of candidates) {
    if (await exists(candidate) && !(exclude && await sameConfigFile(candidate, exclude))) return candidate
  }
  return null
}

/**
 * Parse .env file — only extract KKCODE_ prefixed vars into nested config.
 * Uses __ (double underscore) as nesting separator, single _ stays in key name.
 *
 * KKCODE_PROVIDER__DEFAULT=anthropic → { provider: { default: "anthropic" } }
 * KKCODE_AGENT__LONGAGENT__PARALLEL__MAX_CONCURRENCY=5 → { agent: { longagent: { parallel: { max_concurrency: 5 } } } }
 * KKCODE_LANGUAGE=zh → { language: "zh" }
 */
export function parseEnvOverlay(content) {
  const config = {}
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx <= 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    if (!key.startsWith("KKCODE_")) continue
    let val = trimmed.slice(eqIdx + 1).trim()
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    // split on __ for nesting, lowercase each part
    const parts = key.slice(7).split("__").map(p => p.toLowerCase())
    // coerce types
    let typed = val
    if (val === "true") typed = true
    else if (val === "false") typed = false
    else if (val !== "" && !isNaN(val)) typed = Number(val)
    if (parts[0] === 'data_policy') {
      try { typed = JSON.parse(val) } catch { /* Invalid values remain visible to fail-closed validation. */ }
    }

    let cursor = config
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {}
      cursor = cursor[parts[i]]
    }
    cursor[parts[parts.length - 1]] = typed
  }
  return config
}

const FORBIDDEN_ERROR_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"])

/**
 * schema 目前对外保持字符串错误格式；这里只解析无歧义的点路径和数组下标。
 * 动态键里带点/方括号时无法从展示文案还原真实键名，必须返回 null
 * 让整层 fail-safe，不能猜。
 *
 * @param {string} error
 * @returns {Array<string|number>|null}
 */
function parseErrorPath(error) {
  const colon = String(error || "").indexOf(": ")
  if (colon <= 0) return null
  const field = String(error).slice(0, colon)
  const expanded = field.replace(/\[(\d+)\]/g, ".$1")
  if (!expanded || /[\[\]]/.test(expanded)) return null
  const rawSegments = expanded.split(".")
  if (rawSegments.some((segment) => !segment || FORBIDDEN_ERROR_PATH_SEGMENTS.has(segment))) return null
  return rawSegments.map((segment) => /^\d+$/.test(segment) ? Number(segment) : segment)
}

/** 数组元素内任一字段失效时，丢掉整个元素，不留下缺必填键的半条 rule。 */
function discardTarget(tokens) {
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (typeof tokens[index] === "number") return tokens.slice(0, index + 1)
  }
  return tokens
}

/**
 * 只沿自有属性下钻。这个不变量是安全边界：项目配置不可借错误路径
 * 进入 Object.prototype，更不能 delete 其中属性。
 *
 * @param {any} root
 * @param {Array<string|number>} tokens
 */
function deleteOwnPath(root, tokens) {
  if (!root || typeof root !== "object" || tokens.length === 0) return false
  let cursor = root
  for (let index = 0; index < tokens.length - 1; index++) {
    const segment = tokens[index]
    if (typeof segment === "string" && FORBIDDEN_ERROR_PATH_SEGMENTS.has(segment)) return false
    if (!cursor || typeof cursor !== "object" || !Object.hasOwn(cursor, segment)) return false
    cursor = cursor[segment]
  }
  const leaf = tokens[tokens.length - 1]
  if (typeof leaf === "string" && FORBIDDEN_ERROR_PATH_SEGMENTS.has(leaf)) return false
  if (!cursor || typeof cursor !== "object" || !Object.hasOwn(cursor, leaf)) return false
  if (Array.isArray(cursor) && typeof leaf === "number") {
    cursor.splice(leaf, 1)
    return true
  }
  return Reflect.deleteProperty(cursor, leaf)
}

/**
 * @param {any} config
 * @param {string[]} errors
 */
function pruneErrorPaths(config, errors) {
  const targets = new Map()
  for (const error of errors) {
    const parsed = parseErrorPath(error)
    if (!parsed) continue
    const target = discardTarget(parsed)
    targets.set(JSON.stringify(target), target)
  }
  const ordered = [...targets.values()].sort((left, right) => {
    const leftParent = JSON.stringify(left.slice(0, -1))
    const rightParent = JSON.stringify(right.slice(0, -1))
    if (leftParent === rightParent && typeof left.at(-1) === "number" && typeof right.at(-1) === "number") {
      return right.at(-1) - left.at(-1)
    }
    return right.length - left.length
  })
  let changed = false
  for (const target of ordered) changed = deleteOwnPath(config, target) || changed
  return changed
}

/**
 * 这些字段描述权限边界。把拼错值裁掉后继续运行会让用户误以为限制仍在：
 * 例如 sandbox.mode 打错后运行时实际是 off。schema 对它们本来就明确要求
 * 可见失败，因此 permission 下任一错误都拒绝整个权限子树，并将工具执行
 * 锁定到修正配置为止。不能裁掉 deny rule 却保留 yolo，也不应连带丢掉模型配置。
 */
function isHardLayerError(error) {
  const field = String(error || "").split(": ", 1)[0]
  return field === "permission" || field.startsWith("permission.")
}

/**
 * 校验一层配置的**真实合并结果**，只从当前层裁掉无效值。
 * 裁剪成功是 warning；无法安全定位或复验仍失败才整层丢弃并记 error。
 *
 * @param {any} rawConfig
 * @param {any} baseConfig
 * @param {string} label
 */
function validateLayerCore(rawConfig, baseConfig, label, normalize = (config) => config) {
  let current = structuredClone(rawConfig)
  const seenErrors = new Set()
  const permissionErrors = new Set()

  for (let round = 0; round < 12; round++) {
    // alias 的嵌套 ultra 若本身是坏值，第一轮先让 schema 裁掉；
    // 下一轮再把同层合法的平铺 goal 键归位，避免把字符串 spread
    // 成数字键对象后假绿。
    current = normalize(current)
    const check = validateConfig(mergeForValidation(baseConfig, current))
    if (check.valid) {
      return {
        config: current,
        errors: [...permissionErrors].map((error) => `${label}: ${error}`),
        permissionBlocked: permissionErrors.size > 0,
        warnings: [...seenErrors].map((error) => `${label}: ${error}（该项已忽略，同层其余配置仍生效）`)
      }
    }
    if (check.errors.some(isHardLayerError)) {
      for (const error of check.errors.filter(isHardLayerError)) permissionErrors.add(error)
      // Never retain only the allow/yolo half of a malformed permission policy.
      // The aggregate flag is enforced after all layers, so a later project or
      // env overlay cannot hide this error or unlock tool execution.
      if (current && typeof current === 'object') delete current.permission
      for (const error of check.errors.filter(error => !isHardLayerError(error))) seenErrors.add(error)
      if (permissionErrors.size > 0) continue
    }
    for (const error of check.errors) seenErrors.add(error)
    if (!pruneErrorPaths(current, check.errors)) break
  }

  return {
    config: {},
    errors: [...permissionErrors, ...seenErrors].map((error) => `${label}: ${error}`),
    // An unparseable validation path can also hide a valid deny/sandbox policy
    // in the discarded layer. Do not silently fall back to broader defaults.
    permissionBlocked: true,
    layerRejected: true,
    warnings: []
  }
}

/**
 * 拆开同一层的 canonical `agent.longagent` 和兼容别名 `agent.ultra`。
 * 别名是更高优先级的子层：合法字段覆盖 canonical，无效字段
 * 被独立裁掉后必须回退到 canonical，不能在归一化时把原值破坏。
 */
function splitUltraAlias(raw) {
  if (!raw?.agent || typeof raw.agent !== "object" || Array.isArray(raw.agent)) return null
  if (!Object.hasOwn(raw.agent, "ultra")) return null
  const { ultra, ...canonicalAgent } = raw.agent
  return {
    canonical: { ...raw, agent: canonicalAgent },
    alias: { agent: { longagent: ultra } }
  }
}

function normalizeUltraAliasOverlay(raw) {
  const longagent = raw?.agent?.longagent
  if (!longagent || typeof longagent !== "object" || Array.isArray(longagent)) return raw
  return {
    ...raw,
    agent: {
      ...raw.agent,
      longagent: hoistUltraSectionKeys(longagent)
    }
  }
}

function validateLayer(rawConfig, baseConfig, label) {
  let policy
  try { policy = normalizeDataPolicy(rawConfig?.data_policy) }
  catch {
    return { config: { data_policy: structuredClone(DENY_DATA_POLICY) }, permissionBlocked: true, errors: [`${label}: data_policy 无效，所有受管理的出站请求已拒绝，请修正配置`], warnings: [] }
  }
  const result = validateLayerWithoutPolicy(rawConfig, baseConfig, label)
  // A bad unrelated field must not drop a valid same-layer restriction.
  if (policy !== undefined) result.config.data_policy = policy
  return result
}

function validateLayerWithoutPolicy(rawConfig, baseConfig, label) {
  const split = splitUltraAlias(rawConfig)
  if (!split) return validateLayerCore(rawConfig, baseConfig, label)

  const canonical = validateLayerCore(split.canonical, baseConfig, label)
  // Invalid ordinary structure still fails the layer. A rejected permission
  // subtree must not hide otherwise valid Ultra/provider settings.
  if (canonical.layerRejected || canonical.errors.length > 0 && !canonical.permissionBlocked) return canonical

  const aliasBase = mergeObject(baseConfig, canonical.config)
  const alias = validateLayerCore(split.alias, aliasBase, label, normalizeUltraAliasOverlay)
  return {
    config: mergeObject(canonical.config, alias.config),
    permissionBlocked: Boolean(canonical.permissionBlocked || alias.permissionBlocked),
    errors: [...canonical.errors, ...alias.errors],
    warnings: [...canonical.warnings, ...alias.warnings]
  }
}

async function loadOne(filePath, baseConfig) {
  if (!filePath) return { config: {}, errors: [], warnings: [] }
  let raw = ''
  try {
    raw = await readFile(filePath, "utf8")
    const parsed = parseConfigFile(filePath, raw) ?? {}
    return validateLayer(parsed, baseConfig, filePath)
  } catch (error) {
    // A parse error can hide an escaped/partially written policy key; do not
    // infer that the unavailable policy was unrestricted or echo secret text.
    return { config: { data_policy: structuredClone(DENY_DATA_POLICY) }, permissionBlocked: true, errors: [`${filePath}: 无法读取或解析配置，受管理的出站请求已拒绝；请修正配置`], warnings: [] }
  }
}

/**
 * goal 模式的配置段键名（`agent.longagent.ultra.*`）。
 * 与 longagent 顶层键无一重名 —— 顶层出现这些键必然是写错了层级。
 */
const ULTRA_SECTION_KEYS = Object.freeze([
  "goal_mode", "max_rounds", "deadline_ms", "no_progress_rounds", "no_progress_warn_rounds",
  "on_blocked_non_tty", "confirm_acceptance", "stage_failure", "criteria", "report", "ledger"
])

/**
 * 把写在 longagent 顶层的 goal 模式键搬进 `.ultra` 段。
 *
 * 「Ultra 的配置」直觉上就该写在 `agent.ultra` 下，但 `agent.ultra` 是
 * 0.4.0 给 `agent.longagent` 起的别名，平铺后 `agent.ultra.goal_mode`
 * 落到没人读的 `agent.longagent.goal_mode` —— 校验通过、静默失效，
 * 只有反直觉的 `agent.ultra.ultra.goal_mode` 才真正生效（0.5.5 修复）。
 * 已经写对位置的值优先，不被顶层的错位值覆盖。
 */
function hoistUltraSectionKeys(longagent) {
  const misplaced = ULTRA_SECTION_KEYS.filter((key) => longagent[key] !== undefined)
  if (misplaced.length === 0) return longagent

  // 非对象 nested ultra 必须先由 schema 报错/裁掉。直接 spread
  // 字符串会产生 {0:"b",1:"a",...} 并绕过当前的字段校验。
  if (
    longagent.ultra !== undefined &&
    (!longagent.ultra || typeof longagent.ultra !== "object" || Array.isArray(longagent.ultra))
  ) return longagent

  const next = { ...longagent, ultra: { ...(longagent.ultra || {}) } }
  for (const key of misplaced) {
    if (next.ultra[key] === undefined) next.ultra[key] = next[key]
    delete next[key]
  }
  noteDeprecation(
    "config.agent.ultra.section",
    `${misplaced.map((k) => `agent.ultra.${k}`).join("、")} 应写在 agent.ultra.ultra.${misplaced[0]} 段下；` +
    "已自动归位，下一个大版本会移除这层兼容"
  )
  return next
}

export async function loadConfig(cwd = process.cwd(), { adminDataPolicy = undefined } = {}) {
  const resolvedCwd = path.resolve(cwd)
  const userPath = await firstExisting(userConfigCandidates())
  // At the OS user's home, .kkcode/config.* is the user config itself, not a
  // second project-controlled layer. Skip physical aliases too, but continue
  // looking for a genuinely distinct project file instead of discarding it.
  const projectPath = await firstExisting(projectConfigCandidates(cwd), userPath)

  const adminPolicy = normalizeDataPolicy(adminDataPolicy)
  const baseConfig = adminPolicy === undefined ? DEFAULT_CONFIG : { ...DEFAULT_CONFIG, data_policy: adminPolicy }
  const userLoaded = await loadOne(userPath, baseConfig)
  let userConfig = mergeObject(baseConfig, userLoaded.config)
  const projectLoaded = await loadOne(projectPath, userConfig)
  let userPermissionBlocked = Boolean(userLoaded.permissionBlocked)
  let permissionBlocked = userPermissionBlocked || Boolean(projectLoaded.permissionBlocked)
  let merged = mergeObject(userConfig, projectLoaded.config)
  const preEnvMerged = merged
  const preEnvUserConfig = userConfig

  // .env overlay — highest priority, KKCODE_ prefixed vars
  let envPath = null
  let envScope = null
  let envOverlay = {}
  let envErrors = []
  let envWarnings = []
  const envCandidate = await firstExisting(envFileCandidates(cwd))
  if (envCandidate) {
    try {
      const userEnvPath = path.join(userRootDir(), ".env")
      const isUserEnv = await sameConfigFile(envCandidate, userEnvPath)
      // Read a user-scoped overlay through the trusted user path itself. A
      // workspace-controlled symlink could otherwise change between reading
      // its bytes and attributing them to the user configuration.
      const raw = await readFile(isUserEnv ? userEnvPath : envCandidate, "utf8")
      const parsedOverlay = parseEnvOverlay(raw)
      if (Object.keys(parsedOverlay).length > 0) {
        envPath = envCandidate
        envScope = isUserEnv ? "user" : "project"
        // 用户级 .env 也会进入不受信任工作区使用的 userConfig，不能借项目层里
        // 才存在的 provider 等键通过校验，否则 userConfig 会变成一份非法配置。
        const envLoaded = validateLayer(parsedOverlay, envScope === "user" ? userConfig : merged, envCandidate)
        envErrors = [...envLoaded.errors]
        envWarnings = [...envLoaded.warnings]
        permissionBlocked ||= Boolean(envLoaded.permissionBlocked)
        if (envScope === 'user') userPermissionBlocked ||= Boolean(envLoaded.permissionBlocked)

        // user .env 是 userConfig 的一部分；它对用户层独立合法时，不能因为
        // 与某个项目层组合后冲突就从未信任工作区的 userConfig 里消失。
        // 因此保留独立验证后的 user overlay，最终项目视图使用另一份
        // effective overlay。
        const userEnvOverlay = envLoaded.config
        let effectiveEnvOverlay = envLoaded.config

        // user .env 独立合法仍不够：项目层可能合法地覆盖同一 provider 的其他字段，
        // 两者组合后才触发 gateway 等跨字段约束。再对真实最终 base 校验一次，
        // 冲突只裁/拒绝 env 层，绝不能在最终 invariant 里清空所有已验证配置。
        if (envScope === "user" && Object.keys(envLoaded.config).length > 0) {
          const effectiveEnv = validateLayer(envLoaded.config, merged, envCandidate)
          effectiveEnvOverlay = effectiveEnv.config
          envErrors.push(...effectiveEnv.errors)
          envWarnings.push(...effectiveEnv.warnings)
          permissionBlocked ||= Boolean(effectiveEnv.permissionBlocked)
        }
        if (envScope === "user") userConfig = mergeObject(userConfig, userEnvOverlay)
        envOverlay = effectiveEnvOverlay
        merged = mergeObject(merged, envOverlay)
      }
    } catch (error) {
      envPath = envCandidate
      envScope = await sameConfigFile(envCandidate, path.join(userRootDir(), '.env')) ? 'user' : 'project'
      permissionBlocked = true
      if (envScope === 'user') userPermissionBlocked = true
      envErrors = [`${envCandidate}: 无法读取或解析环境配置，工具与扩展启动已暂停；请修正配置`]
    }
  }

  // 每层都经过「合并后校验」；这个最终不变量防止后续重构又开旁路。
  const finalCheck = validateConfig(merged)
  if (!finalCheck.valid) {
    envErrors.push(...finalCheck.errors.map((error) => `merged config: ${error}`))
    // 这是最后一道 invariant，不应可达。即使未来重构重新开出旁路，也只回退
    // 尚未应用 env 的 last-known-good，不能把合法 user/project 配置全清成 defaults。
    merged = validateConfig(preEnvMerged).valid ? preEnvMerged : structuredClone(baseConfig)
    userConfig = validateConfig(preEnvUserConfig).valid ? preEnvUserConfig : structuredClone(baseConfig)
    envOverlay = {}
  }

  // Ordinary env values retain the historical first-file precedence, but a
  // project .env must not mask policy in ~/.kkcode/.env (or another candidate).
  const envPolicyLayers = []
  const seenEnvPaths = []
  for (const candidate of envFileCandidates(cwd)) {
    if (!await exists(candidate)) continue
    let duplicate = false
    for (const previous of seenEnvPaths) if (await sameConfigFile(candidate, previous)) duplicate = true
    if (duplicate) continue
    seenEnvPaths.push(candidate)
    const userEnvPath = path.join(userRootDir(), '.env')
    const scope = await sameConfigFile(candidate, userEnvPath) ? 'user' : 'project'
    let policy
    try {
      const raw = await readFile(scope === 'user' ? userEnvPath : candidate, 'utf8')
      const lines = raw.split('\n').filter(line => /^\s*KKCODE_DATA_POLICY(?:_|\s|=|$)/.test(line))
      // One suffix already includes every underscore-separated component. A
      // repeated suffix group overlaps its own '_' character class and causes
      // exponential backtracking on malformed, workspace-controlled env keys.
      if (lines.some(line => line.indexOf('=') <= 0 || !/^KKCODE_DATA_POLICY(?:__[A-Za-z0-9_]+)?$/.test(line.slice(0, line.indexOf('=')).trim()))) throw new Error('invalid policy declaration')
      policy = normalizeDataPolicy(parseEnvOverlay(lines.join('\n')).data_policy)
    } catch {
      policy = structuredClone(DENY_DATA_POLICY)
      envErrors.push(`${candidate}: data_policy 无法读取或无效，受管理的出站请求已拒绝`)
    }
    if (policy === undefined) continue
    envPolicyLayers.push({ scope, policy })
    merged = mergeObject(merged, { data_policy: policy })
    if (scope === 'user') userConfig = mergeObject(userConfig, { data_policy: policy })
  }

  const source = {
    ...(adminPolicy === undefined ? {} : { adminDataPolicy: adminPolicy }),
    cwd: resolvedCwd,
    userPath,
    userDir: userPath ? path.dirname(userPath) : null,
    userRaw: userLoaded.config,
    projectPath,
    projectDir: projectPath ? path.dirname(projectPath) : null,
    projectRaw: projectLoaded.config,
    envPath,
    envScope,
    envOverlay,
    envPolicyLayers
  }

  // Internal, recomputed protection: never accept a persisted flag as a way to
  // clear a load error. Mode switches preserve this independent hard denial.
  merged.permission = { ...merged.permission }
  userConfig.permission = { ...userConfig.permission }
  delete merged.permission._load_error
  delete userConfig.permission._load_error
  if (permissionBlocked) merged.permission._load_error = true
  if (userPermissionBlocked) userConfig.permission._load_error = true

  return {
    config: merged,
    userConfig,
    source,
    permissionBlocked,
    errors: [...userLoaded.errors, ...projectLoaded.errors, ...envErrors],
    warnings: [...userLoaded.warnings, ...projectLoaded.warnings, ...envWarnings]
  }
}
