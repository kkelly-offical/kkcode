import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { findBoundaryViolations, findKernelStdoutViolations, parseBoundarySpecifiers } from "../scripts/check-boundaries.mjs"

/**
 * 分层边界归零防回归（1.0.0 阶段 4，docs/architecture-kernel-sdk-1.0.0.md
 * §3/§4.2.2 的完成判据 2）。
 *
 * 阶段 4a 把 frontends（repl.mjs、repl/、ui/、commands/、cli/）对内核的
 * 残余 deep-import 全部收敛到 src/kernel/index.mjs facade；这个测试用
 * scripts/check-boundaries.mjs 的同一套扫描断言边数停在 0，并钉住扫描器
 * 自身不失效（假绿是结构检查最大的风险 —— session-import-cycle 同款教训）。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

test("frontends -> kernel 内部文件 import 边数为 0，kernel -> frontends 边数为 0", async () => {
  const { violations, unresolved } = await findBoundaryViolations(ROOT)
  assert.deepEqual(
    unresolved.filter((u) => u.from.startsWith("src/repl") || u.from.startsWith("src/ui/")
      || u.from.startsWith("src/commands/") || u.from.startsWith("src/cli/") || u.from.startsWith("src/kernel/")),
    [],
    "存在解析失败的相对 import，边界图不完整（漏边会造成假绿）"
  )
  assert.deepEqual(
    violations,
    [],
    `分层边界被重新腐蚀：\n${violations.map((v) => `  [${v.rule}] ${v.from} -> ${v.to}`).join("\n")}`
  )
})

test("扫描器三种 import 形态都看得见 —— 防止扫描器静默失效造成假绿", async () => {
  const specs = parseBoundarySpecifiers([
    `import { a } from "../kernel/session/store.mjs"`,
    `export { b } from "../kernel/core/modes.mjs"`,
    `const { c } = await import("../kernel/session/engine.mjs")`,
    // review round 1 P2-1：行中形态（return/if 后的动态 import）在旧的行首
    // 锚定版本下整条逃逸，必须能抓到
    `export async function f() { return await import("../kernel/session/store.mjs") }`,
    `if (cond) await import("../kernel/provider/router.mjs")`,
    `// import { fake } from "../kernel/comment-literal.mjs"`,
    `// return await import("../kernel/comment-dynamic.mjs")`,
    // 模板字符串里的文档示例不是边（src/kernel/skill/builtin/frontend.mjs 的
    // Vue/React 路由示例就是这种形态，实测会命中无锚动态规则）
    "const doc = `- Lazy-load pages: () => import('../views/About.vue')`",
    `const text = "import(\\"../kernel/string-literal.mjs\\")"`
  ].join("\n"))
  assert.deepEqual(specs, [
    "../kernel/session/store.mjs",
    "../kernel/core/modes.mjs",
    "../kernel/session/engine.mjs",
    "../kernel/session/store.mjs",
    "../kernel/provider/router.mjs"
  ], "静态/再导出/动态（含行中形态）必须全部提取，注释与字符串字面量不得算边")

  // 端到端：在一棵假树上同时种正/反向违规与一条 facade 白名单边，
  // 违规必须逐条命中、白名单必须豁免。
  const fake = await mkdtemp(path.join(tmpdir(), "kkcode-boundary-"))
  try {
    await mkdir(path.join(fake, "src/repl"), { recursive: true })
    await mkdir(path.join(fake, "src/kernel/session"), { recursive: true })
    await mkdir(path.join(fake, "src/ui"), { recursive: true })
    await writeFile(path.join(fake, "src/kernel/index.mjs"), `export {}`)
    await writeFile(path.join(fake, "src/kernel/session/store.mjs"), `export {}`)
    await writeFile(path.join(fake, "src/repl/ok.mjs"),
      `import { x } from "../kernel/index.mjs"\nexport { x }\n`)
    await writeFile(path.join(fake, "src/repl/bad.mjs"),
      `import { y } from "../kernel/session/store.mjs"\nexport { y }\n`)
    // review round 1 P2-1 的种植形态：行中 return await import（行首锚定会漏）
    await writeFile(path.join(fake, "src/ui/bad-dynamic.mjs"),
      `export async function load() {\n  return await import("../kernel/session/store.mjs")\n}\n`)
    await writeFile(path.join(fake, "src/kernel/session/reverse.mjs"),
      `import { w } from "../../ui/bad-dynamic.mjs"\nexport { w }\n`)

    const { violations } = await findBoundaryViolations(fake)
    assert.deepEqual(
      violations.map((v) => `${v.rule}:${v.from}->${v.to}`).sort(),
      [
        "frontends->kernel-internal:src/repl/bad.mjs->src/kernel/session/store.mjs",
        "frontends->kernel-internal:src/ui/bad-dynamic.mjs->src/kernel/session/store.mjs",
        "kernel->frontends:src/kernel/session/reverse.mjs->src/ui/bad-dynamic.mjs"
      ],
      "假树上的三条违规边必须逐条命中"
    )
  } finally {
    await rm(fake, { recursive: true, force: true })
  }
})

test("kernel 输出纪律：src/kernel/ 直写 stdout 的调用为 0（架构 §4.2.3，阶段 5）", async () => {
  const violations = await findKernelStdoutViolations(ROOT)
  assert.deepEqual(
    violations,
    [],
    `kernel 出现 stdout 直写（用户可见输出必须走 kernel.events）：\n${violations.map((v) => `  ${v.file}:${v.line} ${v.match}`).join("\n")}`
  )
})

test("输出纪律扫描器看得见种植违规、放行 stderr 与 isTTY —— 防扫描器静默失效", async () => {
  const fake = await mkdtemp(path.join(tmpdir(), "kkcode-stdout-discipline-"))
  try {
    await mkdir(path.join(fake, "src/kernel/core"), { recursive: true })
    await writeFile(path.join(fake, "src/kernel/core/clean.mjs"), [
      `export function ok() {`,
      `  console.error("diagnostic to stderr — allowed")`,
      `  console.warn("also allowed")`,
      `  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY) // 读取不是写`,
      `  // console.log("commented out is not a write")`,
      "  const doc = `docs mention console.log(x) inside a template — not a call`",
      `  return tty`,
      `}`
    ].join("\n"))
    await writeFile(path.join(fake, "src/kernel/core/bad.mjs"), [
      `export function bad() {`,
      `  console.log("planted")`,
      `    process.stdout.write("planted")`,
      `  console.info("planted")`,
      `}`
    ].join("\n"))

    const violations = await findKernelStdoutViolations(fake)
    assert.deepEqual(
      violations.map((v) => `${v.file}:${v.line}:${v.match}`),
      [
        "src/kernel/core/bad.mjs:2:console.log",
        "src/kernel/core/bad.mjs:3:process.stdout.write",
        "src/kernel/core/bad.mjs:4:console.info"
      ],
      "种植的三处 stdout 直写必须逐条命中；stderr 诊断、isTTY 读取、行注释与模板字符串里的字样不得算违规"
    )
  } finally {
    await rm(fake, { recursive: true, force: true })
  }
})
