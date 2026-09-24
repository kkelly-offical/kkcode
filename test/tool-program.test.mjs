import test from 'node:test'
import assert from 'node:assert/strict'
import { runToolProgram, createToolProgram } from '../src/kernel/tool/program.mjs'

test('bounded program supports prior-result data, conditional loops and projections', async () => {
  const calls = []
  const result = await runToolProgram({ code: `
    const first = await tools.call("list", {path: "src"});
    const entries = JSON.parse(first.output);
    let count = 0;
    for (const item of entries.slice(0, 3)) {
      if (item.enabled) {
        const file = await tools.call("read", {path: item.path});
        emit({path: item.path, text: file.output.trim()});
        count = count + 1;
      }
    }
    emit({count});
  `, call: async call => {
    calls.push({ name: call.name, args: call.args, index: call.index })
    return { status: 'completed', output: call.name === 'list' ? JSON.stringify([
      { path: 'a.ts', enabled: true }, { path: 'b.ts', enabled: false }, { path: 'c.ts', enabled: true }
    ]) : `  ${call.args.path} content  `, metadata: { privateToken: 'must-not-pass' } }
  } })
  assert.equal(result.status, 'completed')
  assert.deepEqual(calls.map(call => call.index), [0, 1, 2])
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), [{ path: 'a.ts', text: 'a.ts content' }, { path: 'c.ts', text: 'c.ts content' }, { count: 2 }])
  assert.equal(JSON.stringify(result).includes('privateToken'), false)
  assert.equal(result.atomic, false)
})

test('unsupported syntax is rejected before any preceding leaf can execute', async () => {
  const attacks = ['while(true){}', 'for(;;){}', 'import("node:fs")', 'process.exit()', 'new Function("return process")()',
    'const x={get token(){return 1}}', 'const x=()=>1', 'Promise.resolve(1)', '({}).constructor', 'const x=2**999', 'eval("1")']
  for (const attack of attacks) {
    let calls = 0
    await assert.rejects(runToolProgram({ code: `await tools.call("write", {path:"should-not-exist"}); ${attack}`, call: async () => { calls++; return { status: 'completed', output: '' } } }))
    assert.equal(calls, 0, attack)
  }
})

test('dynamic prototype paths and parsed thenables cannot escape the pure-data subset', async () => {
  for (const code of [
    'const key="con"+"structor"; return ({} )[key];',
    'return JSON.parse("{\\"__proto__\\":{\\"polluted\\":true}}");',
    'return JSON.parse("{\\"then\\":true}");'
  ]) {
    const result = await runToolProgram({ code, call: async () => { throw new Error('must not call') } })
    assert.equal(result.status, 'error')
    assert.equal(result.code, 'program_property')
  }
  assert.equal({}.polluted, undefined)
})

test('every denied, failed or unknown leaf stops without rollback or replay', async () => {
  for (const state of ['blocked', 'error', 'cancelled', 'unknown']) {
    let calls = 0
    const result = await runToolProgram({ code: 'await tools.call("write",{path:"first"}); await tools.call("write",{path:"blocked"}); await tools.call("write",{path:"last"});',
      call: async () => { calls++; return { status: calls === 1 ? 'completed' : state, output: calls === 1 ? 'changed' : 'stopped' } } })
    assert.equal(calls, 2)
    assert.equal(result.status, 'error')
    assert.equal(result.calls[0].status, 'completed')
    assert.equal(result.outcomeUnknown, state === 'unknown')
  }
  let calls = 0
  const uncertain = await runToolProgram({ code: 'await tools.call("write",{}); await tools.call("write",{});', call: async () => {
    calls++; return { status: 'completed', output: 'transport returned before effect was confirmed', outcomeUnknown: true }
  } })
  assert.equal(calls, 1)
  assert.equal(uncertain.status, 'error')
  assert.equal(uncertain.outcomeUnknown, true)
})

test('call, steps, bytes, loops and timeout limits are independent and bounded', async () => {
  const call = async () => ({ status: 'completed', output: 'ok' })
  const calls = await runToolProgram({ code: 'for(const n of [1,2,3]){await tools.call("read",{path:"x"});}', call, limits: { max_calls: 2 } })
  assert.equal(calls.code, 'program_calls'); assert.equal(calls.calls.length, 2)
  assert.equal(calls.outcomeUnknown, false, 'a rejected extra call was never dispatched')
  assert.equal((await runToolProgram({ code: 'for(const n of [1,2,3]){emit(n);}', call, limits: { max_steps: 5 } })).code, 'program_steps')
  assert.equal((await runToolProgram({ code: 'let text="abcdefghijklmnop"; for(const n of [1,2,3,4]){text=text+text;} return 1;', call, limits: { max_total_bytes: 200 } })).code, 'program_bytes', 'intermediate allocations also consume the aggregate budget')
  const bytes = await runToolProgram({ code: 'const out=await tools.call("read",{path:"x"}); return out;', call: async () => ({ status: 'completed', output: 'x'.repeat(10000) }), limits: { max_value_bytes: 1000 } })
  assert.equal(bytes.code, 'program_value_limit'); assert.equal(bytes.calls.length, 1, 'already performed operation is retained even if its output is too big')
  assert.equal((await runToolProgram({ code: `for(const n of "${'x'.repeat(129)}".split("")){emit(n);}`, call })).code, 'program_loop')
  const controller = new AbortController()
  const pending = runToolProgram({ code: 'await tools.call("write",{path:"x"}); await tools.call("write",{path:"no"});', signal: controller.signal,
    call: async input => { assert.equal(input.signal.aborted, false); return new Promise(() => {}) } })
  setTimeout(() => controller.abort(), 30)
  const cancelled = await pending
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.outcomeUnknown, true)
})

test('join checks expanded bytes before allocation and never coerces objects', async () => {
  const call = async () => ({ status: 'completed', output: 'x'.repeat(500) })
  const over = await runToolProgram({ code: 'const r=await tools.call("read",{}); return [1,2,3,4].join(r.output);', call, limits: { max_value_bytes: 1000 } })
  assert.equal(over.code, 'program_value_limit')
  assert.equal(over.outcomeUnknown, false)
  const objects = await runToolProgram({ code: 'return [{x:1}].join();', call })
  assert.equal(objects.code, 'program_value')
  const scalars = await runToolProgram({ code: 'return [1,null,"ok",false].join("/");', call })
  assert.equal(scalars.value, '1//ok/false')
})

test('nested control operations are rejected and experimental feature stays off by default', async () => {
  for (const name of ['tool_batch', 'tool_program', 'task', 'task_group', 'skill', 'enter_plan']) {
    let calls = 0
    const result = await runToolProgram({ code: `await tools.call("${name}", {});`, call: async () => { calls++ } })
    assert.equal(result.code, 'program_tool'); assert.equal(calls, 0)
  }
  const tool = createToolProgram()
  await assert.rejects(tool.execute({ code: 'return 1;' }, { config: {}, runToolProgramCall() {} }), { code: 'program_disabled' })
  await assert.rejects(tool.execute({ code: 'return 1;' }, { config: { tool: { program: { enabled: true } } }, runToolProgramCall() {} }), { code: 'program_host_required' })
})
