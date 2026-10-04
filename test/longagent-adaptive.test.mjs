import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_CONFIG } from '../src/config/defaults.mjs'
import { runLongAgent } from '../src/kernel/session/longagent.mjs'
import { registerProvider } from '../src/kernel/provider/router.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { LongAgentManager } from '../src/kernel/orchestration/longagent-manager.mjs'
import { getSession, flushNow } from '../src/kernel/session/store.mjs'
import { createKernel } from '../src/kernel/kernel.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'kkcode-adaptive-')), cwd=path.join(root,'work')
  await mkdir(cwd)
  const oldHome=process.env.KKCODE_HOME; process.env.KKCODE_HOME=path.join(root,'state')
  t.after(async()=>{await flushNow(); if(oldHome===undefined) delete process.env.KKCODE_HOME;else process.env.KKCODE_HOME=oldHome;await rm(root,{recursive:true,force:true})})
  const config=structuredClone(DEFAULT_CONFIG)
  config.provider={default:'adaptive-fixture', 'adaptive-fixture':{default_model:'fixture',stream:false,context_limit:32768,max_tokens:2048}}
  config.session.title_generation=false
  return {cwd, configState:{config}, sessionId:'adaptive-fixture-session',model:'fixture',providerType:'adaptive-fixture',output:{write(){}}}
}

test('ordinary Ultra completes a non-code request without blueprint, testing or continuation prompts', async t=>{
  const args=await fixture(t), calls=[]
  registerProvider('adaptive-fixture',{request:async input=>{calls.push(input);return{text:'整理完毕。',toolCalls:[],usage:{input:20,output:4}}},async *requestStream(){}})
  const result=await runWithRuntime({cwd:args.cwd},()=>runLongAgent({...args,prompt:'把这段日程整理成三条：晨会、备份、报告'}))
  assert.equal(calls.length,1)
  assert.equal(result.status,'completed')
  assert.equal(result.orchestration,'adaptive')
  const saved=await LongAgentManager.get(args.sessionId,args.cwd)
  assert.equal(saved.status,'completed');assert.equal(saved.completionPolicy,'observational')
  assert.equal(saved.iterations,1)
  const session=await getSession(args.sessionId)
  assert.equal(session.session.mode,'longagent')
  assert.equal(session.messages.filter(m=>m.role==='user' && !m.synthetic).length,1)
  assert.ok(!JSON.stringify(calls[0]).includes('stage_plan_json'))
})

test('adaptive Ultra preserves explicit step budget and accepts host stop without restarting work', async t=>{
  const args=await fixture(t)
  let ready; const started=new Promise(resolve=>{ready=resolve})
  const running=runWithRuntime({cwd:args.cwd},()=>runLongAgent({...args,prompt:'bounded fixture',maxIterations:3,deps:{processTurnLoop:async input=>{
    assert.equal(input.configState.config.agent.max_steps,3)
    ready()
    await new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}))
  }}}))
  await started
  await LongAgentManager.stop(args.sessionId,args.cwd)
  await assert.rejects(running,/stopped/)
  const saved=await LongAgentManager.get(args.sessionId,args.cwd)
  assert.equal(saved.status,'user_stopped')
  assert.equal(saved.stopRequested,true)
})

test('adaptive Ultra executes a requested file action once and preserves the resulting evidence', async t => {
  const args=await fixture(t)
  args.configState.config.permission={level:'yolo',rules:[]}
  args.configState.config.skills.enabled=false
  args.configState.config.mcp.auto_discover=false
  const kernel=await createKernel({cwd:args.cwd,trustState:{trusted:true},config:args.configState})
  try {
  let requests=0
  kernel.providers.registerProvider('adaptive-fixture',{async request(){assert.fail('stream only')},async *requestStream(){
    requests++
    if(requests===1) yield {type:'tool_call',call:{id:'write-notes',name:'write',args:{path:'notes.txt',content:'Meeting notes'}}}
    else yield {type:'text',content:'笔记已保存。'}
    yield {type:'usage',usage:{input:30,output:8}}
  }})
  // Enable the streaming fixture independently of the text-only test above.
  kernel.configState.config.provider['adaptive-fixture'].stream=true
  const result=await kernel.executeTurn({prompt:'保存会议笔记。',sessionId:args.sessionId,mode:'longagent',providerType:'adaptive-fixture',model:'fixture',output:{write(){}}})
  assert.equal(requests,2)
  const {readFile}=await import('node:fs/promises')
  assert.equal(await readFile(path.join(args.cwd,'notes.txt'),'utf8'),'Meeting notes')
  assert.ok((await LongAgentManager.get(args.sessionId,args.cwd)).status === 'completed')
  assert.ok(result.reply.includes('笔记已保存'))
  } finally { await kernel.shutdown() }
})
