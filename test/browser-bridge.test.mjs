import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { authorizeBrowserBridge, revokeBrowserBridge, createBrowserBridgeController } from '../src/kernel/browser/bridge.mjs'
import { bridgeProcessEnvironment, validateBridgeLock, BRIDGE_PACKAGE, BRIDGE_VERSION, BRIDGE_INTEGRITY, browserBridgeStatus } from '../src/kernel/browser/bridge-runtime.mjs'

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-bridge-test-'))
  const old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = directory
  t.after(async () => { if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(directory, { recursive: true, force: true }) })
  const calls = [], page = { url: 'https://approved.test/app', line: '- button "Save" [ref=e1]', tabs: '- 0: (current) [App](https://approved.test/app)\n- 1: [Second](https://approved.test/second)\n- 2: [Secret](https://outside.test/private)' }
  let closed = 0, connections = 0
  const controller = createBrowserBridgeController({ connect: async () => {
    connections++
    return { close: async () => { closed++ }, call: async (name, args) => {
      calls.push({ name, args })
      if (name === 'browser_snapshot') return { content: [{ type: 'text', text: `${options.unscopedText ? '### Open tabs\n' + options.unscopedText + '\n' : ''}### Page\n- Page URL: ${page.url}\n### Snapshot\n${page.line}` }] }
      if (name === 'browser_tabs') {
        if (args.action === 'select') page.url = options.selectUrl || (args.index === 1 ? 'https://approved.test/second' : 'https://approved.test/app')
        return { content: [{ type: 'text', text: `### Open tabs\n${page.tabs}` }] }
      }
      if (options.afterAction) await options.afterAction(page)
      return { content: [{ type: 'text', text: options.unscopedText || 'action completed' }, ...(options.returnImage ? [{ type: 'image', mimeType: 'image/png', data: 'fixture-image' }] : [])], structuredContent: options.unscopedText ? { unscoped: options.unscopedText } : undefined }
    } }
  } })
  t.after(() => controller.shutdown())
  const sessionId = 'session-fixture'
  await authorizeBrowserBridge({ sessionId, origins: ['https://approved.test'], allowInteraction: options.allowInteraction || false, allowScreenshots: options.allowScreenshots || false, confirmed: true })
  const ctx = { sessionId, config: {} }
  return { directory, controller, ctx, calls, page, closed: () => closed, connections: () => connections }
}

test('bridge authorization requires explicit local confirmation and a bounded page scope', async t => {
  await setup(t)
  await assert.rejects(authorizeBrowserBridge({ sessionId: 'a', origins: ['https://example.test'] }), /明确确认/)
  await assert.rejects(authorizeBrowserBridge({ sessionId: 'a', origins: [], confirmed: true }), /至少一个/)
  await assert.rejects(authorizeBrowserBridge({ sessionId: 'a', origins: ['https://example.test'], profile: '../../outside', confirmed: true }), /Profile/)
  await assert.rejects(authorizeBrowserBridge({ sessionId: 'a', origins: ['https://example.test'], minutes: 100, confirmed: true }), /1–60/)
})

test('bridge status does not connect; snapshot requires and returns an authorized source', async t => {
  const fixture = await setup(t)
  const status = await fixture.controller.execute({ action: 'status' }, fixture.ctx)
  assert.match(status.output, /"authorized":true/)
  assert.equal(fixture.connections(), 0)
  const response = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx)
  assert.match(response.output, /snapshot_id:/)
  assert.match(response.output, /https:\/\/approved.test\/app/)
  assert.equal(fixture.connections(), 1)
  fixture.page.url = 'https://unapproved.test/private'
  await assert.rejects(fixture.controller.execute({ action: 'snapshot' }, fixture.ctx), /未向模型返回页面内容/)
})

