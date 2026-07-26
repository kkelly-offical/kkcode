import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { buildBuiltinSlashCatalog, allCommandNames } from "../src/repl/commands/registry.mjs"
import { sessionCommands } from "../src/repl/commands/session.mjs"
import { providerCommands } from "../src/repl/commands/provider.mjs"
import { permissionCommands } from "../src/repl/commands/permission.mjs"
import { modeCommands } from "../src/repl/commands/mode.mjs"
import { authoringCommands } from "../src/repl/commands/authoring.mjs"

/**
 * 补全目录与实际分发必须同源。
 *
 * 0.6.0 这条测试是**扫源码正则**：`BUILTIN_SLASH` 是手写数组，分发是
 * `processInputLine` 里 49 个顺序 `if`，两份清单各写各的，`/board`、`/cls`、
 * `/home`、`/yolo` 等八条就这样一直能执行、却从不出现在补全里。当时只能用
 * 静态扫描去比对两份清单。
 *
 * 现在目录由注册表派生，漂移在结构上不可能发生 —— 所以这个文件要守的性质变了：
 * **repl.mjs 不许再手写一份目录**。真正的目录内容与分发一致性由
 * `test/repl-commands.test.mjs` 用行为断言覆盖。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const replSource = readFileSync(path.join(ROOT, "src", "repl.mjs"), "utf8")

const ALL = [
  ...sessionCommands,
  ...providerCommands,
  ...permissionCommands,
  ...modeCommands,
  ...authoringCommands
]

test("the catalog in repl.mjs is derived, not hand-written", () => {
  const assignment = replSource.match(/const BUILTIN_SLASH = ([^\n]*)/)
  assert.ok(assignment, "repl.mjs 应该仍然有 BUILTIN_SLASH（补全菜单读它）")
  assert.match(assignment[1], /buildBuiltinSlashCatalog\(/,
    "BUILTIN_SLASH 必须由注册表派生。手写数组会重新引入「目录与分发两份清单」的漂移。")
  assert.doesNotMatch(assignment[1], /^\s*\[/,
    "BUILTIN_SLASH 不该是字面数组")
})

test("repl.mjs no longer dispatches commands by a chain of string comparisons", () => {
  // 拆分前是 49 个 `normalized === "/x"` / `startsWith("/x ")`。命令搬进注册表后
  // 这些判断不该再回到 repl.mjs —— 回来一条就意味着一条命令绕过了目录。
  const comparisons = [
    ...replSource.matchAll(/normalized\s*===\s*"\/[a-z-]+"/g),
    ...replSource.matchAll(/normalized\.startsWith\("\/[a-z-]+\s/g)
  ].map((m) => m[0])
  assert.deepEqual(comparisons, [],
    `repl.mjs 里出现了绕过注册表的命令判断:\n  ${comparisons.join("\n  ")}`)
})

test("the derived catalog covers every command that is meant to be discoverable", () => {
  const catalog = buildBuiltinSlashCatalog(ALL)
  const names = allCommandNames(ALL)
  assert.ok(catalog.length > 20, `目录看起来是空的: ${catalog.length}`)
  for (const row of catalog) {
    assert.ok(names.has(row.name), `目录里的 /${row.name} 没有命令能执行`)
  }
})
