import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, link, unlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { browserStatus } from '../src/kernel/browser/controller.mjs'
import { createBrowserRecipeStore, createScopedBrowserRecipeStore, createBrowserRecipeAuthority } from '../src/kernel/browser/recipes.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const origin = 'https://recipe.invalid', siteHash = sha('fixture-site-v1')
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-recipe-')), decisions = [], executed = []
  const site = { origin, fingerprint: siteHash }
  const authority = createBrowserRecipeAuthority({ confirm: async request => { decisions.push(request); return true } })
  const executor = { observe: async () => site, execute: async step => { executed.push(step) } }
  const runner = async ({ hash, candidate }) => ({ hash, isolated: true, network: 'blocked', fixtureHash: sha('independent-fixture-v1'), executedSteps: candidate.steps.length, assertions: [true] })
  const options = { rootDir: root, authority, executor, fixtureRunner: runner, ...overrides }, store = createBrowserRecipeStore(options)
  t.after(async () => { await store.shutdown(); await rm(root, { recursive: true, force: true }) })
  return { root, store, decisions, executed, site, options }
}
async function candidate(store, events = [{ action: 'fill', role: 'textbox', name: 'Name', inputType: 'text', value: 'never-save-me' }, { action: 'click', role: 'button', name: 'Save' }]) {
  const recorder = await store.start({ origin })
  for (const event of events) assert.equal((await recorder.record(event)).recorded, true)
  const result = await recorder.finish()
  assert.equal(recorder.signal.aborted, true)
  return result
}
async function enabled(store, record) {
  await store.review(record); await store.validate(record); return store.enable(record)
}

test('recipe recording is opt-in, redacted and parameterized; exact hash approval and independent validation gate execution', async t => {
  const f = await fixture(t)
  const recorder = await f.store.start({ origin })
  assert.equal(recorder.isActive(), true)
  assert.equal((await recorder.record({ action: 'evaluate', script: 'secret code' })).recorded, false)
  assert.equal((await recorder.record({ action: 'fill', role: 'textbox', name: 'Password', inputType: 'password', value: 'never-password' })).recorded, false)
  await recorder.record({ action: 'fill', role: 'textbox', name: 'Name', inputType: 'text', value: 'never-value', headers: { Authorization: 'never-token' }, cookie: 'never-cookie' })
  await recorder.record({ action: 'click', role: 'button', name: '用户 alice@example.invalid 的项目' })
  const record = await recorder.finish(), serialized = await readFile(path.join(f.root, `${record.id}.json`), 'utf8')
  assert.doesNotMatch(serialized, /never-|alice|Authorization|cookie|script/)
  assert.deepEqual(Object.keys(record.candidate.parameters), ['input_1', 'target_2'])
  await assert.rejects(f.store.run({ ...record, parameters: {} }), error => error.code === 'browser_recipe_not_enabled')
  await assert.rejects(f.store.enable({ ...record, confirmed: true }), error => error.code === 'browser_recipe_not_validated')
  await assert.rejects(f.store.review({ ...record, hash: '0'.repeat(64) }), error => error.code === 'browser_recipe_stale')
  await enabled(f.store, record)
  assert.deepEqual(f.decisions.map(value => value.action), ['record', 'review', 'enable'])
  const params = { input_1: 'runtime-only', target_2: 'User project' }
  const result = await f.store.run({ ...record, parameters: params })
  assert.equal(result.completedSteps, 2)
  assert.equal(f.executed[0].value, params.input_1)
  assert.doesNotMatch(await readFile(path.join(f.root, `${record.id}.json`), 'utf8'), /runtime-only|User project/)
  assert.equal((await createBrowserRecipeStore(f.options).get(record)).state, 'enabled')
})

test('JSON confirmed flags cannot mint authority and fixture claims from run arguments are ignored', async t => {
  const f = await fixture(t), record = await candidate(f.store)
  const unprivileged = createBrowserRecipeStore({ ...f.options, authority: { confirmed: true } })
  await assert.rejects(unprivileged.start({ origin, confirmed: true }), error => error.code === 'browser_recipe_host_required')
  await assert.rejects(unprivileged.review({ ...record, confirmed: true }), error => error.code === 'browser_recipe_host_required')
  const noFixture = createBrowserRecipeStore({ ...f.options, fixtureRunner: undefined })
  await f.store.review(record)
  await assert.rejects(noFixture.validate({ ...record, fixtureRunner: () => ({ passed: true }) }), error => error.code === 'browser_recipe_unsupported')
  const badFixture = createBrowserRecipeStore({ ...f.options, fixtureRunner: async () => ({ hash: record.hash, isolated: false, network: 'allowed' }) })
  await assert.rejects(badFixture.validate(record), error => error.code === 'browser_recipe_validation_failed')
  assert.equal((await f.store.get(record)).state, 'reviewed')
})

