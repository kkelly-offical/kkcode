import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, access as fsAccess } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createConversationArtifactAccess, createTaskArtifactAccess, createArtifactTools, archiveToolText, archiveBinaryArtifact, artifactArchiveAttempted, trustedArtifactRef } from '../src/kernel/tool/artifacts.mjs'
import { ArtifactStore } from '../src/storage/artifact-store.mjs'
import { ToolRegistry } from '../src/kernel/tool/registry.mjs'
import { executeTool } from '../src/kernel/tool/executor.mjs'
import { touchSession, appendMessage, getSession, flushNow } from '../src/kernel/session/store.mjs'
import { compactSession, collectArtifactReferences } from '../src/kernel/session/compaction.mjs'
import { processTurnLoop, planModeAllows } from '../src/kernel/session/loop.mjs'
import { registerProvider } from '../src/kernel/provider/router.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { PermissionEngine } from '../src/kernel/permission/engine.mjs'

let root, cwd, previousHome, artifactAccess, config
const sessionId = 'artifact-test-session'
const quote = value => `"${String(value).replaceAll('"', '\\"')}"`
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kk-tool-artifact-'))
  cwd = path.join(root, 'workspace'); await mkdir(cwd)
  previousHome = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state')
  config = { provider: { default: 'artifact-fixture', 'artifact-fixture': { default_model: 'fixture', context_limit: 32000 } },
    agent: { max_steps: 5, verify_completion: false }, permission: { level: 'yolo', rules: [] },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
    session: { recovery: false, title_generation: false }, usage: { budget: {} }, ui: { markdown_render: false } }
  await touchSession({ sessionId, cwd, model: 'fixture', providerType: 'artifact-fixture', mode: 'agent' })
  artifactAccess = createConversationArtifactAccess({ sessionId, cwd, turnId: 'turn-1' })
  await ToolRegistry.initialize({ cwd, config, force: true, allowProjectSources: false })
  PermissionEngine.setTrusted(true)
})
afterEach(async () => {
  await flushNow(); PermissionEngine.setTrusted(false)
  if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome
  await rm(root, { recursive: true, force: true })
})

async function scriptCommand(content) {
  const script = path.join(cwd, 'fixture.mjs')
  await writeFile(script, `process.stdout.write(${JSON.stringify(content)});\n`)
  return `${quote(process.execPath)} ${quote(script)}`
}
async function bash(command, override = {}) {
  return executeTool({ tool: await ToolRegistry.get('bash'), args: { command }, sessionId, turnId: 'turn-1', invocationId: 'bash-1',
    context: { cwd, config, sessionId, turnId: 'turn-1', toolCallId: 'bash-1', toolResultLimit: 4000, artifactAccess, ...override } })
}

test('Bash archives actual captured text before trim/truncation and exact bytes remain readable later', async () => {
  const original = `  START\n${'测试 output line\n'.repeat(12000)}TAIL_MARKER  \n`
  const result = await bash(await scriptCommand(original))
  assert.equal(result.status, 'completed', result.output)
  const ref = trustedArtifactRef(result)
  assert.ok(ref)
  assert.ok(result.output.length < 5000)
  assert.equal(result.output.includes('TAIL_MARKER'), false)
  assert.equal(result.metadata.artifactComplete, true)
  const later = createConversationArtifactAccess({ sessionId, cwd, turnId: 'later-turn' })
  const chunks = []; let cursor
  do {
    const page = await later.read({ id: ref.id, cursor, limit: 17003 })
    chunks.push(Buffer.from(page.data, 'base64')); cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(original))
  const search = await later.search({ id: ref.id, query: 'TAIL_MARKER' })
  assert.equal(search.matches[0].offset, Buffer.byteLength(original.slice(0, original.indexOf('TAIL_MARKER'))))
  const readTool = createArtifactTools().find(tool => tool.name === 'artifact_read')
  const read = await readTool.execute({ artifact_id: ref.id, encoding: 'base64', limit: 64 }, { artifactAccess: later, toolResultLimit: 4000 })
  assert.deepEqual(Buffer.from(JSON.parse(read.output).data, 'base64'), Buffer.from(original).subarray(0, 64))
  const tail = await readTool.execute({ artifact_id: ref.id, cursor: search.matches[0].readCursor, limit: 64 }, { artifactAccess: later, toolResultLimit: 4000 })
  assert.equal(JSON.parse(tail.output).data, 'TAIL_MARKER  \n')
})

