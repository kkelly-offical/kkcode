import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { browserStatus, createBrowserController } from '../src/kernel/browser/controller.mjs'
import { createBrowserRecipeAuthority, createBrowserRecipeStore } from '../src/kernel/browser/recipes.mjs'
import { createBrowserRecipeFixtureRunner } from '../src/kernel/browser/recipe-fixture.mjs'

test('passive semantic recorder runs the real review→isolated fixture→hash enable chain without storing field values', { timeout: 45000 }, async t => {
  if (!(await browserStatus()).installed) { if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Browser engine required'); t.skip('Install dedicated Browser engine'); return }
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-recipe-live-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  const html = '<title>Recipe fixture</title><label>Name<input aria-label="Name"></label><input type="password" aria-label="Password"><button onclick="document.querySelector(\'output\').textContent=\'Saved \'+document.querySelector(\'input\').value">Save</button><output></output>'
  let requests = 0
  const server = http.createServer((_request, response) => { requests++; response.setHeader('content-type', 'text/html'); response.end(html) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = createBrowserController(), browserConfig = { tool: { browser: { chromium_sandbox: false } } }
  const ctx = { sessionId: 'record-live', config: browserConfig }
  const approvals = [], events = []
  const store = createBrowserRecipeStore({ rootDir: path.join(root, 'recipes'),
    authority: createBrowserRecipeAuthority({ confirm: async request => { approvals.push(request.action); return true } }),
    executor: { observe: () => browser.observe({ sessionId: ctx.sessionId }), execute: (step, options) => browser.execute(step, { ...ctx, recipeGuard: { origin: options.origin, fingerprint: options.fingerprint, authorize: options.authorize } }) },
    fixtureRunner: createBrowserRecipeFixtureRunner({ html, parameters: { input_1: 'fixture-validation' }, assertions: ['Saved fixture-validation'], browserConfig }) })
  try {
    await browser.execute({ action: 'open', url: origin }, ctx)
    const recorder = await store.start({ origin })
    await browser.attachRecorder({ sessionId: ctx.sessionId, recorder: { ...recorder, record: async event => { const result = await recorder.record(event); events.push({ event, result }); return result } } })
    await browser.execute({ action: 'fill', role: 'textbox', name: 'Name', value: 'recording-secret-not-persisted' }, ctx)
    await browser.execute({ action: 'press', role: 'textbox', name: 'Name', key: 'Tab' }, ctx)
    await browser.execute({ action: 'fill', selector: 'input[type=password]', value: 'password-not-observed' }, ctx)
    await browser.execute({ action: 'click', role: 'button', name: 'Save' }, ctx)
    for (let i = 0; i < 40 && events.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(events.length, 2)
    assert.equal(events.every(item => item.result.recorded), true)
    assert.doesNotMatch(JSON.stringify(events), /recording-secret|password-not-observed/)
    const candidate = await recorder.finish()
    assert.deepEqual(candidate.candidate.steps.map(step => step.action), ['fill', 'click'])
    assert.equal(recorder.signal.aborted, true)
    assert.doesNotMatch(JSON.stringify(candidate), /recording-secret|password-not-observed/)
    await assert.rejects(store.enable({ id: candidate.id, hash: candidate.hash }), /人工审核|隔离验证/)
    await store.review({ id: candidate.id, hash: candidate.hash })
    const countBeforeFixture = requests
    await store.validate({ id: candidate.id, hash: candidate.hash })
    assert.equal(requests, countBeforeFixture, 'validation uses independent in-memory pages, not the live service')
    await store.enable({ id: candidate.id, hash: candidate.hash })
    assert.deepEqual(approvals, ['record', 'review', 'enable'])
    await store.run({ id: candidate.id, hash: candidate.hash, parameters: { input_1: 'live-approved-value' } })
    assert.match(await browser.execute({ action: 'snapshot' }, ctx), /Saved live-approved-value/)
    await browser.execute({ action: 'open', url: `${origin}/changed-shape` }, ctx)
    await assert.rejects(store.run({ id: candidate.id, hash: candidate.hash, parameters: { input_1: 'must-not-run' } }), /指纹已变化/)
    assert.equal((await store.get({ id: candidate.id })).state, 'invalidated')
  } finally {
    await browser.shutdown(); await new Promise(resolve => server.close(resolve))
    if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old
    await rm(root, { recursive: true, force: true })
  }
})
