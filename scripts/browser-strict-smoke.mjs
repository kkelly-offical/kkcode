// Acceptance only. This deliberately cannot turn a root/no-sandbox fixture into
// a successful strict-isolation receipt. No sysctl, AppArmor or SUID changes.
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { createBrowserController } from '../src/kernel/browser/controller.mjs'
import { createDockerExecutionBackend, markStrictBuiltinTools } from '../src/kernel/isolation/docker-executor.mjs'

const SECRET_NAME = 'KKCODE_STRICT_BROWSER_PRIVATE_CANARY'
const forbiddenFlags = new Set(['--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox', '--single-process', '--in-process-gpu', '--no-zygote'])
const blocked = (code, message) => Object.assign(new Error(message), { code, blocked: true })

export function strictBrowserPreflight({ platform = process.platform, uid = process.getuid?.(), image = process.env.KKCODE_STRICT_TEST_IMAGE } = {}) {
  if (platform !== 'linux') throw blocked('linux_required', '严格 Browser 验收仅支持 Linux /proc 证据；当前平台未验收。')
  if (!Number.isSafeInteger(uid) || uid <= 0) throw blocked('non_root_required', '必须以普通 Linux 用户运行，且 Chromium 沙箱可用；root 功能测试不能算作严格隔离通过。')
  if (typeof image !== 'string' || !/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64})$/.test(image)) {
    throw blocked('pinned_image_required', '请设置 KKCODE_STRICT_TEST_IMAGE 为本机已有的固定镜像摘要；不接受浮动标签，不自动拉取镜像。')
  }
  return { image, uid }
}

/** Pure verifier: tests cannot substitute for collection from the live process. */
export function verifyChromiumEvidence({ launchOptions, commandLine, environment, renderers, secret }) {
  assert.equal(launchOptions.chromiumSandbox, true, 'Chromium sandbox must be enabled')
  assert.equal(Object.hasOwn(launchOptions.env || {}, SECRET_NAME), false, 'launch environment contains private canary')
  assert.equal(Object.values(launchOptions.env || {}).includes(secret), false)
  assert.ok(Array.isArray(commandLine) && commandLine.length > 1, 'real Chromium command line missing')
  for (const argument of commandLine) assert.equal(forbiddenFlags.has(argument.split('=')[0]), false, 'a real Chromium process disabled sandboxing')
  assert.equal(environment.split('\0').some(item => item.startsWith(`${SECRET_NAME}=`) || item.includes(secret)), false, 'actual Chromium environment inherited private canary')
  assert.ok(renderers.length > 0, 'no actual Chromium renderer was inspected')
  for (const renderer of renderers) {
    assert.match(renderer.status, /^NoNewPrivs:\s+1$/m, 'renderer is missing NoNewPrivs')
    assert.match(renderer.status, /^Seccomp:\s+2$/m, 'renderer is missing kernel seccomp filtering')
    assert.match(renderer.status, /^CapEff:\s+0+$/m, 'renderer retains Linux capabilities')
    for (const argument of renderer.commandLine) assert.equal(forbiddenFlags.has(argument.split('=')[0]), false)
  }
  return { chromiumSandbox: true, forbiddenFlagsAbsent: true, privateEnvironmentAbsent: true, rendererCount: renderers.length, rendererNoNewPrivs: true, rendererSeccomp: 2, rendererCapabilities: 'none' }
}

async function until(check, message, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(50) }
  throw new Error(message)
}

async function processEvidence(context, options, secret) {
  const browser = context.browser()
  if (!browser) throw blocked('process_evidence_unavailable', '无法取得实际浏览器进程身份，严格验收不记为通过。')
  const cdp = await browser.newBrowserCDPSession()
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
    const main = processInfo.find(item => item.type === 'browser')
    const rendererProcesses = processInfo.filter(item => item.type === 'renderer')
    assert.ok(main && rendererProcesses.length, 'live CDP process tree is incomplete')
    assert.equal(await realpath(`/proc/${main.id}/exe`), await realpath(chromium.executablePath()), 'actual process is not the project Chromium binary')
    const read = (pid, file) => readFile(`/proc/${pid}/${file}`, 'utf8')
    const commandLine = (await read(main.id, 'cmdline')).split('\0').filter(Boolean)
    const environment = await read(main.id, 'environ')
    const renderers = await Promise.all(rendererProcesses.map(async item => ({ status: await read(item.id, 'status'), commandLine: (await read(item.id, 'cmdline')).split('\0').filter(Boolean) })))
    const evidence = verifyChromiumEvidence({ launchOptions: options, commandLine, environment, renderers, secret })
    return { evidence, pids: processInfo.map(item => item.id) }
  } finally { await cdp.detach() }
}

