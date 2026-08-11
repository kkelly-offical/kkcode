import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { ToolRegistry } from "../src/tool/registry.mjs"

const yoloConfig = {
  permission: { level: "yolo", rules: [] },
  tool: {},
  git: { auto: { enabled: false } }
}

const registryConfig = {
  ...yoloConfig,
  tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }
}

async function runBashTool(args, cwd, extraCtx = {}) {
  await ToolRegistry.initialize({ config: registryConfig, cwd, force: true, allowProjectSources: false })
  return ToolRegistry.call("bash", args, { cwd, config: yoloConfig, ...extraCtx })
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-bash-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("bash reports non-zero exit codes", async () => {
  await withTempDir(async (dir) => {
    const out = (await runBashTool({ command: "exit 3" }, dir)).output
    // 此前 exitCode 被 catch 整个吞掉，模型无法区分「命令失败」与
    // 「命令成功但往 stderr 写了进度」—— 后者在 npm/pip/git 里极常见
    assert.match(String(out), /\[exit 3\]/)
  })
})

test("bash stays silent about exit code on success", async () => {
  await withTempDir(async (dir) => {
    const out = (await runBashTool({ command: "echo hello" }, dir)).output
    assert.match(String(out), /hello/)
    assert.doesNotMatch(String(out), /\[exit/)
  })
})

test("bash accepts a cwd inside the workspace", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "sub"), { recursive: true })
    const out = (await runBashTool({ command: "pwd", cwd: "sub" }, dir)).output
    assert.match(String(out), /sub/)
  })
})

test("bash rejects a cwd that escapes the workspace", async () => {
  await withTempDir(async (dir) => {
    // cwd 不过 resolveWorkspacePath 的话，`../..` 就能把整个工作区边界抬走，
    // 之后所有相对路径判定都在错误的根下做
    const result = await runBashTool({ command: "pwd", cwd: "../.." }, dir)
    assert.equal(result.status, "error", "越界 cwd 必须被拒")
  })
})

test("bash passes per-command env vars", async () => {
  await withTempDir(async (dir) => {
    const cmd = process.platform === "win32" ? "echo %KK_PROBE%" : "echo $KK_PROBE"
    const out = (await runBashTool({ command: cmd, env: { KK_PROBE: "probe-value" } }, dir)).output
    assert.match(String(out), /probe-value/)
  })
})

test("bash ignores malformed env keys instead of failing", async () => {
  await withTempDir(async (dir) => {
    const out = (await runBashTool({ command: "echo ok", env: { "bad key": "x", "PATH;rm": "y" } }, dir)).output
    assert.match(String(out), /ok/)
  })
})

test("long-running commands are blocked in the foreground but allowed in background", async () => {
  await withTempDir(async (dir) => {
    const foreground = (await runBashTool({ command: "npm run dev" }, dir)).output
    assert.match(String(foreground), /\[blocked\]/)
    // 前台的拦截提示原文就是「或者用 run_in_background: true」
    assert.match(String(foreground), /run_in_background/)

    // 而后台此前也拦 —— 文档承诺的唯一逃生口在代码里被堵死，
    // 模型照提示改参数后拿到的还是 blocked
    const background = (await runBashTool({ command: "npm run dev", run_in_background: true }, dir)).output
    assert.doesNotMatch(String(background), /\[blocked\]/)
    assert.match(String(background), /background task launched/)
  })
})

test("bash output truncation follows the context budget and says how to get more", async () => {
  await withTempDir(async (dir) => {
    const cmd = process.platform === "win32"
      ? 'node -e "process.stdout.write(\'x\'.repeat(20000))"'
      : "node -e \"process.stdout.write('x'.repeat(20000))\""
    const out = (await runBashTool({ command: cmd }, dir, { toolResultLimit: 5000 })).output
    const text = String(out)
    assert.ok(text.length < 20000, "应按 toolResultLimit 截断，而非硬编码 30000")
    // 截断必须带下一步动作，否则模型会把截断当完整输出用
    assert.match(text, /Showing|truncat/i)
  })
})

