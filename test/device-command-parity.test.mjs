import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BUILTIN_COMMANDS, COMMAND_CLIENT_ACTIONS, DEVICE_COMMAND_HANDLERS, publicCommandCatalog } from '../src/command/builtin.mjs'
import { runDeviceCommand, listDeviceCommands } from '../src/device/commands.mjs'
import { getDeviceProfile, updateDeviceProfile } from '../src/device/profile.mjs'
import { SessionTree } from '../src/device/session-tree.mjs'
import { createKernel } from '../src/kernel/index.mjs'
import { createQuestionPromptChannel } from '../src/kernel/tool/question-prompt.mjs'
import { createPermissionPromptChannel } from '../src/kernel/permission/prompt.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'

async function fixture(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-command-parity-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(directory, 'state')
  await mkdir(process.env.KKCODE_HOME)
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.yaml'), 'provider:\n  default: fixture\n  fixture:\n    type: openai\n    base_url: http://127.0.0.1:9/v1\n    api_key: fixture\n    default_model: fixture-model\nmcp:\n  auto_discover: false\nskills:\n  auto_seed: false\n')
  const kernel = await createKernel({ cwd: directory, trust: true, boot: false })
  const calls = [], states = new Map(), sessions = new Map([['current', { id: 'current', cwd: directory, title: 'Current', mode: 'assistant', providerType: 'fixture', model: 'fixture-model' }]])
  const originalGet = kernel.sessions.getSession, originalList = kernel.sessions.listSessions
  kernel.sessions.getSession = async id => sessions.has(id) ? { session: sessions.get(id) } : null
  kernel.sessions.listSessions = async () => [...sessions.values()]
  const service = { metadata: {}, commandStates: states, async dispatch(method, params) {
    calls.push({ method, params })
    if (method === 'sessions.configure') {
      const state = { sessionId: params.sessionId, ...states.get(params.sessionId), ...params }
      if (params.provider) state.providerType = params.provider
      if (params.mode) state.modeId = params.mode
      states.set(params.sessionId, state); return state
    }
    if (method === 'sessions.create') { sessions.set('created', { id: 'created', cwd: directory }); return { id: 'created', cwd: directory } }
    if (method === 'control.acquire' || method === 'control.release') return {}
    if (method === 'models.discover') return { models: ['fixture-model'], items: [{ model: 'fixture-model', provider: 'fixture' }], source: 'fixture' }
    if (method === 'turns.start') return { accepted: true, turnId: 'fixture-turn' }
    throw new Error(`Unexpected method ${method}`)
  } }
  const run = command => runDeviceCommand({ service, kernel, sessionId: 'current', command, principal: { id: 'local', client: 'test' } })
  try { await fn({ directory, kernel, calls, run, sessions }) } finally {
    kernel.sessions.getSession = originalGet; kernel.sessions.listSessions = originalList
    await kernel.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
}

test('remote dispatch policy exhaustively covers every builtin and alias once', () => {
  assert.deepEqual(Object.keys(DEVICE_COMMAND_HANDLERS).sort(), BUILTIN_COMMANDS.map(entry => entry.names[0]).sort())
  const catalog = publicCommandCatalog(), names = catalog.flatMap(c => [c.name, ...c.aliases])
  assert.equal(names.length, new Set(names).size)
  assert.equal(catalog.length, BUILTIN_COMMANDS.length)
  assert.deepEqual(new Set(COMMAND_CLIENT_ACTIONS), new Set(['exit', 'clear', 'keys', 'theme', 'paste', 'profile', 'like', 'home', 'sessions', 'session', 'models', 'provider', 'mode', 'permission']))
})

test('all remote builtins have an executable action or a shared handler, never a raw picker flag', () => fixture(async ({ run }) => {
  for (const entry of BUILTIN_COMMANDS) {
    const expensive = ['btw', 'status', 'compact', 'undo', 'rewind', 'board', 'commands', 'reload', 'mcp', 'agents', 'tasks', 'skills', 'trust', 'untrust'].includes(entry.names[0])
    const original = entry.run
    let sharedCalls = 0
    // Infrastructure/model behavior is covered by dedicated tests; this matrix
    // verifies that every advertised command reaches its intended handler.
    if (expensive) entry.run = ({ print }) => { sharedCalls++; print('fixture output'); return { exit: false } }
    try {
      for (const alias of entry.names) {
        const response = await run(`/${alias}${entry.argMode === 'required' ? ' fixture input' : ''}`)
        assert.ok(response && typeof response === 'object', alias)
        assert.ok(response.clientAction || Array.isArray(response.output) || response.accepted, alias)
        assert.equal(Object.keys(response.action || {}).some(key => /^open.*Picker$/.test(key)), false, alias)
      }
      if (expensive) assert.equal(sharedCalls, entry.names.length, entry.names[0])
    } finally { entry.run = original }
  }
}))

test('provider/model/mode aliases persist selection and preserve read-only plan rewrite', () => fixture(async ({ run, calls }) => {
  await run('/p fixture'); assert.deepEqual(calls.at(-1), { method: 'sessions.configure', params: { sessionId: 'current', provider: 'fixture' } })
  await run('/model model-v2'); assert.equal(calls.at(-1).params.model, 'model-v2')
  await run('/m code'); assert.equal(calls.at(-1).params.mode, 'agent')
  await run('/mode agent-auto'); assert.equal(calls.at(-1).params.mode, 'agent-auto')
  await run('/plan inspect safely'); assert.equal(calls.at(-1).method, 'turns.start'); assert.equal(calls.at(-1).params.mode, 'plan'); assert.match(calls.at(-1).params.prompt, /Do not edit project source files/)
  await run('/ultra /model malicious'); assert.equal(calls.at(-1).params.prompt, '/model malicious')
  for (const command of ['/provider unknown', '/mode unknown', '/help extra', '/theme neon', '/ultra hybrid']) await assert.rejects(run(command), error => Boolean(error.code), command)
}))

test('selectors preserve editing intent and new/resume reference actual persisted sessions', () => fixture(async ({ run, sessions, calls }) => {
  assert.equal((await run('/p')).clientAction, 'provider')
  assert.equal((await run('/provider edit fixture')).args, 'edit fixture')
  assert.equal((await run('/provider add')).args, 'add')
  assert.equal((await run('/model refresh')).clientAction, 'models')
  assert.equal((await run('/history')).items[0].id, 'current')
  assert.equal((await run('/n')).sessionId, 'created'); assert.ok(sessions.has('created'))
  assert.ok(calls.some(call => call.method === 'sessions.configure' && call.params.sessionId === 'created' && call.params.model === 'fixture-model' && call.params.provider === 'fixture'))
  assert.equal((await run('/r current')).sessionId, 'current')
  sessions.set('current-too', { id: 'current-too' })
  await assert.rejects(run('/resume cur'), error => error.code === 'ambiguous_session')
}))

test('custom commands appear in the remote catalog and expand in the device workspace', () => fixture(async ({ directory, kernel, run, calls }) => {
  await mkdir(path.join(directory, '.kkcode', 'commands'), { recursive: true })
  await writeFile(path.join(directory, '.kkcode', 'commands', 'fixture-custom.md'), 'Inspect $ARGUMENTS in {{cwd}}')
  assert.ok((await listDeviceCommands({ kernel })).some(c => c.name === 'fixture-custom'))
  assert.equal((await run('/fixture-custom main')).accepted, true)
  assert.match(calls.at(-1).params.prompt, /Inspect main/)
  assert.ok(calls.at(-1).params.prompt.includes(directory))
  await assert.rejects(run('/not-registered'), error => error.code === 'unknown_command')
}))

test('permission selection reaches runtime config and session state, with actual per-kernel cache clear', () => fixture(async ({ kernel, run, calls }) => {
  let cleared
  kernel.permissions.clearSession = id => { cleared = id }
  await run('/permission yolo')
  assert.equal(kernel.configState.config.permission.level, 'yolo')
  assert.equal(calls.at(-1).params.approval, 'yolo')
  await run('/permission session-clear'); assert.equal(cleared, 'current')
  assert.equal((await run('/permission')).clientAction, 'permission')
}))

test('profile preferences have validated fields and private atomic persistence', () => fixture(async () => {
  const saved = await updateDeviceProfile({ beginner: false, languages: ['中文'], tech_stack: ['Kotlin'], design_style: 'minimal', extra_notes: 'Brief answers' })
  assert.equal((await updateDeviceProfile({ extra_notes: 'Updated' })).created_at, saved.created_at)
  assert.equal((await getDeviceProfile()).languages[0], '中文')
  const file = path.join(process.env.KKCODE_HOME, 'profile.yaml')
  assert.equal((await stat(file)).isFile(), true)
  assert.match(await readFile(file, 'utf8'), /Updated/)
  assert.equal((await readdir(process.env.KKCODE_HOME)).some(name => /^profile\.yaml\..*\.tmp$/.test(name)), false)
  // Windows reports synthesized POSIX bits (0666); actual access is controlled
  // by the containing profile directory's ACL, not these bits.
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  for (const input of [{ organization: 'forged' }, { languages: 'not-array' }, { beginner: 'yes' }, JSON.parse('{"__proto__":{}}')]) await assert.rejects(updateDeviceProfile(input), error => error.code === 'invalid_profile')
}))

test('session ancestry routes nested approvals through the root without name-prefix inference', async () => {
  const store = new Map([['child', { session: { parentSessionId: 'parent' } }], ['grandchild', { session: { parentSessionId: 'child' } }]])
  const tree = new SessionTree({ getSession: async id => store.get(id) })
  tree.observe({ type: 'subagent.delegated', sessionId: 'child', payload: { subSessionId: 'grandchild', subagent: 'reviewer' } })
  assert.deepEqual(await tree.route('grandchild'), { sessionId: 'parent', originSessionId: 'grandchild', parentSessionId: 'child', ancestry: ['grandchild', 'child', 'parent'], subagent: 'reviewer' })
  assert.equal(tree.remember('grandchild', 'foreign-root'), false)
  assert.equal((await tree.route('sub_parent_guessed')).sessionId, 'sub_parent_guessed')
  tree.remember('parent', 'grandchild')
  await assert.rejects(tree.route('grandchild'), error => error.code === 'invalid_session_tree')
})

test('session ancestry rejects malformed parents and depth exhaustion', async () => {
  await assert.rejects(new SessionTree({ getSession: async () => ({ parentSessionId: '../bad' }) }).route('child'), error => error.code === 'invalid_session_tree')
  const tree = new SessionTree({ maxDepth: 2 }); tree.remember('a', 'b'); tree.remember('b', 'c')
  await assert.rejects(tree.route('a'), error => error.code === 'invalid_session_tree')
})

test('both prompt channels retain trusted child identity without global handler bleed', async () => {
  const questions = createQuestionPromptChannel(), permissions = createPermissionPromptChannel(), seen = []
  questions.setQuestionPromptInterceptor(request => { seen.push(request); return { answer: 'yes' } })
  permissions.setPermissionPromptInterceptor(request => { seen.push(request); return 'allow_once' })
  await runWithRuntime({ sessionId: 'child', parentSessionId: 'root', subagent: 'reviewer' }, async () => {
    await questions.askQuestionInteractive({ questions: [{ id: 'answer', text: 'Continue?' }] })
    await permissions.askPermissionInteractive({ sessionId: 'child', tool: 'write' })
  })
  for (const request of seen) assert.deepEqual([request.sessionId, request.parentSessionId, request.subagent], ['child', 'root', 'reviewer'])
  assert.equal(await createPermissionPromptChannel().askPermissionInteractive({ tool: 'write' }), 'deny')
})

test('cancelled SDK prompts return safe defaults and ignore late human answers', async () => {
  const permission = createPermissionPromptChannel(), question = createQuestionPromptChannel(), controller = new AbortController()
  let allow, answer
  permission.setPermissionPromptHandler(() => new Promise(resolve => { allow = resolve }))
  question.setQuestionPromptHandler(() => new Promise(resolve => { answer = resolve }))
  const pendingPermission = permission.askPermissionInteractive({ tool: 'write', signal: controller.signal })
  const pendingQuestion = question.askQuestionInteractive({ questions: [{ id: 'answer', text: 'Continue?' }], signal: controller.signal })
  await Promise.resolve(); controller.abort()
  assert.equal(await pendingPermission, 'deny'); assert.deepEqual(await pendingQuestion, {})
  allow('allow_always'); answer({ answer: 'continue' })
  assert.equal(await createPermissionPromptChannel().askPermissionInteractive({ tool: 'write', signal: controller.signal, defaultAction: 'allow_once' }), 'deny')
})