test('artifact search exposes direct read cursors without exceeding the tool output budget', async () => {
  const archived = await archiveToolText({ output: 'MATCH:actual evidence\n'.repeat(1000), access: artifactAccess, callId: 'many-matches', limit: 4000 })
  const id = trustedArtifactRef(archived).id, [read, search] = createArtifactTools()
  const result = await search.execute({ artifact_id: id, query: 'MATCH', max_matches: 50 }, { artifactAccess, toolResultLimit: 4000 })
  assert.ok(result.output.length < 4000)
  const found = JSON.parse(result.output)
  assert.ok(found.nextCursor && found.matches.length > 0)
  const page = JSON.parse((await read.execute({ artifact_id: id, cursor: found.matches.at(-1).readCursor, limit: Buffer.byteLength('MATCH:actual evidence\n') }, { artifactAccess, toolResultLimit: 4000 })).output)
  assert.equal(page.data, 'MATCH:actual evidence\n')
})

test('small output creates no archive directories and forged contexts do not authorize archive reads', async () => {
  assert.equal((await bash(await scriptCommand('small'))).output, 'small')
  await assert.rejects(fsAccess(path.join(process.env.KKCODE_HOME, 'artifacts')), { code: 'ENOENT' })
  const tool = createArtifactTools()[0]
  await assert.rejects(tool.execute({ artifact_id: 'art_00000000-0000-0000-0000-000000000000' }, { artifactAccess: { read() { return {} } } }), { code: 'artifact_host_required' })
  assert.equal(planModeAllows('artifact_read'), true)
  assert.equal(planModeAllows('artifact_search'), true)
})

test('durable task artifact access rechecks host ownership and never inherits conversation or other run scope', async () => {
  const store = new ArtifactStore()
  let authorized = true, checks = 0
  const actor = { accountId: 'trusted-account', projectId: 'trusted-project', sessionId, runId: 'trusted-run' }
  const task = createTaskArtifactAccess({ store, resolveActor: async () => { checks++; if(!authorized) throw Object.assign(new Error('owner changed'), { code: 'STALE_OWNER' }); return actor } })
  const result = await archiveToolText({ output: 'x'.repeat(6000), access: task, callId: 't', limit: 4000 })
  const ref = trustedArtifactRef(result)
  assert.ok(ref)
  const page = await createArtifactTools()[0].execute({ artifact_id: ref.id, encoding: 'base64' }, { artifactAccess: task, toolResultLimit: 4000 })
  assert.equal(JSON.parse(page.output).size, 6000)
  await assert.rejects(artifactAccess.read({ id: ref.id }), { code: 'artifact_not_found' })
  const other = createTaskArtifactAccess({ store, resolveActor: async () => ({ ...actor, runId: 'another-run' }) })
  await assert.rejects(other.read({ id: ref.id }), { code: 'artifact_not_found' })
  authorized = false
  await assert.rejects(task.read({ id: ref.id }), { code: 'STALE_OWNER' })
  assert.ok(checks >= 3)
})

test('artifact read stays below display budget even for JSON-escaped control characters', async () => {
  const archived = await archiveToolText({ output: '\u0000'.repeat(9000), access: artifactAccess, callId: 'control-output', limit: 4000 })
  const ref = trustedArtifactRef(archived)
  const tool = createArtifactTools()[0]
  const page = await tool.execute({ artifact_id: ref.id, encoding: 'utf8', limit: 16000 }, { artifactAccess, toolResultLimit: 4000 })
  assert.ok(page.output.length < 4000)
  assert.ok(JSON.parse(page.output).nextCursor)
})