// ---------------------------------------------------------------------------
// 长驻命令判定。vitest 的旧正则 /\bvitest(?!\s+--run)\b.*(?!--run)/i 尾部的
// (?!--run) 跟在贪婪 .* 之后恒真（空洞断言），一次性命令 `vitest --coverage
// --run` 会被误判成长驻并拦截。这里按「一次性形态必须放行、watch 形态必须拦」
// 两侧同时钉住。
// ---------------------------------------------------------------------------
test("long-running detection: watch-mode vitest is blocked, one-shot vitest is not", async () => {
  const { isLongRunningCommand } = await import("../src/tool/registry.mjs")

  // watch 形态（默认长驻）—— 必须判长驻
  assert.equal(isLongRunningCommand("vitest"), true)
  assert.equal(isLongRunningCommand("npx vitest"), true)
  assert.equal(isLongRunningCommand("vitest watch"), true)
  assert.equal(isLongRunningCommand("vitest --coverage"), true)
  assert.equal(isLongRunningCommand("bash -lc 'vitest'"), true)
  assert.equal(isLongRunningCommand("env -u CI vitest"), true)
  assert.equal(isLongRunningCommand(String.raw`C:\repo\node_modules\.bin\vitest.cmd`), true)
  assert.equal(isLongRunningCommand("npm run vitest"), true)
  assert.equal(isLongRunningCommand("npx vitest@latest"), true)
  assert.equal(isLongRunningCommand("pwsh -Command vitest"), true)
  assert.equal(isLongRunningCommand("powershell -c 'vitest'"), true)
  assert.equal(isLongRunningCommand("vitest --project run"), true)
  assert.equal(isLongRunningCommand("vitest --config list"), true)
  assert.equal(isLongRunningCommand("vitest --root run"), true)
  assert.equal(isLongRunningCommand("vitest --mode run"), true)
  assert.equal(isLongRunningCommand("vitest -r run"), true)
  assert.equal(isLongRunningCommand("vitest --attachmentsDir list"), true)
  assert.equal(isLongRunningCommand("time vitest"), true)
  assert.equal(isLongRunningCommand("sudo -u nobody vitest"), true)
  assert.equal(isLongRunningCommand("nice -n 5 vitest"), true)
  assert.equal(isLongRunningCommand("nohup vitest"), true)
  assert.equal(isLongRunningCommand("cross-env CI=1 vitest"), true)
  assert.equal(isLongRunningCommand("npx cross-env CI=1 vitest"), true)
  assert.equal(isLongRunningCommand("stdbuf -o L vitest"), true)
  assert.equal(isLongRunningCommand("cross-env-shell CI=1 'vitest'"), true)
  assert.equal(isLongRunningCommand("cmd /c npx vitest"), true)
  assert.equal(isLongRunningCommand("cmd /c call vitest"), true)
  assert.equal(isLongRunningCommand("cmd /k vitest run"), true)
  assert.equal(isLongRunningCommand("cmd /k call vitest --run"), true)
  assert.equal(isLongRunningCommand("vitest --coverage.include init"), true)
  assert.equal(isLongRunningCommand("vitest --api.host list"), true)
  assert.equal(isLongRunningCommand("yarn run vitest"), true)
  assert.equal(isLongRunningCommand("pnpm run vitest"), true)
  assert.equal(isLongRunningCommand("bun run vitest"), true)
  assert.equal(isLongRunningCommand("xvfb-run -a vitest"), true)
  assert.equal(isLongRunningCommand("node ./node_modules/vitest/vitest.mjs"), true)

  // 一次性形态 —— 必须放行
  assert.equal(isLongRunningCommand("vitest run"), false)
  assert.equal(isLongRunningCommand("vitest --run"), false)
  assert.equal(isLongRunningCommand("vitest --coverage --run"), false)
  assert.equal(isLongRunningCommand("npx vitest run --coverage"), false)
  assert.equal(isLongRunningCommand("vitest.cmd run --coverage"), false)
  assert.equal(isLongRunningCommand("vitest --watch=false"), false)
  assert.equal(isLongRunningCommand("vitest list"), false)
  assert.equal(isLongRunningCommand("vitest --help"), false)
  assert.equal(isLongRunningCommand("vitest --version"), false)
  assert.equal(isLongRunningCommand("bash -lc 'vitest run'"), false)
  assert.equal(isLongRunningCommand("env -u CI vitest run"), false)
  assert.equal(isLongRunningCommand(String.raw`C:\repo\node_modules\.bin\vitest.cmd run`), false)
  assert.equal(isLongRunningCommand("npx -p vitest vitest run"), false)
  assert.equal(isLongRunningCommand("npx --package vitest vitest run"), false)
  assert.equal(isLongRunningCommand("npm run vitest -- --run"), false)
  assert.equal(isLongRunningCommand("npx vitest@latest run"), false)
  assert.equal(isLongRunningCommand("pwsh -Command vitest --run"), false)
  assert.equal(isLongRunningCommand("powershell -c 'vitest run'"), false)
  assert.equal(isLongRunningCommand("vitest --project unit run"), false)
  assert.equal(isLongRunningCommand("vitest --config ./vitest.config.mjs list"), false)
  assert.equal(isLongRunningCommand("cmd /c vitest --run"), false)
  assert.equal(isLongRunningCommand("cmd /s /c vitest run"), false)
  assert.equal(isLongRunningCommand("time vitest --run"), false)
  assert.equal(isLongRunningCommand("sudo vitest run"), false)
  assert.equal(isLongRunningCommand("nice vitest run"), false)
  assert.equal(isLongRunningCommand("nohup vitest --run"), false)
  assert.equal(isLongRunningCommand("cross-env CI=1 vitest run"), false)
  assert.equal(isLongRunningCommand("npx cross-env CI=1 vitest run"), false)
  assert.equal(isLongRunningCommand("npx cross-env@latest CI=1 vitest --run"), false)
  assert.equal(isLongRunningCommand("stdbuf -o L vitest run"), false)
  assert.equal(isLongRunningCommand("nohup nice -n 5 stdbuf --output L cross-env CI=1 vitest --run"), false)
  assert.equal(isLongRunningCommand("cross-env-shell CI=1 'vitest --run'"), false)
  assert.equal(isLongRunningCommand("vitest init"), false)
  assert.equal(isLongRunningCommand("vitest related src/app.mjs"), false)
  assert.equal(isLongRunningCommand("vitest --clearCache"), false)
  assert.equal(isLongRunningCommand("vitest --listTags"), false)
  assert.equal(isLongRunningCommand("cmd /c call vitest --run"), false)
  // cmd.exe does not treat # as a comment, so the explicit --run still wins.
  assert.equal(isLongRunningCommand("cmd /c vitest # --run"), false)
  assert.equal(isLongRunningCommand("yarn run vitest run"), false)
  assert.equal(isLongRunningCommand("pnpm run vitest -- run"), false)
  assert.equal(isLongRunningCommand("bun run vitest --run"), false)
  assert.equal(isLongRunningCommand("xvfb-run --server-args '-screen 0 1280x720x24' vitest run"), false)
  assert.equal(isLongRunningCommand("node --no-warnings ./node_modules/vitest/vitest.mjs --run"), false)
  assert.equal(isLongRunningCommand("node ./node_modules/other/vitest-runner.mjs"), false)
  assert.equal(isLongRunningCommand("vitest -- run"), true)

  // 一次性参数只能影响它所在的 vitest 命令段，不能穿过 shell 分隔符。
  assert.equal(isLongRunningCommand("vitest; echo --run"), true)
  assert.equal(isLongRunningCommand("vitest && printf -- --run"), true)
  // POSIX shell 里 # 后面是注释，不能影响前面这个 vitest 进程；
  // Windows 的实际执行面是 cmd.exe，裸 # 则是普通 argv 内容。
  assert.equal(isLongRunningCommand("vitest # --run"), process.platform !== "win32")
  assert.equal(isLongRunningCommand("echo --run | vitest"), true)

  // 显式 watch 与 false 布尔值的优先级不能靠子串猜。
  assert.equal(isLongRunningCommand("vitest --run=false"), true)
  assert.equal(isLongRunningCommand("vitest --run --watch"), true)
  assert.equal(isLongRunningCommand("vitest run --watch=true"), true)
  assert.equal(isLongRunningCommand("vitest --help --watch"), false)

  // 邻近模式回归锚：别的 watch 判定不受本次改动影响
  assert.equal(isLongRunningCommand("jest --watch"), true)
  assert.equal(isLongRunningCommand("tsc --watch"), true)
  assert.equal(isLongRunningCommand("npm test"), false)
})
