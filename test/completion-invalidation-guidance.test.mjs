import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateCompletionEvidence,completionRepairGuidance} from '../src/kernel/session/completion-evidence.mjs'

const shell=command=>({name:'bash',args:{command},status:'completed',ok:true,metadata:{exitCode:0,started:true}})
const edit={name:'write',args:{path:'outputs/result.txt'},status:'completed',ok:true}

for(const language of ['en','zh'])test(`post-check ordinary script identifies invalidation without trusting or replaying it (${language})`,()=>{
 const events=[edit,shell('python3 -m unittest tests.test_documents -v'),shell('python3 work/verify_docs.py outputs/accepted.docx'),shell('python3 work/verify_pdf.py outputs/clean.pdf')]
 const verification=evaluateCompletionEvidence({toolEvents:events,language})
 assert.equal(verification.passed,false)
 assert.deepEqual(verification.failures,[{kind:'checks_required',afterIndex:3}])
 const hint=completionRepairGuidance({verification,toolEvents:events,language})
 assert.match(hint,/<verification-order-records>/)
 assert.match(hint,/unclassified_command/)
 assert.match(hint,/"sourceEventIndex":3/)
 assert.match(hint,/tests.test_documents/)
 assert.match(hint,/"-v"/)
 assert.doesNotMatch(hint,/work\/verify_docs.py|work\/verify_pdf.py|outputs\/accepted.docx|outputs\/clean.pdf/,'potential effect commands are locators, not replay instructions')
 assert.match(verification.message,language==='zh'?/无法证明只读/:/not proven read-only/)
 assert.equal(evaluateCompletionEvidence({toolEvents:[...events,shell('python3 -m unittest tests.test_documents -v')]}).passed,true)
})

test('ordering guidance never reveals arbitrary script bodies, outputs or environment values',()=>{
 const uncertain=shell('PRIVATE_VALUE=environment-value python3 -c "print(\'private-script-body\')"')
 uncertain.output='private-output-body'
 const events=[edit,shell('node --test verify.test.mjs'),uncertain]
 const verification=evaluateCompletionEvidence({toolEvents:events})
 const hint=completionRepairGuidance({verification,toolEvents:events})
 assert.match(hint,/<verification-order-records>/)
 assert.doesNotMatch(hint,/environment-value|private-script-body|private-output-body|PRIVATE_VALUE/)
 assert.doesNotMatch(JSON.stringify(verification),/verify.test.mjs|private-script-body/)
})

test('forged ordering locators and incomplete outcome histories cannot acquire private check arguments',()=>{
 const events=[edit,shell('node --test private.test.mjs'),shell('python3 verifier.py')]
 for(const afterIndex of [-1,0,1,8,NaN]){
  const verification={passed:false,state:'needs_verification',failures:[{kind:'checks_required',afterIndex}],checks:[{index:1,status:'passed'}]}
  assert.equal(completionRepairGuidance({verification,toolEvents:events}),'')
 }
 events[2].metadata.outcomeUnknown=true
 assert.equal(completionRepairGuidance({verification:evaluateCompletionEvidence({toolEvents:events}),toolEvents:events}),'')
})

test('durable progress and safe inspection do not invalidate project checks',()=>{
 const events=[edit,shell('node --test verify.test.mjs'),{name:'todowrite',status:'completed',ok:true,args:{todos:[]}}, {name:'read',status:'completed',ok:true,args:{path:'outputs/result.txt'}}]
 const verification=evaluateCompletionEvidence({toolEvents:events})
 assert.equal(verification.passed,true)
 assert.equal(completionRepairGuidance({verification,toolEvents:events}),'')
})

test('combined failed-check and ordering records are byte bounded and remain valid JSON',()=>{
 const events=[edit,...Array.from({length:16},(_,i)=>shell('node --test '+('未核实'.repeat(78)+i+'.test.mjs')+' || true')),
  shell('node --test current.test.mjs '+Array.from({length:9},(_,i)=>'检查'.repeat(30)+i+'.test.mjs').join(' ')),shell('python3 verifier.py')]
 const verification=evaluateCompletionEvidence({toolEvents:events})
 const hint=completionRepairGuidance({verification,toolEvents:events,language:'zh'})
 assert.ok(Buffer.byteLength(hint)<=6500)
 for(const match of hint.matchAll(/<(check-repair-records|verification-order-records)>\n([\s\S]*?)\n<\/\1>/g))assert.doesNotThrow(()=>JSON.parse(match[2]))
})

test('first unclassified execution is not described as invalidating nonexistent earlier checks',()=>{
 const events=[edit,shell('python3 verifier.py')]
 const verification=evaluateCompletionEvidence({toolEvents:events})
 assert.equal(verification.passed,false)
 assert.doesNotMatch(verification.message,/earlier checks are stale/)
 assert.equal(completionRepairGuidance({verification,toolEvents:events}),'')
 const documentationOnly=[edit,shell('git diff --check'),shell('python3 verifier.py')]
 assert.equal(completionRepairGuidance({verification:evaluateCompletionEvidence({toolEvents:documentationOnly}),toolEvents:documentationOnly}),'','a whitespace-only check cannot be offered as sufficient project verification')
})