test('another session and an account binding change cannot read a retained conversation archive', async () => {
  const archived = await archiveToolText({ output: 'x'.repeat(6000), access: artifactAccess, callId: 'c', limit: 4000 })
  const ref = trustedArtifactRef(archived)
  await touchSession({ sessionId: 'other-session', cwd, mode: 'agent', model: 'fixture', providerType: 'artifact-fixture' })
  const other = createConversationArtifactAccess({ sessionId: 'other-session', cwd, turnId: 't' })
  await assert.rejects(other.read({ id: ref.id }), { code: 'artifact_not_found' })
  const directory = path.join(process.env.KKCODE_HOME, 'device'); await mkdir(directory, { mode: 0o700 })
  await writeFile(path.join(directory, 'identity.json'), JSON.stringify({ id: 'device', owner: 'new-account' }), { mode: 0o600 })
  await assert.rejects(artifactAccess.read({ id: ref.id }), { code: 'artifact_identity_changed' })
  const rebound = createConversationArtifactAccess({ sessionId, cwd, turnId: 't2' })
  await assert.rejects(rebound.read({ id: ref.id }), { code: 'artifact_not_found' })
})

test('archive failure preserves the settled tool outcome and never claims full output is recoverable', async () => {
  const tiny = createConversationArtifactAccess({ sessionId, cwd, turnId: 't', storeOptions: { limits: { fileBytes: 1 } } })
  const result = await bash(await scriptCommand('x'.repeat(7000)), { artifactAccess: tiny })
  assert.equal(result.status, 'completed')
  assert.match(result.output, /完整输出未归档/)
  assert.equal(trustedArtifactRef(result), null)
  assert.equal(artifactArchiveAttempted(result), true, 'the loop must never rearchive this truncated failure preview as complete output')
  assert.equal(result.metadata.artifactArchiveError, 'artifact_quota_exceeded')
})

test('identical account IDs on different gateway or organization scopes do not share archives', async () => {
  const directory = path.join(process.env.KKCODE_HOME, 'device'); await mkdir(directory, { mode: 0o700 })
  const file = path.join(directory, 'identity.json')
  const identity = { id: 'device', owner: 'shared-id', ownerGateway: 'https://gateway-a.invalid', profile: { organization: 'org-a' } }
  await writeFile(file, JSON.stringify(identity), { mode: 0o600 })
  const original = createConversationArtifactAccess({ sessionId, cwd, turnId: 't1' })
  const archived = await archiveToolText({ output: 'x'.repeat(6000), access: original, callId: 'c', limit: 4000 })
  const ref = trustedArtifactRef(archived)
  for (const change of [{ ownerGateway: 'https://gateway-b.invalid' }, { profile: { organization: 'org-b' } }]) {
    await writeFile(file, JSON.stringify({ ...identity, ...change }))
    const other = createConversationArtifactAccess({ sessionId, cwd, turnId: 't2' })
    await assert.rejects(other.read({ id: ref.id }), { code: 'artifact_not_found' })
  }
})

test('existing exec capture cap is honestly marked partial rather than a complete archive', async () => {
  const result = await bash(await scriptCommand('x'.repeat(2 * 1024 * 1024)))
  assert.equal(result.status, 'error')
  assert.ok(trustedArtifactRef(result))
  assert.equal(result.metadata.captureIncomplete, true)
  assert.equal(result.metadata.artifactComplete, false)
  assert.match(result.output, /仅保存已捕获的部分文本/)
  assert.doesNotMatch(result.output, /完整工具文本已保存在/)
})

test('compaction deterministically preserves host receipt IDs, never extracts them from user strings', async () => {
  const archived = await archiveToolText({ output: 'x'.repeat(6000), access: artifactAccess, callId: 'c', limit: 4000 })
  const ref = trustedArtifactRef(archived)
  assert.deepEqual(collectArtifactReferences([{ content: archived.output }]), [])
  for (let i = 0; i < 12; i++) await appendMessage(sessionId, i % 2 ? 'assistant' : 'user', `turn-${i}`, { turnId: `t-${i}` })
  await appendMessage(sessionId, 'assistant', [{ type: 'tool_use', id: 'c', name: 'bash', input: { command: 'fixture capture' } }], { turnId: 'tool-turn' })
  await appendMessage(sessionId, 'user', [{ type: 'tool_result', tool_use_id: 'c', content: archived.output }], { synthetic: true, artifactRefs: [ref], turnId: 'tool-turn' })
  for (let i = 0; i < 8; i++) await appendMessage(sessionId, i % 2 ? 'assistant' : 'user', `later-${i}`, { turnId: `later-${i}` })
  registerProvider('artifact-fixture', { request: async () => ({ text: 'Summary deliberately omits every artifact identifier.', toolCalls: [] }), async *requestStream() {} })
  const compacted = await runWithRuntime({ cwd }, () => compactSession({ sessionId, model: 'fixture', providerType: 'artifact-fixture', configState: { config }, keepRecentTurns: 2 }))
  assert.equal(compacted.compacted, true, compacted.reason)
  const saved = await getSession(sessionId)
  assert.match(saved.messages[0].content, new RegExp(ref.id))
  assert.deepEqual(saved.messages[0].artifactRefs, [ref])
  assert.equal((await artifactAccess.read({ id: ref.id, limit: 1 })).size, 6000)
})

