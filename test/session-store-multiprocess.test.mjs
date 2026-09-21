import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const storeUrl = new URL('../src/kernel/session/store.mjs', import.meta.url).href
const script = `
import * as store from ${JSON.stringify(storeUrl)};
store.configureSessionStore({flushIntervalMs: 60000});
let chain = Promise.resolve();
process.on('message', command => {
  chain = chain.then(async () => {
    let result;
    if(command.action === 'seed') {
      await store.touchSession({sessionId:'parent',mode:'assistant',model:'fixture',providerType:'fixture',cwd:process.cwd(),title:'User title'});
      await store.updateSession('parent',{userMetadata:{keep:true},modeId:'agent-auto',approval:'manual'});
      await store.flushNow();
    }
    if(command.action === 'preload') { await store.getSession('parent'); await store.listSessions(); }
    if(command.action === 'mutate') {
      const id = command.child;
      await store.touchSession({sessionId:id,parentSessionId:'parent',mode:'agent',model:'fixture',providerType:'fixture',cwd:process.cwd()});
      await store.appendUserMessage(id, 'child message ' + id);
      await store.updateSession('parent',{['field_'+id]:id});
      await store.appendUserMessage('parent',id);
      await store.appendPart('parent',{type:'fixture',child:id});
      await store.applyReviewDecision('parent',{child:id,decision:'accept'});
    }
    if(command.action === 'append') { await store.appendUserMessage('parent',command.text); }
    if(command.action === 'replace') { await store.replaceMessages('parent',command.messages); }
    if(command.action === 'fork') result = await store.forkSession({sessionId:'parent',newSessionId:command.target});
    if(command.action === 'get') result = await store.getSession(command.sessionId);
    if(command.action === 'flush') await store.flushNow();
    if(command.action === 'read') result = {sessions: await store.listSessions(), parent: await store.getSession('parent'), history:await store.getConversationHistory('parent',100)};
    process.send({id:command.id,result});
    if(command.action === 'exit') { await store.flushNow(); process.disconnect(); process.exit(0); }
  }).catch(error=>process.send({id:command.id,error:error.stack}));
});
process.send({ready:true});
`

async function worker(root) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: { ...process.env, KKCODE_HOME: path.join(root, 'state') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = '', counter = 0
  child.stderr.on('data', chunk => { stderr += chunk })
  await once(child, 'message')
  return { child, request(action, extra = {}) {
    const id = String(++counter)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.off('message', reply); reject(new Error(`worker ${action} timed out: ${stderr}`)) }, 10000)
      function reply(message) { if (message.id === id) { clearTimeout(timer); child.off('message', reply); message.error ? reject(new Error(message.error)) : resolve(message.result) } }
      child.on('message', reply); child.send({ id, action, ...extra })
    })
  }, async close() { if (child.exitCode !== null) return; const exited = once(child, 'exit'); await this.request('exit'); await exited } }
}

