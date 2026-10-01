import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm, writeFile, access} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {ToolRegistry} from '../src/kernel/tool/registry.mjs'
import {executeTool} from '../src/kernel/tool/executor.mjs'
import {isToolNotStarted} from '../src/kernel/core/execution-outcome.mjs'
import {evaluateCompletionEvidence} from '../src/kernel/session/completion-evidence.mjs'
import {nodeFixtureCommand} from './fixtures/process-script.mjs'
import {BackgroundManager} from '../src/kernel/orchestration/background-manager.mjs'
import {createKernel} from '../src/kernel/kernel.mjs'

const config={permission:{level:'yolo',rules:[]},git:{auto:{enabled:false}},tool:{sources:{builtin:true,local:false,plugin:false,mcp:false}},language:'en'}
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'kk-bash-owner-')),previous=process.env.KKCODE_HOME
  process.env.KKCODE_HOME=path.join(root,'state')
  t.after(async()=>{
    for(const task of await BackgroundManager.list())if(task.payload?.cwd===root){
      await BackgroundManager.cancel(task.id)
      await BackgroundManager.waitForTask(task.id,{timeoutMs:10000,tickMs:20})
    }
    if(previous===undefined)delete process.env.KKCODE_HOME;else process.env.KKCODE_HOME=previous
    await rm(root,{recursive:true,force:true})
  })
  await ToolRegistry.initialize({cwd:root,config,force:true,allowProjectSources:false})
  const tool=await ToolRegistry.get('bash')
  return{root,tool,call:args=>executeTool({tool,args,sessionId:'bash-owner',turnId:'owner-turn',context:{cwd:root,config}})}
}

for(const background of [false,true])test(`unjoined shell launch is refused before its marker can be written (managed flag ${background})`,{skip:process.platform==='win32'},async t=>{
  const {root,call}=await fixture(t)
  const command=await nodeFixtureCommand(root,"require('node:fs').writeFileSync('unowned-marker','started');setTimeout(()=>{},2000)")
  const result=await call({command:command+' > background.log 2>&1 &\necho "PID=$!"',run_in_background:background})
  assert.equal(result.code,'bash_background_requires_owner')
  assert.equal(isToolNotStarted(result),true)
  assert.equal(result.metadata.started,false)
  assert.equal(result.metadata.operationId,undefined)
  assert.match(result.output,/run_in_background/)
  assert.match(result.output,/node --test/)
  await assert.rejects(access(path.join(root,'unowned-marker')),{code:'ENOENT'})
  await assert.rejects(access(path.join(root,'background.log')),{code:'ENOENT'})
})

test('host-proven undispatched checks do not leave a fictitious failed check to rerun',async t=>{
  const {call}=await fixture(t)
  const rejected=await call({command:'node --test never-executed.test.mjs',timeout:'invalid'})
  assert.equal(isToolNotStarted(rejected),true)
  const verification=evaluateCompletionEvidence({toolEvents:[{...rejected,name:'bash',args:{command:'node --test never-executed.test.mjs'}}]})
  // Object spread cannot carry the host brand: the actual branded receipt is
  // evaluated below, while the unbranded lookalike must remain conservative.
  assert.equal(verification.passed,false)
  rejected.args={command:'node --test never-executed.test.mjs'}
  assert.equal(evaluateCompletionEvidence({toolEvents:[rejected]}).passed,true)
})

test('an owned test harness starts a real HTTP child, verifies it and joins it before completion',async t=>{
  const {root,call}=await fixture(t)
  await writeFile(path.join(root,'service.cjs'),"const http=require('node:http');const server=http.createServer((req,res)=>res.end('ready'));server.listen(0,'127.0.0.1',()=>console.log(server.address().port));\n")
  await writeFile(path.join(root,'service.test.mjs'),[
    "import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';import readline from 'node:readline';",
    "test('bounded owned service',{timeout:10000},async()=>{",
    "const child=spawn(process.execPath,['service.cjs'],{stdio:['ignore','pipe','pipe']});const closed=once(child,'exit');const lines=readline.createInterface({input:child.stdout});",
    "try{const [line]=await once(lines,'line');const port=Number(line);assert.ok(port>0);const result=await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(5000)});assert.equal(await result.text(),'ready');}",
    "finally{child.kill('SIGTERM');await closed;lines.close();}",
    "});"
  ].join('\n'))
  const result=await call({command:'node --test service.test.mjs',timeout:15000})
  assert.equal(result.ok,true,result.output)
  assert.equal(result.metadata.exitCode,0)
  assert.notEqual(result.metadata.outcomeUnknown,true)
  result.args={command:'node --test service.test.mjs'}
  assert.equal(evaluateCompletionEvidence({toolEvents:[result],requireChecks:true}).passed,true)
})

test('a real model loop can repair an undispatched launch with a joined foreground check',{skip:process.platform==='win32'},async t=>{
  const {root}=await fixture(t)
  await writeFile(path.join(root,'owner.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('owned check',()=>assert.equal(6*7,42));\n")
  const kernel=await createKernel({cwd:root,trustState:{trusted:true},config:{config:{...config,
    provider:{default:'owned-fixture','owned-fixture':{default_model:'fixture',retry_attempts:0}},
    agent:{max_steps:4,verify_completion:true},session:{title_generation:false,recovery:false},usage:{budget:{}},ui:{markdown_render:false}
  }}})
  let requests=0
  try{
    kernel.providers.registerProvider('owned-fixture',{
      async request(){throw Error('Controlled stream only')},
      async *requestStream(input){
        requests++
        if(requests===1)yield{type:'tool_call',call:{id:'unowned',name:'bash',args:{command:'node --test owner.test.mjs &'}}}
        else if(requests===2){
          const content=JSON.stringify(input.messages.at(-1).content)
          assert.match(content,/not executed/)
          assert.match(content,/node --test/)
          yield{type:'tool_call',call:{id:'joined',name:'bash',args:{command:'node --test owner.test.mjs'}}}
        }else yield{type:'text',content:'The foreground check completed and its process exited.'}
      }
    })
    const result=await kernel.executeTurn({prompt:'Run and verify the test with owned process lifetime.',sessionId:'owned-loop',model:'fixture',providerType:'owned-fixture'})
    assert.equal(result.status,'completed')
    assert.equal(requests,3)
    assert.equal(result.verification.passed,true)
    assert.equal(result.toolEvents[0].metadata.started,false)
    assert.equal(result.toolEvents[0].metadata.operationId,undefined)
    assert.equal(result.toolEvents[1].metadata.exitCode,0)
  }finally{await kernel.shutdown()}
})

test('finite POSIX parallel work can explicitly wait and continue with ordinary output',{skip:process.platform==='win32'},async t=>{
  const {root,call}=await fixture(t)
  const command=await nodeFixtureCommand(root,"setTimeout(()=>require('node:fs').writeFileSync('joined-marker','joined'),40)")
  const result=await call({command:command+' & wait; echo joined'})
  assert.equal(result.ok,true,result.output)
  await access(path.join(root,'joined-marker'))
  assert.notEqual(result.metadata.outcomeUnknown,true)
})