export async function runStrictBrowserSmoke({ image = process.env.KKCODE_STRICT_TEST_IMAGE } = {}) {
  const preflight = strictBrowserPreflight({ image })
  if (!await access(chromium.executablePath()).then(() => true, () => false)) throw blocked('chromium_not_installed', '缺少项目锁定的 Playwright Chromium；请先执行项目浏览器安装流程。')
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'kkcode-strict-browser-'))
  const cwd = path.join(fixture, 'workspace'), state = path.join(fixture, 'state')
  const previous = process.env.KKCODE_HOME, previousSecret = process.env[SECRET_NAME]
  const secret = randomUUID()
  process.env.KKCODE_HOME = state; process.env[SECRET_NAME] = secret
  let controller, server, liveContext, launchOptions, profile, launchCount = 0, abortClosed = false, hangRequested = false
  try {
    await mkdir(cwd); await mkdir(state, { mode: 0o700 })
    server = http.createServer((request, response) => {
      if (request.url === '/hang') { hangRequested = true; return }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><title>KK strict Browser fixture</title><h1>Strict fixture ready</h1><button onclick="document.querySelector(\'h1\').textContent=\'Strict click complete\'">Complete fixture</button>')
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    const backend = createDockerExecutionBackend({ image, networkOrigins: [origin] })
    let isolation
    try { isolation = await backend.ensureReady({ cwd, contract: { allowedPaths: [], allowedTools: ['browser'] } }) }
    catch (error) { if (error.code?.startsWith('strict_')) throw blocked(error.code, '固定镜像 Docker 隔离探针未通过；未回退到宿主执行。'); throw error }
    controller = createBrowserController({ launch: async (directory, options) => {
      // Observation only: same binary/options as production; do not add flags.
      launchCount++; launchOptions = options; profile = directory
      assert.equal(options.chromiumSandbox, true)
      assert.equal(options.executablePath, chromium.executablePath())
      liveContext = await chromium.launchPersistentContext(directory, options)
      liveContext.once('close', () => { abortClosed = true })
      return liveContext
    } })
    const [tool] = markStrictBuiltinTools([{ name: 'browser', execute: (args, context) => controller.execute(args, context) }])
    const context = { cwd, sessionId: `strict-fixture-${randomUUID()}`, config: { data_policy: { web_origins: [origin] } } }
    const call = (args, signal) => backend.executeTool({ tool, args, context, signal, invoke: () => { throw new Error('strict Browser must not use a generic host fallback') } })
    let opened
    try { opened = await call({ action: 'open', url: origin }) }
    catch (error) {
      if (error.operationNotStarted && /Browser could not start/.test(error.message)) throw blocked('chromium_sandbox_unavailable', '非 root 环境中的 Chromium 沙箱启动失败；请检查受控 runner 的内核与沙箱支持，不得关闭沙箱代替验收。')
      throw error
    }
    assert.match(opened.output, /Strict fixture ready/)
    assert.equal(opened.metadata.managedNetwork, true)
    assert.match((await call({ action: 'snapshot' })).output, /Complete fixture/)
    assert.match((await call({ action: 'click', role: 'button', name: 'Complete fixture' })).output, /Strict click complete/)
    const screenshot = await call({ action: 'screenshot' })
    const png = Buffer.from(screenshot.content.find(item => item.type === 'image').data, 'base64')
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 800)
    let observed
    try { observed = await processEvidence(liveContext, launchOptions, secret) }
    catch (error) { if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw blocked('process_evidence_unavailable', '无法读取本次 Chromium 的 /proc 沙箱证据，不能将功能测试报告为严格隔离通过。'); throw error }
    // Contract origin denial is verified after a successful browser action.
    await assert.rejects(call({ action: 'open', url: 'http://127.0.0.1:1/outside-contract' }), /策略|origin|来源|目标|允许/i)
    const abort = new AbortController()
    const pending = call({ action: 'open', url: `${origin}/hang` }, abort.signal)
    pending.catch(() => {})
    await until(() => hangRequested, 'cancellation fixture did not receive its navigation')
    abort.abort(new Error('synthetic strict acceptance cancellation'))
    await assert.rejects(pending)
    await until(async () => abortClosed && !await access(profile).then(() => true, () => false), 'cancel did not close the private context and remove its profile')
    await until(async () => (await Promise.all(observed.pids.map(async pid => {
      try { const status = await readFile(`/proc/${pid}/status`, 'utf8'); return /^State:\s+Z/m.test(status) } catch (error) { if (error.code === 'ENOENT') return true; throw error }
    }))).every(Boolean), 'cancel left a live Chromium process')
    assert.deepEqual(await readdir(path.join(state, 'browser')), [])
    assert.equal(launchCount, 1)
    return { status: 'passed', fixture: 'strict-browser', uid: preflight.uid, isolation: { backend: isolation.backend, strict: isolation.strict, imageId: isolation.imageId, shellNetwork: isolation.network }, browser: observed.evidence,
      managedNetwork: true, contractOriginOnly: true, open: true, snapshot: true, click: true, screenshot: { mime: 'image/png', width: 1280, height: 800, sha256: createHash('sha256').update(png).digest('hex') }, cancellation: { contextClosed: true, processesStopped: true, privateProfileRemoved: true }, existingUserProfilesTouched: false }
  } finally {
    await controller?.shutdown()
    server?.closeAllConnections()
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    if (previousSecret === undefined) delete process.env[SECRET_NAME]; else process.env[SECRET_NAME] = previousSecret
    await rm(fixture, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write('Strict Browser acceptance: Linux non-root + sandboxed project Chromium + local immutable Docker image.\nKKCODE_STRICT_TEST_IMAGE=sha256:<64 hex> node scripts/browser-strict-smoke.mjs\nExit: 0 passed, 2 blocked (not accepted), 1 failed. No sandbox/sysctl/AppArmor/SUID changes.\n')
  } else {
    try { process.stdout.write(`${JSON.stringify(await runStrictBrowserSmoke())}\n`) }
    catch (error) {
      process.stdout.write(`${JSON.stringify({ status: error.blocked ? 'blocked' : 'failed', fixture: 'strict-browser', code: error.code || 'acceptance_failed', message: error.blocked ? error.message : '严格 Browser 验收断言失败；未报告隔离成功。', ...(error.blocked ? {} : { assertion: error.code === 'ERR_ASSERTION' ? error.message.slice(0, 400) : undefined }) })}\n`)
      process.exitCode = error.blocked ? 2 : 1
    }
  }
}
