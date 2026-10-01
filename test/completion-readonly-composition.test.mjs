import test from 'node:test'
import assert from 'node:assert/strict'
import {toolCapability} from '../src/kernel/permission/rules.mjs'
import {evaluateCompletionEvidence} from '../src/kernel/session/completion-evidence.mjs'
const shell=(command,extra={})=>({name:'bash',args:{command},status:'completed',ok:true,metadata:{exitCode:0,started:true},...extra})
const prefix=[{name:'write',args:{path:'result.txt'},status:'completed',ok:true},shell('node --test actual.test.mjs')]

test('literal cd/list/list/head pipeline does not stale project checks or broaden shell authorization',()=>{
 const command='cd /workspace/project && ls -la outputs/ && ls work/shots/ | head -3'
 assert.equal(toolCapability('bash',command),'risky-shell','effect knowledge is not a new permission grant')
 assert.equal(evaluateCompletionEvidence({toolEvents:[...prefix,shell(command)],cwd:'/workspace/project'}).passed,true)
})

test('bounded read-only lists and pipelines preserve checks across literal conditionals',()=>{
 for(const command of ['ls outputs | head -3','pwd && ls -la','cat output.txt | grep exact | wc -l','ls outputs; head -n 3 report.txt','ls absent || ls outputs','cd "folder with spaces" && tail -n 4 report.txt'])assert.equal(evaluateCompletionEvidence({toolEvents:[...prefix,shell(command)]}).passed,true,command)
})

test('read-only-looking prefixes never hide effectful pipeline leaves, redirection, expansion or backgrounding',()=>{
 for(const command of ['ls | sh','ls && node program.mjs','ls; touch changed.txt','ls > output.txt','ls 2> errors.txt','ls &','ls $(touch changed)','ls `touch changed`','ls "$OTHER"','ls *','ls && (node program.mjs)','PATH=/untrusted ls | head','ls | rg --pre untrusted','ls %UNTRUSTED% | head','ls !UNTRUSTED! | head','ls ^& node program.mjs','ls \'x & node program.mjs\' | head','l\\s | head'])assert.equal(evaluateCompletionEvidence({toolEvents:[...prefix,shell(command)]}).passed,false,command)
})

test('unknown capture, observed writes and changed environment remain barriers for a harmless-looking listing',()=>{
 for(const event of [shell('ls | head',{metadata:{exitCode:0,started:true,outcomeUnknown:true}}),shell('ls | head',{metadata:{exitCode:0,started:true,fileChanges:[{path:'changed.mjs'}]}}),shell('ls | head',{args:{command:'ls | head',env:{PATH:'/untrusted'}}}),shell('ls | head',{metadata:{exitCode:0,started:true,verificationEnvUnknown:true}})])assert.equal(evaluateCompletionEvidence({toolEvents:[...prefix,event]}).passed,false)
})
