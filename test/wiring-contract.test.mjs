import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

/**
 * 接线契约：安全参数必须真的传到调用点。
 *
 * 这类缺陷在本仓库已经出现四次，每次都长得一模一样 —— 函数层改对了、
 * 测试从函数层直接调所以全绿、而生产调用点没接上：
 *
 *   0.5.0  PermissionEngine.setTrusted 在后台 worker 从未被调用
 *   0.6.2  checkBashAllowed 的 approvalLevel 两个调用点都没传（本次修复）
 *   0.6.2  write_scope 判定的能力名 "write" 根本不在返回值域里
 *   0.6.0  agent.prompt 的生产路径读的是另一个函数，测试覆盖的是死路径
 *
 * 靠记性防不住，只能靠结构性检查。这个测试很粗糙 —— 它做的是文本扫描 ——
 * 但正是「下一个漏网点」需要的那种检查。
 *
 * 有意不传时，在调用点附近写 `approvalLevel: 有意不传` 说明理由即可豁免。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "src")

function sourceFiles(dir = SRC, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (entry.endsWith(".mjs")) acc.push(full)
  }
  return acc
}

const FILES = sourceFiles().map((file) => ({
  // 归一化成正斜杠：path.relative 在 Windows 上产生反斜杠，而下面所有比对
  // 都写的是 "src/permission/rules.mjs" 这种字面量 —— 不归一化的话整个
  // 扫描器在 Windows 上静默失效（find 返回 undefined、endsWith 永不命中）。
  // 0.5.4 的 stage-objective 测试栽在同一个地方，verify 矩阵红了四个版本。
  path: path.relative(ROOT, file).split(path.sep).join("/"),
  text: readFileSync(file, "utf8")
}))

/** 调用点前后若干行内出现「有意不传」的说明即视为显式豁免 */
function hasIntentionalOptOut(text, index, param) {
  const window = text.slice(Math.max(0, index - 600), index + 200)
  return window.includes(`${param}: 有意不传`) || window.includes(`${param}: intentionally omitted`)
}

describe("安全参数必须传到调用点", () => {
  it("checkBashAllowed 的每个生产调用点都传 approvalLevel（或显式声明不传）", () => {
    const missing = []
    for (const file of FILES) {
      if (file.path.endsWith("exec-policy.mjs")) continue   // 定义处
      const pattern = /checkBashAllowed\s*\(/g
      let match
      while ((match = pattern.exec(file.text)) !== null) {
        // 取这次调用的完整实参片段（到配对括号为止，够用即可）
        const tail = file.text.slice(match.index, match.index + 400)
        const call = tail.slice(0, tail.indexOf("\n\n") >= 0 ? tail.indexOf("\n\n") : 400)
        if (call.includes("approvalLevel")) continue
        if (hasIntentionalOptOut(file.text, match.index, "approvalLevel")) continue
        missing.push(`${file.path}: ${call.split("\n")[0].trim()}`)
      }
    }
    assert.deepEqual(missing, [], `以下调用点没有传审批档：\n${missing.join("\n")}`)
  })

  it("PermissionEngine.setTrusted 在每个进程入口都被调用", () => {
    // worker 是独立进程，模块级 trusted 标志默认 false —— 不设置的话
    // 它的每次工具调用都会被拒（0.5.8 修的就是这个）
    const entryPoints = ["src/orchestration/background-worker.mjs", "src/repl.mjs", "src/commands/chat.mjs"]
    for (const entry of entryPoints) {
      const file = FILES.find((f) => f.path === entry)
      assert.ok(file, `找不到入口文件 ${entry}`)
      assert.match(file.text, /setTrusted\(/, `${entry} 从未设置权限引擎的信任标志`)
    }
  })
})

describe("判定用的字符串必须真的可能出现", () => {
  it("按能力名做的判定，所用的能力名必须在 toolCapability 的返回值域里", () => {
    // 0.6.2 的 write_scope 判定用了 "write"，而 toolCapability 永远不返回它 ——
    // 半个条件是死值，且真正的漏洞（bash）没被覆盖。
    const rules = FILES.find((f) => f.path === "src/permission/rules.mjs")
    assert.ok(rules)
    const domain = new Set(
      [...rules.text.matchAll(/return\s+"([a-z-]+)"/g)].map((m) => m[1])
    )
    // TOOL_CAPABILITIES 的值也算在值域内
    for (const m of rules.text.matchAll(/:\s*"([a-z-]+)"/g)) domain.add(m[1])

    for (const file of FILES) {
      for (const m of file.text.matchAll(/\[([^\]]*)\]\.includes\(\s*toolCapability\(/g)) {
        const names = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1])
        for (const name of names) {
          assert.ok(
            domain.has(name),
            `${file.path} 用 "${name}" 与 toolCapability 比较，但它不在返回值域里（死值）`
          )
        }
      }
    }
  })
})

test("被扫描的源文件数量合理 —— 防止扫描器自己失效", () => {
  assert.ok(FILES.length > 100, `只扫到 ${FILES.length} 个源文件，扫描器可能坏了`)
})

test("路径一律用正斜杠 —— 否则整个扫描器在 Windows 上静默失效", () => {
  // 这条断言的存在是因为它已经发生过：本文件第一版用 path.relative 的原始
  // 输出与 "src/permission/rules.mjs" 这类字面量比对，Windows 下反斜杠让
  // find 恒返回 undefined、endsWith 恒不命中 —— 扫描器不报错，只是什么都
  // 查不到。同一个坑 0.5.4 的 stage-objective 测试也栽过，红了四个版本。
  const withBackslash = FILES.filter((f) => f.path.includes("\\"))
  assert.deepEqual(withBackslash.map((f) => f.path), [], "路径里不该出现反斜杠")

  // 关键的几个锚点必须真的能命中，而不是恰好没人用
  for (const anchor of ["src/permission/rules.mjs", "src/session/loop.mjs", "src/tool/registry.mjs"]) {
    assert.ok(FILES.some((f) => f.path === anchor), `锚点 ${anchor} 没被扫到`)
  }
})
