import test from 'node:test';import assert from 'node:assert/strict';
import {classifyVerificationCommand,evaluateCompletionEvidence} from '../src/kernel/session/completion-evidence.mjs';
const shell=(command,extra={})=>({name:'bash',args:{command},status:'completed',ok:true,metadata:{exitCode:0,started:true},...extra});
const edit={name:'write',args:{path:'work/test_delivery.py'},status:'completed',ok:true};
test('success-preserving literal output tails retain actual foreground check identity',()=>{
 for(const command of ['python3 -m py_compile work/test_delivery.py && echo SYNTAX_OK','node --test actual.test.mjs && echo OK','npm test && pwd && ls']){
  const direct=classifyVerificationCommand(command.split(' && ')[0]);
  assert.equal(classifyVerificationCommand(command)?.id,direct.id,command);
 }
});
test('real document chain recognizes the earlier successful compile check before matching unit repair',()=>{
 const events=[edit,shell('cd /workspace/project && python3 -m py_compile work/test_delivery.py && echo SYNTAX_OK'),shell('cd /workspace/project && python3 -m unittest work.test_delivery -v',{status:'error',ok:false,metadata:{exitCode:1,started:true}}),edit,shell('cd /workspace/project && python3 -m unittest work.test_delivery -v')];
 assert.equal(evaluateCompletionEvidence({toolEvents:events,cwd:'/workspace/project'}).passed,true);
});
test('masking, arbitrary effects, expansions and incompatible shell quoting never become proven checks',()=>{
 for(const command of ['npm test || echo OK','npm test; echo OK','npm test | cat','npm test && node program.mjs','npm test && echo $(touch changed)','npm test && echo OK > changed','npm test && echo %UNTRUSTED%','npm test && echo \'x & node program.mjs\''])assert.equal(classifyVerificationCommand(command),null,command);
});
test('failure, unknown capture and different original arguments remain blocked under harmless tails',()=>{
 const command='node --test actual.test.mjs && echo OK';
 for(const event of [shell(command,{status:'error',ok:false,metadata:{exitCode:1,started:true}}),shell(command,{metadata:{exitCode:0,started:true,outcomeUnknown:true}}),shell(command,{metadata:{exitCode:0,started:true,captureIncomplete:true}})])assert.equal(evaluateCompletionEvidence({toolEvents:[edit,event]}).passed,false);
 const failed=shell(command,{status:'error',ok:false,metadata:{exitCode:1,started:true}});
 assert.equal(evaluateCompletionEvidence({toolEvents:[edit,failed,shell('node --test other.test.mjs')]}).passed,false);
 assert.equal(evaluateCompletionEvidence({toolEvents:[edit,failed,shell('node --test actual.test.mjs')]}).passed,true);
});