test('site fingerprint changes disable recipes before further execution; parameter validation precedes every effect', async t => {
  const f = await fixture(t), record = await candidate(f.store, [{ action: 'click', role: 'button', name: 'Save' }, { action: 'open', url: `${origin}/private?token=never-record` }])
  await enabled(f.store, record)
  await assert.rejects(f.store.run({ ...record, parameters: { path_1: '//other.invalid' } }), /同站点/)
  assert.equal(f.executed.length, 0)
  f.site.fingerprint = sha('changed-site')
  await assert.rejects(f.store.run({ ...record, parameters: { path_1: '/safe' } }), error => error.code === 'browser_recipe_site_changed')
  assert.equal(f.executed.length, 0)
  assert.equal((await f.store.get(record)).state, 'invalidated')
  await assert.rejects(f.store.review(record), /重新录制/)
})

test('human approval races cannot overwrite a concurrent disable', async t => {
  const f = await fixture(t), record = await candidate(f.store)
  let accept, shown
  const waiting = new Promise(resolve => { shown = resolve })
  const authority = createBrowserRecipeAuthority({ confirm: async () => { shown(); return new Promise(resolve => { accept = resolve }) } })
  const pending = createBrowserRecipeStore({ ...f.options, authority }).review(record)
  await waiting; await f.store.disable(record); accept(true)
  await assert.rejects(pending, error => error.code === 'browser_recipe_stale')
  assert.equal((await f.store.get(record)).state, 'disabled')
})

test('queued passive events preserve admission order and finish drains already received events', async t => {
  let observations = 0, release
  const delay = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { executor: { observe: async () => { if (++observations === 3) await delay; return { origin, fingerprint: siteHash } }, execute: async () => {} } })
  const recorder = await f.store.start({ origin })
  const first = recorder.record({ action: 'fill', role: 'textbox', name: 'Name', inputType: 'text', value: 'not-retained' })
  const second = recorder.record({ action: 'click', role: 'button', name: 'Save' })
  const finishing = recorder.finish()
  release()
  await Promise.all([first, second])
  const result = await finishing
  assert.deepEqual(result.candidate.steps.map(step => step.action), ['fill', 'click'])
  assert.equal(recorder.signal.aborted, true)
})

test('passive intake is bounded before a slow observation can accumulate requests', async t => {
  let observations = 0, release
  const delay = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { executor: { observe: async () => { if (++observations === 3) await delay; return { origin, fingerprint: siteHash } }, execute: async () => {} } })
  const recorder = await f.store.start({ origin })
  assert.equal((await recorder.record({ action: 'click', role: {}, name: 'Name' })).reason, 'invalid_semantic_field')
  const pending = Array.from({ length: 64 }, () => recorder.record({ action: 'snapshot' }))
  assert.equal((await recorder.record({ action: 'snapshot' })).reason, 'event_limit')
  release(); await Promise.all(pending)
  assert.equal((await recorder.finish()).candidate.steps.length, 64)
})

test('scoped recipes isolate accounts/projects and recheck ownership after a pending human review', async t => {
  const f = await fixture(t), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(f.root, 'state')
  t.after(() => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous })
  const project = path.join(f.root, 'project'), otherProject = path.join(f.root, 'other')
  await mkdir(project); await mkdir(otherProject); await mkdir(path.join(process.env.KKCODE_HOME, 'device'), { recursive: true, mode: 0o700 })
  const identityPath = path.join(process.env.KKCODE_HOME, 'device', 'identity.json')
  const bind = owner => writeFile(identityPath, JSON.stringify({ owner, ownerGateway: 'https://gateway.invalid', profile: { organization: 'test-org' } }), { mode: 0o600 })
  await bind('account-a')
  let accept, shown
  const waiting = new Promise(resolve => { shown = resolve })
  const authority = createBrowserRecipeAuthority({ confirm: async request => request.action !== 'review' || (shown(), await new Promise(resolve => { accept = resolve })) })
  const scoped = await createScopedBrowserRecipeStore({ cwd: project, authority, executor: f.options.executor, fixtureRunner: f.options.fixtureRunner })
  const record = await candidate(scoped)
  assert.deepEqual(await (await createScopedBrowserRecipeStore({ cwd: otherProject })).list(), [])
  const pending = scoped.review(record)
  await waiting; await bind('account-b'); accept(true)
  await assert.rejects(pending, error => error.code === 'browser_recipe_scope_changed')
  assert.deepEqual(await (await createScopedBrowserRecipeStore({ cwd: project })).list(), [])
  await assert.rejects(scoped.get(record), error => error.code === 'browser_recipe_scope_changed')
  await bind('account-a')
  assert.equal((await scoped.get(record)).state, 'candidate')
})

test('late disable is visible through the host dispatch authorization callback', async t => {
  let release, dispatched, effects = 0
  const wait = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { dispatched = resolve })
  const f = await fixture(t, { executor: { observe: async () => ({ origin, fingerprint: siteHash }), execute: async (_step, options) => {
    dispatched(); await wait
    try { await options.authorize() } catch (error) { error.operationNotStarted = true; throw error }
    effects++
  } } })
  const record = await candidate(f.store, [{ action: 'click', role: 'button', name: 'Save' }]); await enabled(f.store, record)
  const running = f.store.run(record)
  await entered; await f.store.disable(record); release()
  await assert.rejects(running, error => error.details.outcomeUnknown === false)
  assert.equal(effects, 0)
})