test('independent cached writers preserve all child sessions, parent fields, messages, parts and review decisions', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-store-processes-')), workers = []
  try {
    for (let i = 0; i < 4; i++) workers.push(await worker(root))
    await workers[0].request('seed')
    await Promise.all(workers.map(w => w.request('preload')))
    await Promise.all(workers.slice(1).map((w, i) => w.request('mutate', { child: `child${i}` })))
    // All writers intentionally cached the old index, then flush in a known
    // order. Atomic rename alone cannot preserve their independent updates.
    for (const w of workers.slice(1)) await w.request('flush')
    const freshReader = await worker(root); workers.push(freshReader)
    const persisted = await freshReader.request('read')
    assert.deepEqual(persisted.sessions.map(s => s.id).sort(), ['child0', 'child1', 'child2', 'parent'], 'later flush must not overwrite independent sessions')
    const observed = await workers[0].request('read')
    assert.deepEqual(observed.sessions.map(s => s.id).sort(), ['child0', 'child1', 'child2', 'parent'])
    assert.deepEqual(observed.parent.session.userMetadata, { keep: true })
    assert.equal(observed.parent.session.title, 'User title')
    assert.equal(observed.parent.session.approval, 'manual')
    for (let i = 0; i < 3; i++) assert.equal(observed.parent.session[`field_child${i}`], `child${i}`)
    assert.deepEqual(observed.parent.messages.map(m => m.content).sort(), ['child0', 'child1', 'child2'])
    assert.deepEqual(observed.parent.parts.map(p => p.child).sort(), ['child0', 'child1', 'child2'])
    assert.deepEqual(observed.parent.session.reviewDecisions.map(d => d.child).sort(), ['child0', 'child1', 'child2'])
    assert.deepEqual(observed.history.map(m => m.content).sort(), ['child0', 'child1', 'child2'])
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(root, 'state', 'sessions', 'index.json'))).mode & 0o777, 0o600)
      assert.equal((await stat(path.join(root, 'state', 'sessions', 'parent.json'))).mode & 0o777, 0o600)
    }
  } finally { await Promise.allSettled(workers.map(w => w.close())); for (const w of workers) if (w.child.exitCode === null) w.child.kill(); await rm(root, { recursive: true, force: true }) }
})

test('invalid IDs and damaged shards fail closed instead of overwriting recoverable data', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-store-corruption-')), w = await worker(root)
  try {
    await w.request('seed')
    await assert.rejects(w.request('mutate', { child: '../outside' }), /Invalid session id/)
    await w.request('flush')
    const file = path.join(root, 'state', 'sessions', 'parent.json'), damaged = '{"unexpected":"keep this recovery evidence"}'
    await writeFile(file, damaged)
    await w.request('append', { text: 'must not replace corruption with an empty history' })
    await assert.rejects(w.request('flush'), /Invalid session data/)
    assert.equal(await readFile(file, 'utf8'), damaged)
  } finally { w.child.kill(); await once(w.child, 'exit'); await rm(root, { recursive: true, force: true }) }
})

test('a buffered rewind preserves messages concurrently appended by another process', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-store-rewind-processes-')), workers = []
  try {
    workers.push(await worker(root), await worker(root))
    await workers[0].request('seed')
    await workers[0].request('append', { text: 'old turn' }); await workers[0].request('flush')
    await workers[1].request('preload')
    await workers[1].request('replace', { messages: [] })
    await workers[0].request('append', { text: 'new concurrent turn' }); await workers[0].request('flush')
    await workers[1].request('flush'); await workers[1].request('flush')
    const observed = await workers[0].request('read')
    assert.deepEqual(observed.parent.messages.map(message => message.content), ['new concurrent turn'])
    assert.equal(observed.parent.session.title, 'User title')
  } finally { await Promise.allSettled(workers.map(w => w.close())); for (const w of workers) if (w.child.exitCode === null) w.child.kill(); await rm(root, { recursive: true, force: true }) }
})

test('two processes cannot overwrite the same fork target or poison later store operations', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-store-fork-processes-')), workers = []
  try {
    workers.push(await worker(root), await worker(root))
    await workers[0].request('seed'); await workers[0].request('append', { text: 'source evidence' }); await workers[0].request('flush')
    const attempts = await Promise.allSettled(workers.map(w => w.request('fork', { target: 'same-fork' })))
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    assert.match(attempts.find(result => result.status === 'rejected').reason.message, /already exists/)
    const fork = await workers[0].request('get', { sessionId: 'same-fork' })
    assert.equal(fork.session.parentSessionId, 'parent')
    assert.deepEqual(fork.messages.map(message => message.content), ['source evidence'])
    for (const [index, w] of workers.entries()) { await w.request('append', { text: `after conflict ${index}` }); await w.request('flush') }
    assert.equal((await workers[0].request('read')).parent.messages.length, 3)
  } finally { await Promise.allSettled(workers.map(w => w.close())); for (const w of workers) if (w.child.exitCode === null) w.child.kill(); await rm(root, { recursive: true, force: true }) }
})
