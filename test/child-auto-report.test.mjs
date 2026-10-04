import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/kernel.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'
import { createBackgroundTask, readBackgroundTask } from '../src/kernel/orchestration/background-task-store.mjs'
import { createChildController } from '../src/kernel/orchestration/child-controller.mjs'
import { currentRuntime, runWithRuntime } from '../src/kernel/core/runtime-context.mjs'

test('five real background children advance a bounded owned queue and automatically report without model polling', { timeout: 40000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-child-report-')), previous = process.env.KKCODE_HOME
  const home = path.join(root, 'state'), cwd = path.join(root, 'project')
  await mkdir(home); await mkdir(cwd); process.env.KKCODE_HOME = home
  const childResponses = [], parentBodies = [], requests = []
  let woke, waiting, ownerRuntime, released = false
  const parked = new Promise(resolve => { waiting = resolve })
  const response = (res, message) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })) }
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: ['parent-model', 'child-model'].map(id => ({ id, context_length: 131072, max_output_tokens: 4096 })) })); return }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requests.push(body.model)
    if (body.model === 'child-model') { childResponses.push(res); woke?.(); if(released) response(res, {content: `Automatic report ${childResponses.length}: fixture findings.`}); return }
    parentBodies.push(body)
    if (parentBodies.length === 1) response(res, { content: 'Delegate five independent reviews.', tool_calls: [1, 2, 3, 4, 5].map(n => ({ id: `delegate-${n}`, type: 'function', function: { name: 'task', arguments: JSON.stringify({ prompt: `Return report ${n}.`, description: `Review ${n}`, subagent_type: 'explore', run_in_background: true }) } })) })
    else response(res, { content: parentBodies.length === 2 ? 'Collecting the independent reports.' : 'Received child reports and combined the findings.' })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const config = { provider: { default: 'fixture', fixture: { type: 'openai-compatible', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: '', default_model: 'parent-model', stream: false, retry_attempts: 0 } },
    models: { subagent: 'child-model' }, agent: { max_steps: 8, verify_completion: false }, background: { worker_timeout_ms: 20000, max_parallel: 2 },
    permission: { level: 'yolo' }, session: { title_generation: false, recovery: false }, skills: { enabled: false, auto_seed: false }, plugins: { enabled: false }, mcp: { servers: {} } }
  await writeFile(path.join(home, 'config.json'), JSON.stringify(config))
  const kernel = await createKernel({ cwd, trustState: { trusted: true } }), abort = new AbortController()
  let run
  const events = [], unsubscribe = kernel.events.subscribe(event => { events.push(event); if (event.type === 'turn.waiting.children' && event.sessionId === 'parent') { ownerRuntime = currentRuntime(); waiting() } })
  t.after(async () => {
    abort.abort(); childResponses.forEach(res => { if (!res.writableEnded) response(res, { content: 'cancelled fixture' }) })
    await run?.catch(() => {}); unsubscribe(); await kernel.shutdown()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  run = kernel.executeTurn({ sessionId: 'parent', prompt: 'Use five read-only child agents and summarize their reports.', mode: 'agent', model: 'parent-model', providerType: 'fixture', signal: abort.signal })
  await Promise.race([parked, run.then(result => { throw new Error(`Parent did not park: ${result.reply}`) })])
  while (childResponses.length < 2) await new Promise(resolve => { woke = resolve })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(parentBodies.length, 2, 'waiting must not spend additional model requests')
  const tasks = await BackgroundManager.list()
  const template = tasks[0]
  await createBackgroundTask({ ...template, id: 'bg_foreign_queued', status: 'pending', workerPid: null, cancelled: false,
    payload: { ...template.payload, parentSessionId: 'other-parent', subSessionId: 'unrelated-child', childOperationId: 'foreign-operation' } })
  released = true
  childResponses.forEach((res, i) => response(res, { content: `Automatic report ${i + 1}: fixture findings.` }))
  const controller = createChildController({parentSessionId: 'parent', config: kernel.configState.config})
  await runWithRuntime(ownerRuntime, () => Promise.all([0, 1].map(() => controller.startPending({ since: 1, canStart: () => true }))))
  const result = await run
  assert.equal(result.status, 'completed', result.reply)
  assert.ok(parentBodies.length >= 3 && parentBodies.length <= 7)
  assert.equal(requests.filter(model => model === 'child-model').length, 5)
  assert.ok(result.toolEvents.every(event => !['agent_wait', 'task_output'].includes(event.name)))
  assert.ok(parentBodies.every(body => !body.tools.some(tool => tool.function.name === 'agent_wait')))
  const saved = await kernel.sessions.getSession('parent')
  const reports = saved.messages.filter(message => message.childReports?.length)
  assert.equal(reports.flatMap(message => message.childReports).length, 5)
  assert.match(JSON.stringify(parentBodies.at(-1).messages), /Automatic report 1/)
  for (const index of [2, 3, 4, 5]) assert.ok(JSON.stringify(parentBodies.at(-1).messages).includes(`Automatic report ${index}`))
  assert.equal((await readBackgroundTask('bg_foreign_queued')).status, 'pending', 'automatic scheduling must never start another session’s pending work')
  // Durable results can be read before the worker's exit callback has finished
  // publishing its UI snapshot. Observe that separate channel before closing
  // the kernel; do not equate parent completion with synchronous UI delivery.
  const deliveryDeadline = Date.now() + 10000
  while (events.filter(event => event.type === 'subagent.settled' && event.sessionId === 'parent').length < 5 && Date.now() < deliveryDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(events.filter(event => event.type === 'subagent.settled' && event.sessionId === 'parent').length >= 5)
})
