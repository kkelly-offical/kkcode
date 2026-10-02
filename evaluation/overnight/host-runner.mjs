import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {runSerialBatch} from './serial-batch.mjs';
import {renderReport} from './status.mjs';

// Only use an administrator-prepared, frozen evaluation directory. The adapter
// contains deployment identity and cleanup rules; it is not model-supplied code.
if(!process.argv[2])throw Error('Provide the frozen evaluation directory');
const root=path.resolve(process.argv[2]);
const adapter=async name=>import(pathToFileURL(path.join(root,name)).href);
const {remote}=await adapter('connection.mjs');
const {assertFrozen,hash}=await adapter('integrity.mjs');
const {assertParentAllocation}=await adapter('parent-allocation.mjs');
const {QuotaLedger}=await adapter('quota.mjs');
const {limits,runLimits}=await adapter('cases.mjs');
const {guestIdentity}=await adapter('guest-identity.mjs');
const {localBackendDrain}=await adapter('local-backend-drain.mjs');
const {closeNight}=await adapter('close-night.mjs');

// A single bounded attempt per registered case. No automatic feedback retries.
const sequence=['smoke','r1-baseline','r1-research','r1-art','r1-algorithms','r1-fullstack'];
const statusFile=root+'/private/status.json';
if(fs.existsSync(statusFile))throw Error('NEVER_RESTART_OR_OVERWRITE_A_BATCH');
const lock=fs.openSync(root+'/private/batch.lock','wx',0o600);
const {manifest,authority}=assertFrozen(root);assertParentAllocation(root);
let stop=false,latest={status:'starting',active:null,results:[],notRun:sequence};
process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
const writeAtomic=(file,value)=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);};
const metadata={startedAt:new Date().toISOString(),sequence,manifestSha256:authority.manifestSha256,artifactSha256:manifest.release.tarballSha256,deadline:authority.deadline,paidUsd:0,maxConcurrentModelRequests:1,maxConcurrentCases:1};
const save=async state=>{latest=state;writeAtomic(statusFile,{...metadata,...state,updatedAt:new Date().toISOString()});fs.writeFileSync(root+'/private/REPORT.md',renderReport({...metadata,...state},root),{mode:0o600});};
async function execute(id) {
  const log=fs.openSync(root+'/private/batch-'+id+'.log','wx',0o600);
  const controller=await new Promise(resolve=>{
    const child=cp.spawn(process.execPath,[root+'/run.mjs',id],{cwd:root,stdio:['ignore',log,log]});
    child.once('error',()=>resolve({code:null}));child.once('close',(code,signal)=>resolve({code,signal}));
  });fs.closeSync(log);
  const dir=root+'/runs/'+id,read=name=>JSON.parse(fs.readFileSync(dir+'/'+name));
  let outcome;
  try {
    const exit=read('exit.json'),cleanup=read('cleanup.json');
    const effects=JSON.parse(remote('sudo -n node /opt/five-scene-admin-106s16/inspect-run-effects.mjs '+guestIdentity(id==='smoke'?'smoke':id.slice(3),id==='smoke'?0:1)));
    fs.writeFileSync(dir+'/tool-effects.json',JSON.stringify(effects,null,2)+'\n',{mode:0o600});
    const ledger=new QuotaLedger(root+'/private/requests.jsonl');
    const grade=id==='smoke'?read('smoke.json'):read('result.json');
    if(id!=='smoke'&&read('grading-receipt.json').resultSha256!==hash(fs.readFileSync(dir+'/result.json')))throw Error('GRADE_HASH_MISMATCH');
    outcome={controllerExit:controller.code,cleanupKnown:['stopped','noProcesses','cgroupEmpty','databaseRetired'].every(key=>cleanup[key]===true),usageUnknown:ledger.totals().unknown,toolUnknown:effects.unresolved.length,native:exit.terminal,state:id==='smoke'?(grade.passed?'smoke_passed':'failed'):grade.state,usage:ledger.totals(id),manualReviewPending:id!=='smoke',checks:[...(grade.checks||[]),...(grade.grading?.checks||[])]};
  }catch(error){outcome={controllerExit:controller.code,cleanupKnown:false,usageUnknown:new QuotaLedger(root+'/private/requests.jsonl').totals().unknown,toolUnknown:null,state:'environment_blocked',error:error.message};}
  return outcome;
}
try {
  await save(latest);
  await runSerialBatch({sequence,save,execute,stopRequested:()=>stop||fs.existsSync(root+'/private/STOP'),before:async id=>{
    assertFrozen(root);assertParentAllocation(root);
    const ledger=new QuotaLedger(root+'/private/requests.jsonl');ledger.assertHealthy();
    const cap=runLimits(id),usage=ledger.totals();
    if(Date.now()+(cap.seconds+900)*1000>=Date.parse(authority.deadline))throw Error('FULL_CASE_AND_GRADING_WINDOW_UNAVAILABLE');
    if(usage.requests+cap.requests>limits.maxRequests||usage.tokens+cap.tokens>limits.maxTokens)throw Error('FULL_CASE_BUDGET_UNAVAILABLE');
    if(!(await localBackendDrain()).drained)throw Error('BACKEND_NOT_IDLE');
    if(fs.existsSync(root+'/runs/'+id))throw Error('REGISTERED_CASE_ALREADY_USED');
  }});
}catch(error){await save({...latest,status:'stopped',reason:error.message});}
finally {
  const receipt=await closeNight(latest.status==='automatic_runs_completed_manual_review_pending'?'completed':'stopped');
  await save({...latest,closedAt:receipt.closedAt,cleanupKnown:receipt.cleanupKnown,usage:receipt.usage});fs.closeSync(lock);
  if(receipt.cleanupKnown)fs.unlinkSync(root+'/private/batch.lock');
}
