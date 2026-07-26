import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

/**
 * 0.6.0：补全菜单与实际分发必须同源。
 *
 * BUILTIN_SLASH（补全目录）和 processInputLine 里的一长串 if（实际分发）
 * 是两份各写各的清单。加命令时只改分发是最自然的疏忽 —— /board、/cls、
 * /home、/yolo 等八条就这样一直能执行、却从不出现在补全里。
 *
 * 静态扫描很粗糙，但正是这种「下一个漏网点」需要的那类结构性检查。
 */

const replPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "repl.mjs")
const source = readFileSync(replPath, "utf8")

function declaredCommands() {
  const block = source.slice(source.indexOf("const BUILTIN_SLASH = ["), source.indexOf("]", source.indexOf("const BUILTIN_SLASH = [")))
  return new Set([...block.matchAll(/\{ name: "([a-z-]+)"/g)].map((m) => m[1]))
}

function dispatchedCommands() {
  const found = new Set()
  for (const m of source.matchAll(/normalized === "\/([a-z-]+)"/g)) found.add(m[1])
  for (const m of source.matchAll(/normalized\.startsWith\("\/([a-z-]+)[ "]/g)) found.add(m[1])
  // 数组形式里混着 "/?" 这类非字母别名，逐项取而不是要求整个数组同构，
  // 否则 ["/help", "/h", "/?"] 会因为最后一项而整条漏掉。
  for (const m of source.matchAll(/\[\s*("\/[^\]]+?")\s*\]\.includes\(normalized\)/g)) {
    for (const item of m[1].matchAll(/"\/([a-z-]+)"/g)) found.add(item[1])
  }
  return found
}

// 别名由 DEFAULT_SLASH_ALIASES 或同一分支展开，不必单独占一条补全项
const ALIAS_ONLY = new Set(["h", "n", "s", "k", "r", "m", "p", "q", "quit", "cls"])

test("every dispatched slash command appears in the completion catalog", () => {
  const declared = declaredCommands()
  const dispatched = dispatchedCommands()
  assert.ok(declared.size > 20, `catalog looks empty: ${declared.size}`)
  assert.ok(dispatched.size > 20, `dispatch scan looks empty: ${dispatched.size}`)

  const missing = [...dispatched].filter((name) => !declared.has(name) && !ALIAS_ONLY.has(name)).sort()
  assert.deepEqual(missing, [], `可执行但不在补全目录里: ${missing.join(", ")}`)
})

test("the catalog does not advertise commands that cannot run", () => {
  const declared = declaredCommands()
  const dispatched = dispatchedCommands()
  const phantom = [...declared].filter((name) => !dispatched.has(name)).sort()
  assert.deepEqual(phantom, [], `补全里有但分发不认的命令: ${phantom.join(", ")}`)
})
