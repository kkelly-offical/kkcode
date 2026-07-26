/**
 * 斜杠命令注册表 —— 补全目录与实际分发的**单一来源**。
 *
 * 此前这两件事是两份各写各的清单：`BUILTIN_SLASH` 是手写数组，分发是
 * `processInputLine` 里一长串 49 个 `if`。加命令时只改分发是最自然的疏忽，
 * `/board`、`/cls`、`/home`、`/yolo` 等八条就这样一直能执行、却从不出现在补全里。
 * 0.6.0 加了一条扫源码正则的测试挡住漂移 —— 那是在用测试弥补结构缺陷。
 * 现在目录由注册表派生，漂移在结构上不可能发生。
 *
 * ## 参数模式（argMode）
 *
 * 匹配必须保持和那 49 个 `if` 完全一致，否则这次纯结构改动会偷偷改变行为：
 *
 *   - `"none"`     —— 只匹配裸命令。`/undo foo` **不匹配**，落到 prompt 路径
 *                     报「unknown slash command」，与原先 `normalized === "/undo"` 一致
 *   - `"optional"` —— 裸命令与带参都匹配，由 run 内部分流
 *                     （`/mode` 开选择器 vs `/mode agent` 直接切）
 *   - `"required"` —— 只匹配带参形态
 *
 * 需要更细的（如 `/profile` 只认裸命令与 `edit`）用 `accepts(args)` 覆盖。
 *
 * ## 返回值
 *
 * `run` 返回 action 对象（`{ exit, cleared, … }`），或者 `{ rewrite: "…" }`
 * 表示「改写输入后继续走 prompt 路径」—— `/plan <目标>`、`/ultra <目标>` 是
 * 这一类：它们不是终结命令，而是把用户的话包装成一段提示词再交给模型。
 */

/** 从整行里拆出命令名与参数。名字不带 `/`。 */
export function splitCommandLine(normalized) {
  const raw = String(normalized || "")
  if (!raw.startsWith("/")) return null
  const body = raw.slice(1)
  const firstSpace = body.search(/\s/)
  if (firstSpace < 0) return { name: body, args: "" }
  return { name: body.slice(0, firstSpace), args: body.slice(firstSpace + 1).trim() }
}

function acceptsArgs(entry, args) {
  if (typeof entry.accepts === "function") return Boolean(entry.accepts(args))
  const mode = entry.argMode || "none"
  if (mode === "optional") return true
  if (mode === "required") return args.length > 0
  return args.length === 0
}

/**
 * 找出该处理这行输入的命令。
 * @returns {{entry: object, name: string, args: string} | null}
 */
export function resolveCommand(normalized, commands) {
  const parts = splitCommandLine(normalized)
  if (!parts || !parts.name) return null
  for (const entry of commands) {
    if (!entry.names.includes(parts.name)) continue
    if (!acceptsArgs(entry, parts.args)) return null
    return { entry, name: parts.name, args: parts.args }
  }
  return null
}

/**
 * 派生补全目录。取代手写的 `BUILTIN_SLASH`。
 *
 * 缺省每个命令贡献一行（主名 + desc）。别名默认**不占**目录条目 —— 它们由
 * `DEFAULT_SLASH_ALIASES` 或同一分支展开，列出来只会让菜单变长。少数别名值得
 * 单独露出（`/cls`、`/home`、`/coding`、`/longagent`），那些在 entry 里用
 * `catalog` 显式写出来。
 */
export function buildBuiltinSlashCatalog(commands) {
  const rows = []
  for (const entry of commands) {
    if (entry.hidden) continue
    if (Array.isArray(entry.catalog)) {
      for (const row of entry.catalog) rows.push({ name: row.name, desc: row.desc })
      continue
    }
    rows.push({ name: entry.names[0], desc: entry.desc })
  }
  return rows
}

/** 所有能触发命令的名字（含别名）。用于测试与自检。 */
export function allCommandNames(commands) {
  const names = new Set()
  for (const entry of commands) for (const name of entry.names) names.add(name)
  return names
}
