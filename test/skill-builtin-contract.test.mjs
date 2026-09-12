import test from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

/**
 * 内置技能的调用契约。
 *
 * SkillRegistry.execute 以**单个 ctx 对象**调用 skill.run({ args, cwd, mode,
 * model, provider, config })。commit.mjs 曾写成 run(args, context = {})：
 * 整个 ctx 落进第一个参数，context 恒为 {}，于是 hasGitAuto 恒为 true ——
 * 用户的 git_auto 配置对该技能完全无效，且没有任何报错。
 *
 * 清单不手写：枚举 builtin 目录下的全部 .mjs，逐个断言 run 的参数个数
 * ≤ 1 —— 新技能写错签名会在这里立刻红。
 */

const BUILTIN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "src", "kernel", "skill", "builtin"
)

test("every builtin skill declares exactly one ctx parameter", async () => {
  const entries = (await readdir(BUILTIN_DIR)).filter((name) => name.endsWith(".mjs"))
  assert.ok(entries.length > 0, "builtin 技能目录不该为空")
  for (const name of entries) {
    const filePath = path.join(BUILTIN_DIR, name)
    const mod = await import(pathToFileURL(filePath).href)
    if (typeof mod.run !== "function") continue
    // Function.length 抓不住原 bug：run(args, context = {}) 的 length 也是 1。
    // 这些内置模块本来就是直接发布的 ESM，因此检查其实际声明而不是
    // 运行时 arity，才能把第二参数、rest 参数和错名的 args 当场拦住。
    const source = await readFile(filePath, "utf8")
    const signature = source.match(/export\s+(?:async\s+)?function\s+run\s*\(([^)]*)\)/)
    assert.ok(signature, `${name} 必须用可审计的 export function run(ctx) 声明`)
    assert.match(
      signature[1].trim(),
      /^ctx(?:\s*=\s*\{\})?$/,
      `${name} 的 run() 必须只接收 ctx；实际声明为 (${signature[1]})`
    )
  }
})

test("commit skill actually reads git_auto config from ctx", async () => {
  const { run } = await import(pathToFileURL(path.join(BUILTIN_DIR, "commit.mjs")).href)

  const withGitAuto = await run({ args: "", config: { git_auto: { enabled: true } } })
  assert.match(withGitAuto, /Git Auto Mode Enabled/)

  // 修复前：config 落不进函数体，这里仍会输出 Git Auto 分支
  const withoutGitAuto = await run({ args: "", config: { git_auto: { enabled: false } } })
  assert.match(withoutGitAuto, /Standard Mode/)
  assert.doesNotMatch(withoutGitAuto, /Git Auto Mode Enabled/)
})
