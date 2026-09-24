import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createKernel } from '../src/kernel/index.mjs'
import { createBrowserController, browserStatus } from '../src/kernel/browser/controller.mjs'
import { createBrowserRecipeAuthority, createScopedBrowserRecipeStore } from '../src/kernel/browser/recipes.mjs'
import { createBrowserRecipeFixtureRunner } from '../src/kernel/browser/recipe-fixture.mjs'
import { createBrowserRecipeTools } from '../src/kernel/tool/browser-recipe.mjs'

test('real model recipe invocation re-enters Browser leaves and respects a later Skill tool ceiling', { timeout: 60000 }, async t => {
  if (!(await browserStatus()).installed) { if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Dedicated Browser engine required'); t.skip('Install dedicated Browser engine'); return }
  const root = await mkdtemp(path.join(tmpdir(), 'kk-recipe-loop-')), cwd = path.join(root, 'project'), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(cwd)
  const html = '<title>Recipe app</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector(\'output\').textContent=\'Saved \'+document.querySelector(\'input\').value">Save</button><output></output>'
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(html) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, browser = createBrowserController()
  // Dedicated root CI fixture only, no real profiles or external traffic.
  const browserConfig = { tool: { browser: { chromium_sandbox: false } } }, ctx = { sessionId: 'recording-fixture', config: browserConfig }
  let kernel
  t.after(async () => {
    await browser.shutdown(); await kernel?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  await browser.execute({ action: 'open', url: origin }, ctx)
  const store = await createScopedBrowserRecipeStore({ cwd, authority: createBrowserRecipeAuthority({ confirm: async () => true }),
    executor: { observe: () => browser.observe(ctx), execute: async () => { throw new Error('recording host must never execute model leaves') } },
    fixtureRunner: createBrowserRecipeFixtureRunner({ html, parameters: { input_1: 'fixture' }, assertions: ['Saved fixture'], browserConfig }) })
  const recorder = await store.start({ origin })
  await recorder.record({ action: 'fill', role: 'textbox', name: 'Name', inputType: 'text' })
  await recorder.record({ action: 'click', role: 'button', name: 'Save' })
  const record = await recorder.finish()
  await store.review(record); await store.validate(record); await store.enable(record)
  await browser.shutdown()
  const events = []
  kernel = await createKernel({ cwd, boot: false, trustState: { trusted: true }, handlers: { onEvent: event => events.push(event) } })
  const config = kernel.configState.config
  config.provider = { default: 'recipe-fixture', 'recipe-fixture': { default_model: 'fixture', context_limit: 32000, stream: true } }
  config.permission = { level: 'yolo', rules: [] }; config.agent.verify_completion = false; config.agent.max_steps = 5
  config.session.title_generation = false; config.skills.auto_seed = false; config.mcp.auto_discover = false; config.git_auto = { enabled: false }
  config.tool = { ...config.tool, ...browserConfig.tool, sources: { builtin: true, mcp: false, plugin: false, local: false } }
  kernel.configState.userConfig = { ...kernel.configState.userConfig, ...browserConfig }
  let phase = 0, deny = false
  kernel.providers.registerProvider('recipe-fixture', {
    request: async () => ({ text: 'done', toolCalls: [] }),
    async *requestStream(input) {
      const current = phase++
      if (!deny && current === 0) yield { type: 'tool_call', call: { id: 'open', name: 'browser', args: { action: 'open', url: origin } } }
      else if (deny && current === 0 || !deny && current === 1) yield { type: 'tool_call', call: { id: `recipe-${deny}`, name: 'browser_recipe', args: { action: 'run', id: record.id, hash: record.hash, parameters: { input_1: deny ? 'must-not-appear' : 'live-value' } } } }
      else {
        const result = input.messages.at(-1).content.find(value => value.type === 'tool_result')
        assert.equal(result.is_error, deny)
        if (!deny) assert.match(result.content, /Saved live-value/)
        yield { type: 'text', content: deny ? 'Leaf denied safely.' : 'Recipe leaves verified.' }
      }
    }
  })
  const sessionId = 'recipe-live-model'
  const first = await kernel.executeTurn({ sessionId, prompt: 'Run the approved fixture recipe.', mode: 'agent', model: 'fixture', providerType: 'recipe-fixture' })
  assert.match(first.reply, /Recipe leaves verified/)
  const firstLeaves = events.filter(event => event.type === 'tool.finish' && event.payload.tool === 'browser')
  assert.equal(firstLeaves.length, 3, 'open, fill and click all emitted governed tool finish events')
  deny = true; phase = 0
  const denied = await kernel.executeTurn({ sessionId, prompt: 'Try with a narrower Skill tool ceiling.', mode: 'agent', model: 'fixture', providerType: 'recipe-fixture', toolContext: { skillAllowedTools: ['browser_recipe'] } })
  assert.match(denied.reply, /Leaf denied safely/)
  assert.equal(events.filter(event => event.type === 'tool.finish' && event.payload.tool === 'browser').length, 3)
  const body = await (await kernel.tools.get('browser')).execute({ action: 'snapshot' }, { sessionId, config, configState: kernel.configState })
  assert.match(body, /Saved live-value/); assert.doesNotMatch(body, /must-not-appear/)
})

test('model recipe interface never exposes candidates and refuses a forged execution callback', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-recipe-tool-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const executor = { observe: async () => ({ origin: 'https://secret-candidate.invalid', fingerprint: 'a'.repeat(64) }), execute: async () => {} }
  const store = await createScopedBrowserRecipeStore({ cwd: root, executor, authority: createBrowserRecipeAuthority({ confirm: async () => true }) })
  const recorder = await store.start({ origin: 'https://secret-candidate.invalid' }); await recorder.record({ action: 'snapshot' }); await recorder.finish()
  const [tool] = createBrowserRecipeTools({ observe: executor.observe })
  const listing = await tool.execute({ action: 'list' }, { cwd: root })
  assert.doesNotMatch(listing.output, /secret-candidate/)
  assert.deepEqual(JSON.parse(listing.output).recipes, [])
  await assert.rejects(tool.execute({ action: 'run' }, { cwd: root, runBrowserRecipeCall: async () => ({ status: 'completed' }) }), error => error.operationNotStarted === true)
})