test('bridge projects only the verified current snapshot, never raw group tabs, URL query tokens or arbitrary structured text', async t => {
  const fixture = await setup(t, { allowInteraction: true, unscopedText: '- 9: [UNAUTHORIZED PRIVATE TITLE](https://outside.test/?token=hidden)' })
  fixture.page.url = 'https://approved.test/app?code=private-code#secret'
  const snapshot = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx)
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE TITLE|outside\.test|private-code|#secret/)
  const snapshot_id = /snapshot_id: ([^\n]+)/.exec(snapshot.output)[1]
  const result = await fixture.controller.execute({ action: 'click', snapshot_id, ref: 'e1' }, fixture.ctx)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE TITLE|outside\.test|private-code|#secret/)
  assert.equal(result.raw, undefined); assert.equal(result.structuredContent, undefined)
  assert.match(result.output, /button "Save"/)
})

test('bridge does not project nested frame contents or allow a frame-prefixed interaction', async t => {
  const fixture = await setup(t, { allowInteraction: true })
  fixture.page.line = '- button "Main" [ref=e1]\n- iframe [ref=f1]:\n  - textbox "FRAME PRIVATE VALUE" [ref=f1e2]\n  - text: nested private note\n- button "Next" [ref=e3]'
  const snapshot = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx)
  assert.doesNotMatch(snapshot.output, /FRAME PRIVATE|nested private|f1e2/)
  assert.match(snapshot.output, /button "Next"/)
  const snapshot_id = /snapshot_id: ([^\n]+)/.exec(snapshot.output)[1]
  await assert.rejects(fixture.controller.execute({ action: 'click', snapshot_id, ref: 'f1e2' }, fixture.ctx), /嵌入 frame/)
  assert.equal(fixture.calls.some(call => call.name === 'browser_click'), false)
})

test('strict data egress policy refuses an existing-browser bridge before connecting', async t => {
  const fixture = await setup(t)
  await assert.rejects(fixture.controller.execute({ action: 'snapshot' }, { ...fixture.ctx, config: { data_policy: { web_origins: ['https://approved.test'] } } }), /已有浏览器桥接无法约束/)
  await assert.rejects(fixture.controller.execute({ action: 'snapshot' }, { ...fixture.ctx, configState: { config: {} }, config: { data_policy: { web_origins: [] } } }), /已有浏览器桥接无法约束/)
  await assert.rejects(fixture.controller.execute({ action: 'snapshot' }, { ...fixture.ctx, configState: { config: { data_policy: { web_origins: [] } } }, config: {} }), /已有浏览器桥接无法约束/)
  assert.equal(fixture.connections(), 0)
  assert.deepEqual(fixture.calls, [])
})

test('bridge tabs only expose approved origins and reject stale indexes or ambiguous titles', async t => {
  const fixture = await setup(t)
  const list = JSON.parse((await fixture.controller.execute({ action: 'tabs' }, fixture.ctx)).output)
  assert.equal(list.tabs.length, 2)
  assert.doesNotMatch(JSON.stringify(list), /Secret|outside/)
  await assert.rejects(fixture.controller.execute({ action: 'select_tab', tab_list_id: list.tab_list_id, tab_id: 'tab_2' }, fixture.ctx), /授权列表/)
  assert.match((await fixture.controller.execute({ action: 'select_tab', tab_list_id: list.tab_list_id, tab_id: 'tab_1' }, fixture.ctx)).output, /approved.test\/second/)
  await assert.rejects(fixture.controller.execute({ action: 'select_tab', tab_list_id: list.tab_list_id, tab_id: 'tab_0' }, fixture.ctx), /列表已变化/)
  const next = JSON.parse((await fixture.controller.execute({ action: 'tabs' }, fixture.ctx)).output)
  fixture.page.tabs = fixture.page.tabs.replace('Second', 'Changed')
  await assert.rejects(fixture.controller.execute({ action: 'select_tab', tab_list_id: next.tab_list_id, tab_id: 'tab_1' }, fixture.ctx), /列表已变化/)
  fixture.page.tabs = '- 0: [Ambiguous ] title](https://approved.test/app)'
  await assert.rejects(fixture.controller.execute({ action: 'tabs' }, fixture.ctx), /格式存在歧义/)
})

