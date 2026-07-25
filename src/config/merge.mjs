/**
 * 配置深度合并 —— 全仓唯一实现。
 *
 * 0.5.7 之前 load-config / import-config / repl / load-theme 各有一份逐字
 * 相同的副本，四份都缺同一道防护：`out[key] = ...` 在 key 为 `__proto__`
 * 时命中的是原型 setter，而不是写一个自有属性。
 *
 * YAML 与 JSON 解析都会把 `__proto__:` 变成**自有可枚举属性**，于是
 * `Object.keys()` 能看见它、赋值又会把合并结果的原型换成 override 里的
 * 对象。项目级配置来自用户打开的任意仓库，schema 也不拦顶层未知键，
 * 所以一份别人仓库里的 `.kkcode/config.yaml` 就能让「默认配置里不存在的
 * 键」读出攻击者写的值 —— 而且它不在自有属性上，`JSON.stringify` 看不见，
 * 排查时格外隐蔽。
 *
 * 这里跳过三个危险键（与 `commands/config.mjs` 的 setByPath 同一套），
 * 静默丢弃而非报错：配置合并发生在启动最早期，此时没有可靠的报错通道，
 * 而这三个键在合法配置里没有任何用途。
 */

export const FORBIDDEN_MERGE_KEYS = Object.freeze(["__proto__", "constructor", "prototype"])

const FORBIDDEN = new Set(FORBIDDEN_MERGE_KEYS)

export function mergeConfigObject(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(override)) return [...override]
  if (!base || typeof base !== "object" || Array.isArray(base)) return override
  if (typeof override !== "object") return override
  const out = { ...base }
  for (const key of Object.keys(override)) {
    if (FORBIDDEN.has(key)) continue
    out[key] = mergeConfigObject(base[key], override[key])
  }
  return out
}
