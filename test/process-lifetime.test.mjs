import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createKernel} from '../src/kernel/kernel.mjs'
import {BackgroundManager} from '../src/kernel/orchestration/background-manager.mjs'
import {processLifetime, processLogWindow, serviceCommand} from '../src/kernel/tool/process-lifetime.mjs'
import {runManagedProcess} from '../src/kernel/tool/managed-process.mjs'

test('wait windows do not change finite process leases', () => {
  assert.equal(processLifetime({yield_time_ms: 10}).timeoutMs, 120000)
  assert.equal(processLifetime({lifetime: 'service', yield_time_ms: 10}).timeoutMs, 600000)
  assert.equal(processLifetime({lifetime: 'service', timeout: 9e9}).timeoutMs, 3600000)
  for (const command of ['node a.mjs && node b.mjs', 'node "$SCRIPT"', 'node a.mjs > log', 'node a.mjs &']) assert.throws(() => serviceCommand(command))
  assert.match(serviceCommand('PORT=8080 node server.mjs', {platform: 'linux'}), /^exec env /)
})

test('incremental logs disclose evicted output and never replay prior entries', () => {
  const task = {logs: ['second', 'third'], logSequence: 3}
  assert.deepEqual(processLogWindow(task, 2), {cursor: 3, truncated: false, reset: false, output: 'third'})
  assert.equal(processLogWindow(task, 0).truncated, true)
  assert.equal(processLogWindow(task, 3).output, '')
})

test('real managed service survives yielding, serves requests and closes normally before final checks', {skip: process.platform === 'win32' ? 'Graceful POSIX service lifecycle; Windows force-stop remains conservative' : false}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-service-lifetime-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'work'); await mkdir(cwd)
  await writeFile(path.join(cwd, 'service.mjs'), "import http from 'node:http';import fs from 'node:fs';const server=http.createServer((q,r)=>r.end('ready'));server.listen(0,'127.0.0.1',()=>{fs.writeFileSync('port',String(server.address().port));console.log('SERVICE_READY')});process.on('SIGTERM',()=>server.close(()=>{console.log('SERVICE_CLOSED');process.exitCode=0}));\n")
  await writeFile(path.join(cwd, 'check.test.mjs'), "import assert from 'node:assert/strict';import fs from 'node:fs';assert.ok(Number(fs.readFileSync('port','utf8'))>0);\n")
  const kernel = await createKernel({cwd, trustState: {trusted: true}, config: {config: {
    provider: {default: 'service-fixture', 'service-fixture': {default_model: 'fixture', retry_attempts: 0}},
    agent: {max_steps: 10, verify_completion: true}, permission: {level: 'yolo', rules: []},
    tool: {sources: {builtin: true, local: false, plugin: false, mcp: false}},
    session: {title_generation: false, recovery: false}, usage: {budget: {}}, ui: {markdown_render: false}
  }}})
  t.after(async () => {
    for (const task of await kernel.run(() => BackgroundManager.list())) {
      await kernel.run(() => BackgroundManager.cancel(task.id))
      await kernel.run(() => BackgroundManager.waitForTask(task.id, {timeoutMs: 10000}))
    }
    await kernel.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, {recursive: true, force: true})
  })
  let step = 0, taskId, port
  kernel.providers.registerProvider('service-fixture', {
    async request() {throw Error('No external inference')},
    async *requestStream() {
      step++
      const call = (name, args) => ({type: 'tool_call', call: {id: `service-${step}`, name, args}})
      if (step === 1) yield call('bash', {command: 'node service.mjs', lifetime: 'service', timeout: 30000, yield_time_ms: 1000})
      else if (step === 2) {
        const tasks = await BackgroundManager.list(); taskId = tasks[0].id
        assert.equal(tasks[0].status, 'running')
        for (let attempt = 0; !port && attempt < 250; attempt++) {
          try {port = Number(await readFile(path.join(cwd, 'port'), 'utf8'))} catch (error) {if (error.code !== 'ENOENT') throw error}
          if (!port) await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.ok(port, 'the service must report readiness before use')
        assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ready')
        yield call('task_output', {task_id: taskId, cursor: 0})
      } else if (step === 3) yield call('task_stop', {task_id: taskId})
      else if (step === 4) yield call('task_output', {task_id: taskId, wait_ms: 5000})
      else if (step === 5) yield call('bash', {command: 'node --test check.test.mjs'})
      else if (step === 6) yield {type: 'text', content: 'The service was exercised and closed; final checks passed.'}
      else throw Error('Unexpected repair request')
    }
  })
  const result = await kernel.executeTurn({prompt: 'Exercise the service, close it and verify.', sessionId: 'service-owner', providerType: 'service-fixture', model: 'fixture'})
  assert.equal(result.status, 'completed', JSON.stringify(result.verification))
  const task = await kernel.run(() => BackgroundManager.get(taskId))
  assert.equal(task.result.metadata.exitCode, 0)
  assert.equal(task.result.metadata.outcomeUnknown, undefined)
  assert.equal(task.result.metadata.stopRequested, true)
  assert.match(processLogWindow(task).output, /SERVICE_READY/)
  assert.match(processLogWindow(task).output, /SERVICE_CLOSED/)
  await assert.rejects(fetch(`http://127.0.0.1:${port}`))
})

test('an uncooperative service still escalates to a cancelled outcome', {skip: process.platform === 'win32'}, async () => {
  const stop = new AbortController()
  const result = await runManagedProcess({command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
    stopSignal: stop.signal, onOutput: () => stop.abort(), timeoutMs: 5000, gracefulStopMs: 100, killGraceMs: 20})
  assert.equal(result.cancelled, true)
  assert.equal(result.stopRequested, true)
})
