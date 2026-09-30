import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { clearFileReadState, getFileReadState, markFileRead, extractTrackedView, wasFileRead } from "../src/kernel/tool/file-read-state.mjs"
import { currentRuntime, runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { createKernel } from '../src/kernel/kernel.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

beforeEach(() => {
  clearFileReadState()
})

test("file read state normalizes equivalent paths", () => {
  markFileRead("./src/../src/example.js", {
    content: "const x = 1\n",
    timestamp: 123,
    isPartialView: false
  })

  const state = getFileReadState("src/example.js")
  assert.ok(state)
  assert.equal(state.content, "const x = 1\n")
  assert.equal(state.timestamp, 123)
  assert.equal(state.isPartialView, false)
})

test("extractTrackedView returns matching slice for partial reads", () => {
  const state = {
    content: "line2\nline3",
    timestamp: 10,
    offset: 2,
    limit: 2,
    isPartialView: true
  }

  const view = extractTrackedView("line1\nline2\nline3\nline4", state)
  assert.equal(view, "line2\nline3")
})

test('read receipts are scoped to stable kernel identity, session and workspace with no legacy fallback', async () => {
  const tools = {}, runtime = { tools, cwd: process.cwd(), sessionId: 'session-a' }, file = 'scope-fixture.txt'
  markFileRead(file, { content: 'legacy-only' })
  await runWithRuntime(runtime, async () => {
    assert.equal(getFileReadState(file), null)
    markFileRead(file, { content: 'session-a-only' })
    await Promise.resolve()
    assert.equal(getFileReadState(file).content, 'session-a-only')
  })
  await Promise.all([
    runWithRuntime({ ...runtime }, async () => { await Promise.resolve(); assert.equal(getFileReadState(file).content, 'session-a-only') }),
    runWithRuntime({ ...runtime, sessionId: 'session-b' }, async () => { await Promise.resolve(); assert.equal(wasFileRead(file), false); markFileRead(file, { content: 'session-b-only' }) }),
    runWithRuntime({ ...runtime, tools: {} }, async () => { await Promise.resolve(); assert.equal(getFileReadState(file), null) }),
    runWithRuntime({ ...runtime, cwd: join(process.cwd(), 'different-workspace') }, async () => { await Promise.resolve(); assert.equal(getFileReadState(join(runtime.cwd, file)), null) })
  ])
  runWithRuntime({ ...runtime, sessionId: 'session-b' }, clearFileReadState)
  runWithRuntime(runtime, () => assert.equal(getFileReadState(file).content, 'session-a-only'))
  assert.equal(getFileReadState(file).content, 'legacy-only')
  runWithRuntime({ ...runtime, sessionId: undefined }, () => assert.equal(wasFileRead(file), false))
})

test('relative read paths resolve against the runtime workspace and receipts cannot be mutated by consumers', () => {
  const runtime = { tools: {}, cwd: join(tmpdir(), 'runtime-read-scope'), sessionId: 'same' }
  runWithRuntime(runtime, () => {
    markFileRead('relative.txt', { content: 'original' })
    const state = getFileReadState(join(runtime.cwd, 'relative.txt'))
    assert.equal(state.content, 'original')
    assert.throws(() => { state.content = 'forged' }, TypeError)
    assert.equal(getFileReadState('relative.txt').content, 'original')
  })
})

test('real concurrent kernels and named sessions cannot borrow another read to pass edit guards', async t => {
  const cleanup = createFixtureCleanup(t), cwd = await mkdtemp(join(tmpdir(), 'kk-read-isolation-'))
  cleanup.remove(cwd)
  const priorHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = join(cwd, 'private')
  cleanup.defer(() => { if (priorHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = priorHome })
  const configState = { config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }, skills: { enabled: false }, mcp: { auto_discover: false } } }
  const kernels = await Promise.all([0, 1].map(() => createKernel({ cwd, configState: structuredClone(configState), trustState: { trusted: true }, services: {}, boot: false })))
  for (const kernel of kernels) {
    cleanup.defer(() => kernel.shutdown())
    await kernel.tools.initialize({ config: configState.config, cwd })
  }
  const file = join(cwd, 'same.txt')
  await writeFile(file, 'original content\n')
  const within = (kernel, sessionId, fn) => kernel.run(() => runWithRuntime({ ...currentRuntime(), sessionId }, fn))
  await within(kernels[0], 'a', async () => (await kernels[0].tools.get('read')).execute({ path: 'same.txt' }, { cwd }))
  const edit = () => ({ path: 'same.txt', before: 'original', after: 'edited' })
  const outcomes = await Promise.all([
    within(kernels[0], 'b', async () => (await kernels[0].tools.get('edit')).execute(edit(), { cwd })),
    within(kernels[1], 'a', async () => (await kernels[1].tools.get('edit')).execute(edit(), { cwd }))
  ])
  for (const result of outcomes) {
    const output = typeof result === 'string' ? result : result.output
    assert.match(output, /has not been read yet/)
    assert.doesNotMatch(output, /original content/)
  }
  assert.equal(await readFile(file, 'utf8'), 'original content\n')
  const allowed = await within(kernels[0], 'a', async () => (await kernels[0].tools.get('edit')).execute(edit(), { cwd }))
  assert.ok(allowed.metadata?.mutation)
  assert.equal(await readFile(file, 'utf8'), 'edited content\n')
  const fresh = await createKernel({ cwd, configState: structuredClone(configState), trustState: { trusted: true }, services: {}, boot: false })
  cleanup.defer(() => fresh.shutdown())
  within(fresh, 'a', () => assert.equal(getFileReadState(file), null, 'a recreated kernel must reread even with the same session id'))
})

test('process restart does not rehydrate editing authority from prior read content', async () => {
  markFileRead('restart-fixture.txt', { content: 'not durable authorization' })
  const moduleUrl = new URL('../src/kernel/tool/file-read-state.mjs', import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import { getFileReadState } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(getFileReadState('restart-fixture.txt')))`])
  assert.equal(stdout, 'null')
  assert.equal(wasFileRead('restart-fixture.txt'), true)
})