test('bridge tab replacement between listing and selection never returns the wrong page', async t => {
  const fixture = await setup(t, { selectUrl: 'https://approved.test/replaced' })
  const list = JSON.parse((await fixture.controller.execute({ action: 'tabs' }, fixture.ctx)).output)
  await assert.rejects(fixture.controller.execute({ action: 'select_tab', tab_list_id: list.tab_list_id, tab_id: 'tab_1' }, fixture.ctx), error => error.operationNotStarted === false && /切换期间发生变化/.test(error.message))
})

test('read-only grant never permits click or fill, and unknown raw methods stay unavailable', async t => {
  const fixture = await setup(t)
  for (const action of ['click', 'fill']) await assert.rejects(fixture.controller.execute({ action, ref: 'e1' }, fixture.ctx), /只授权读取/)
  for (const action of ['evaluate', 'browser_cookie_get', 'browser_run_code', 'upload', 'press']) await assert.rejects(fixture.controller.execute({ action }, fixture.ctx), /不支持/)
  assert.equal(fixture.connections(), 0)
})

test('bridge images require separate host consent and only explicit screenshot actions may project pixels', async t => {
  const fixture = await setup(t, { allowInteraction: true, returnImage: true })
  await assert.rejects(fixture.controller.execute({ action: 'screenshot' }, fixture.ctx), /另行.*allow-screenshots/)
  assert.equal(fixture.connections(), 0)
  assert.equal(JSON.parse((await fixture.controller.execute({ action: 'status' }, fixture.ctx)).output).allowScreenshots, false)
  const first = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx)
  const firstId = /snapshot_id: ([^\n]+)/.exec(first.output)[1]
  const click = await fixture.controller.execute({ action: 'click', snapshot_id: firstId, ref: 'e1' }, fixture.ctx)
  assert.equal(click.content, undefined, 'a click result cannot smuggle an image')
  await authorizeBrowserBridge({ sessionId: fixture.ctx.sessionId, origins: ['https://approved.test'], allowScreenshots: true, confirmed: true })
  const approved = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx)
  const approvedId = /snapshot_id: ([^\n]+)/.exec(approved.output)[1]
  const screenshot = await fixture.controller.execute({ action: 'screenshot', snapshot_id: approvedId }, fixture.ctx)
  assert.equal(screenshot.content.length, 1)
  assert.equal(screenshot.metadata.bridge.imageOriginVerified, false)
  assert.match(screenshot.output, /嵌入页面/)
})

test('editing a saved bridge descriptor cannot mint screenshot permission', async t => {
  const fixture = await setup(t)
  const directory = path.join(fixture.directory, 'browser-bridge', 'authorizations')
  const file = path.join(directory, (await readdir(directory))[0])
  const descriptor = JSON.parse(await readFile(file, 'utf8'))
  descriptor.allowScreenshots = true
  await writeFile(file, JSON.stringify(descriptor), { mode: 0o600 })
  await assert.rejects(fixture.controller.execute({ action: 'screenshot' }, fixture.ctx), error => error.code === 'scoped_grant_denied')
  assert.equal(fixture.connections(), 0)
})

test('interactive mapping uses a current exact ref, never forwards JS or arbitrary selectors', async t => {
  const fixture = await setup(t, { allowInteraction: true })
  const snapshot = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx)
  const snapshot_id = /snapshot_id: ([^\n]+)/.exec(snapshot.output)[1]
  await assert.rejects(fixture.controller.execute({ action: 'click', snapshot_id, ref: 'button:has-text("Save")' }, fixture.ctx), /不能使用任意/)
  await fixture.controller.execute({ action: 'click', snapshot_id, ref: 'e1' }, fixture.ctx)
  assert.deepEqual(fixture.calls.find(call => call.name === 'browser_click').args, { target: 'e1' })
  await assert.rejects(fixture.controller.execute({ action: 'click', snapshot_id, ref: 'e1' }, fixture.ctx), /缺少当前/)
})