test('governed model loop receives a receipt and retrieves the omitted tail without rerunning Bash', async () => {
  const command = await scriptCommand(`${'log line\n'.repeat(20000)}TAIL_MARKER\n`)
  let calls = 0, artifactId
  registerProvider('artifact-fixture', {
    request: async () => ({ text: 'done', toolCalls: [] }),
    async *requestStream(input) {
      const index = calls++
      if (!index) yield { type: 'tool_call', call: { id: 'bash-live', name: 'bash', args: { command } } }
      else if (index === 1) {
        const result = input.messages.at(-1).content.find(block => block.type === 'tool_result')
        artifactId = /art_[0-9a-f-]{36}/.exec(result.content)?.[0]
        assert.ok(artifactId, result.content.slice(0, 300))
        assert.ok(input.tools.some(tool => tool.name === 'artifact_search'))
        yield { type: 'tool_call', call: { id: 'search-live', name: 'artifact_search', args: { artifact_id: artifactId, query: 'TAIL_MARKER' } } }
      } else {
        const result = input.messages.at(-1).content.find(block => block.type === 'tool_result')
        assert.equal(JSON.parse(result.content).matches.length, 1)
        yield { type: 'text', content: 'Archived output verified without repeating the command.' }
      }
      yield { type: 'usage', usage: { input: 10, output: 5 } }
    }
  })
  const result = await runWithRuntime({ cwd }, () => processTurnLoop({ prompt: 'Inspect the output.', mode: 'agent', model: 'fixture', providerType: 'artifact-fixture', sessionId, configState: { config } }))
  assert.match(result.reply, /Archived output verified/)
  assert.equal(result.toolEvents.filter(tool => tool.name === 'bash').length, 1)
  assert.ok(artifactId)
})

test('real loop retains all branded binary outputs and discards forged multi-output references', async t => {
  const tool = await ToolRegistry.get('read'), original = tool.execute, refs = []
  tool.execute = async (_args, ctx) => {
    for (const value of ['document one', 'document two']) refs.push(await archiveBinaryArtifact({ access: ctx.artifactAccess, content: Buffer.from(value), callId: ctx.toolCallId }))
    return { output: 'Two generated files are available.', metadata: { artifactRefs: [...refs, { id: 'art_00000000-0000-0000-0000-000000000000', sha256: 'a'.repeat(64), size: 99 }] } }
  }
  t.after(() => { tool.execute = original })
  let calls = 0
  registerProvider('artifact-fixture', {
    request: async () => ({ text: 'done', toolCalls: [] }),
    async *requestStream() {
      if (!calls++) yield { type: 'tool_call', call: { id: 'binary-many', name: 'read', args: { path: 'fixture.txt' } } }
      else yield { type: 'text', content: 'Multiple outputs retained.' }
    }
  })
  const result = await runWithRuntime({ cwd }, () => processTurnLoop({ prompt: 'Read a controlled multi-output fixture.', mode: 'agent', model: 'fixture', providerType: 'artifact-fixture', sessionId, configState: { config } }))
  assert.match(result.reply, /Multiple outputs retained/)
  assert.equal(refs.length, 2)
  assert.deepEqual(result.toolEvents[0].metadata.artifactRefs.map(ref => ref.id), refs.map(ref => ref.id))
  const saved = await getSession(sessionId)
  assert.deepEqual(collectArtifactReferences(saved.messages).map(ref => ref.id), refs.map(ref => ref.id))
  assert.ok(saved.parts.some(part => part.metadata?.artifactRefs?.length === 2))
})