test('recording timeout closes feed and explicit cancellation does not later publish a candidate', async t => {
  let now = 0
  const f = await fixture(t, { now: () => now })
  const recorder = await f.store.start({ origin, minutes: 1 })
  await recorder.record({ action: 'snapshot' }); now = 61000
  assert.equal((await recorder.record({ action: 'snapshot' })).reason, 'recording_closed')
  assert.equal(recorder.signal.aborted, true)
  assert.equal((await f.store.list()).length, 1)
  const cancelled = await f.store.start({ origin })
  await cancelled.record({ action: 'snapshot' }); await cancelled.cancel()
  assert.equal((await cancelled.finish()).cancelled, true)
  assert.equal((await f.store.list()).length, 1)
})

test('recipe failures preserve partial effect evidence and do not repeat the action', async t => {
  let attempts = 0
  const f = await fixture(t, { executor: { observe: async () => ({ origin, fingerprint: siteHash }), execute: async () => { attempts++; throw new Error('credential=should-not-be-in-error') } } })
  const record = await candidate(f.store, [{ action: 'click', role: 'button', name: 'Save' }])
  await enabled(f.store, record)
  await assert.rejects(f.store.run(record), error => error.code === 'browser_recipe_execution_failed' && error.details.outcomeUnknown === true && !error.message.includes('credential'))
  assert.equal(attempts, 1)
})

test('private recipe storage rejects tampering, links and unsafe permissions without deleting evidence', async t => {
  const f = await fixture(t), record = await candidate(f.store), file = path.join(f.root, `${record.id}.json`)
  const original = await readFile(file)
  await writeFile(file, JSON.stringify({ ...record, candidate: { ...record.candidate, steps: [{ action: 'evaluate', script: 'unsafe' }] } }))
  await assert.rejects(f.store.get(record), /有限语义|哈希/)
  await writeFile(file, original)
  const linked = path.join(f.root, 'linked'); await link(file, linked)
  await assert.rejects(f.store.get(record), error => error.code === 'browser_recipe_unsafe_storage')
  await unlink(linked)
  if (process.platform !== 'win32') {
    const alias = `${f.root}-alias`; await symlink(f.root, alias); t.after(() => unlink(alias))
    assert.throws(() => createBrowserRecipeStore({ rootDir: alias }), error => error.code === 'browser_recipe_unsafe_storage')
    await chmod(file, 0o644)
    await assert.rejects(f.store.get(record), error => error.code === 'browser_recipe_unsafe_storage')
    await chmod(file, 0o600)
  }
  assert.deepEqual(await readFile(file), original)
})

test('real independent offline Chromium fixture validates reviewed actions before a separate live context may run them', { timeout: 30000 }, async t => {
  if (!(await browserStatus()).installed) { if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Dedicated Browser engine required'); t.skip('Install dedicated Browser engine for acceptance'); return }
  const html = '<label>Name<input aria-label="Name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>'
  // Explicitly isolated offline test fixture: root CI lacks user namespaces;
  // no real user profile, network service, account or remote session is opened.
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false })
  t.after(() => browser.close())
  const live = await browser.newContext({ serviceWorkers: 'block' }); await live.route('**/*', route => route.abort())
  const livePage = await live.newPage(); await livePage.setContent(html)
  let fixtureContexts = 0
  const perform = async (page, step) => {
    if (step.action === 'fill') await page.getByRole(step.role, { name: step.name, exact: true }).fill(step.value)
    else if (step.action === 'click') await page.getByRole(step.role, { name: step.name, exact: true }).click()
    else if (step.action !== 'snapshot') throw new Error('fixture action unsupported')
  }
  const f = await fixture(t, {
    executor: { observe: async () => ({ origin, fingerprint: sha(html) }), execute: step => perform(livePage, step) },
    fixtureRunner: async ({ hash, candidate: recipe }) => {
      fixtureContexts++
      const isolated = await browser.newContext({ serviceWorkers: 'block' })
      try {
        await isolated.route('**/*', route => route.abort())
        const page = await isolated.newPage(); await page.setContent(html)
        for (const step of recipe.steps) await perform(page, { ...step, ...(step.valueParameter ? { value: 'fixture-only' } : {}) })
        return { hash, isolated: true, network: 'blocked', fixtureHash: sha(html), executedSteps: recipe.steps.length, assertions: [(await isolated.cookies()).length === 0, await page.locator('output').textContent() === 'fixture-only'] }
      } finally { await isolated.close() }
    }
  })
  const record = await candidate(f.store)
  await enabled(f.store, record)
  assert.equal(fixtureContexts, 1)
  assert.equal(await livePage.getByRole('textbox', { name: 'Name' }).inputValue(), '', 'fixture never touched live context')
  await f.store.run({ ...record, parameters: { input_1: 'live-only' } })
  assert.equal(await livePage.locator('output').textContent(), 'live-only')
})