test('changed refs/password entry/system keys are rejected, revocation stops future calls', async t => {
  const fixture = await setup(t, { allowInteraction: true })
  const snap = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx), snapshot_id = /snapshot_id: ([^\n]+)/.exec(snap.output)[1]
  fixture.page.line = '- textbox "Password" [ref=e1]'
  await assert.rejects(fixture.controller.execute({ action: 'fill', snapshot_id, ref: 'e1', value: 'fixture-secret' }, fixture.ctx), /引用已失效/)
  const next = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx), fresh = /snapshot_id: ([^\n]+)/.exec(next.output)[1]
  await assert.rejects(fixture.controller.execute({ action: 'fill', snapshot_id: fresh, ref: 'e1', value: 'fixture-secret' }, fixture.ctx), /手动输入密码/)
  await assert.rejects(fixture.controller.execute({ action: 'press', snapshot_id: fresh, key: 'Control+L' }, fixture.ctx), /控制面/)
  const count = fixture.calls.length
  await revokeBrowserBridge({ sessionId: fixture.ctx.sessionId })
  await assert.rejects(fixture.controller.execute({ action: 'snapshot' }, fixture.ctx), /尚未授权/)
  assert.equal(fixture.calls.length, count)
  assert.ok(!JSON.stringify(fixture.calls).includes('fixture-secret'))
})

test('post-click navigation outside page scope does not claim operationNotStarted', async t => {
  const fixture = await setup(t, { allowInteraction: true, afterAction: page => { page.url = 'https://outside.test' } })
  const snapshot = await fixture.controller.execute({ action: 'snapshot' }, fixture.ctx), snapshot_id = /snapshot_id: ([^\n]+)/.exec(snapshot.output)[1]
  await assert.rejects(fixture.controller.execute({ action: 'click', snapshot_id, ref: 'e1' }, fixture.ctx), error => error.operationNotStarted === false)
  assert.equal(fixture.calls.filter(call => call.name === 'browser_click').length, 1)
})

test('bridge child environment excludes credentials, Node injection and approval-bypass token', () => {
  const keys = ['OPENAI_API_KEY', 'SSO_CLIENT_SECRET', 'NODE_OPTIONS', 'PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'npm_config_userconfig']
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) process.env[key] = 'fixture-secret'
    const env = bridgeProcessEnvironment()
    for (const key of keys) assert.equal(env[key], undefined)
  } finally { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] } }
})

test('runtime lock rejects floating, unpinned or foreign transitive dependencies', () => {
  const base = { lockfileVersion: 3, packages: { '': { dependencies: { [BRIDGE_PACKAGE]: BRIDGE_VERSION } }, [`node_modules/${BRIDGE_PACKAGE}`]: { resolved: 'https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.82.tgz', integrity: BRIDGE_INTEGRITY } } }
  assert.doesNotThrow(() => validateBridgeLock(base))
  for (const changes of [{ resolved: 'http://registry.npmjs.org/x' }, { resolved: 'https://evil.test/x' }, { integrity: 'unverified' }]) {
    const lock = structuredClone(base); lock.packages['node_modules/transitive'] = changes
    assert.throws(() => validateBridgeLock(lock), /来源|摘要/)
  }
})

test('installed real runtime verifies files and detects tampering without auto-reinstall', { skip: !process.env.KKCODE_BRIDGE_TEST_RUNTIME }, async () => {
  const rootDir = process.env.KKCODE_BRIDGE_TEST_RUNTIME
  const installed = await browserBridgeStatus({ rootDir })
  assert.equal(installed.installed, true)
  // Only a dedicated acceptance runtime supplied by the test runner is changed.
  const file = path.join(installed.directory, 'empty-user.npmrc'), before = await readFile(file)
  try { await writeFile(file, 'tampered=1'); await assert.rejects(browserBridgeStatus({ rootDir }), /内容已变化/) }
  finally { await writeFile(file, before) }
})