test('fresh archive IDs do not bypass the real loop no-progress warning and stop', async () => {
  const command = await scriptCommand('unchanged log\n'.repeat(16000))
  config.agent.max_steps = 9
  let providerCalls = 0
  registerProvider('artifact-fixture', {
    request: async () => ({ text: 'done', toolCalls: [] }),
    async *requestStream() {
      providerCalls++
      yield { type: 'tool_call', call: { id: `repeated-bash-${providerCalls}`, name: 'bash', args: { command } } }
    }
  })
  const result = await runWithRuntime({ cwd }, () => processTurnLoop({ prompt: 'Run a repetition fixture.', mode: 'agent', model: 'fixture', providerType: 'artifact-fixture', sessionId, configState: { config } }))
  assert.equal(result.stopReason, 'no-progress')
  assert.equal(providerCalls, 6)
  assert.equal(result.toolEvents.length, 6)
  const refs = result.toolEvents.map(event => event.metadata.artifactRef)
  assert.equal(new Set(refs.map(ref => ref.id)).size, 6, 'each call really produced a distinct receipt')
  assert.equal(new Set(refs.map(ref => ref.sha256)).size, 1, 'captured evidence did not change')
  const stored = await getSession(sessionId)
  assert.ok(stored.messages.some(message => typeof message.content === 'string' && message.content.startsWith('[NO PROGRESS]')))
})

test('changed content beyond the archived preview remains progress in the real loop', async () => {
  const script = path.join(cwd, 'changing.mjs')
  await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs';\nlet n = 0; try { n = Number(readFileSync('counter.txt', 'utf8')) } catch {}\nwriteFileSync('counter.txt', String(++n));\nprocess.stdout.write('unchanged prefix\\n'.repeat(16000) + 'counter=' + n);\n`)
  const command = `${quote(process.execPath)} ${quote(script)}`
  config.agent.max_steps = 6
  let providerCalls = 0
  registerProvider('artifact-fixture', {
    request: async () => ({ text: 'done', toolCalls: [] }),
    async *requestStream() {
      yield { type: 'tool_call', call: { id: `changed-bash-${++providerCalls}`, name: 'bash', args: { command } } }
    }
  })
  const result = await runWithRuntime({ cwd }, () => processTurnLoop({ prompt: 'Run a changing-output fixture.', mode: 'agent', model: 'fixture', providerType: 'artifact-fixture', sessionId, configState: { config } }))
  assert.notEqual(result.stopReason, 'no-progress')
  assert.equal(providerCalls, 6)
  assert.equal(new Set(result.toolEvents.map(event => event.metadata.artifactRef.sha256)).size, 6)
})

test('governed tool config cannot widen a source policy through mutable config or toolContext overrides', async () => {
  let calls = 0, fetches = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { fetches++; throw new Error('network must not be reached') }
  registerProvider('artifact-fixture', {
    request: async () => ({ text: 'done', toolCalls: [] }),
    async *requestStream(input) {
      if (calls++ === 0) {
        config.data_policy = undefined // Simulate a later effective-config mutation.
        yield { type: 'tool_call', call: { id: 'web-policy', name: 'webfetch', args: { url: 'https://blocked.invalid/' } } }
      } else {
        const output = input.messages.at(-1).content.find(block => block.type === 'tool_result')
        assert.equal(output.is_error, true)
        assert.match(output.content, /数据出域策略拒绝/)
        yield { type: 'text', content: 'Policy held.' }
      }
    }
  })
  try {
    const result = await runWithRuntime({ cwd }, () => processTurnLoop({ prompt: 'Check policy.', mode: 'agent', model: 'fixture', providerType: 'artifact-fixture', sessionId,
      configState: { config, source: { userRaw: { data_policy: { web_origins: ['https://allowed.invalid'] } } } },
      toolContext: { config: { data_policy: { web_origins: ['https://blocked.invalid'] } } } }))
    assert.match(result.reply, /Policy held/)
    assert.equal(fetches, 0)
  } finally { globalThis.fetch = originalFetch }
})
