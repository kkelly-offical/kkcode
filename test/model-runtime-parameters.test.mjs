import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverModelsForProvider, clearModelCatalogMemoryCache } from '../src/kernel/provider/model-catalog.mjs'
import { requestProvider, requestProviderStream } from '../src/kernel/provider/router.mjs'
import { requestContextBudget } from '../src/kernel/session/context-budget.mjs'
import { modelRuntimeProfile } from '../src/kernel/provider/runtime-parameters.mjs'
import { parseModelParameters } from '../src/kernel/provider/model-parameters.mjs'
import { thinkingControl, mapThinkingRequest } from '../src/kernel/provider/thinking-control.mjs'

test('catalog → complete budget → actual request, with refreshed models and isolated routes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'kkcode-runtime-110-'))
  const oldHome = process.env.KKCODE_HOME, oldFetch = global.fetch
  process.env.KKCODE_HOME = dir
  const requests = []
  let models = [{ id:'large', context_length:1048576, max_output_tokens:131072, reasoning_effort_levels:['max','xhigh','high','medium','low'], supported_parameters:['tools','reasoning_effort','max_completion_tokens'] },
    { id:'small', context_length:32768, max_output_tokens:8192, reasoning_effort_levels:['low','medium','high'] },
    { id:'independent', inputTokenLimit:1048576, outputTokenLimit:65536 },
    { id:'local-deployment', context_length:262144, max_model_len:65536 }]
  const cfg = { config:{provider:{default:'p',p:{type:'openai-compatible',base_url:'https://models.example.test/v1',api_key_env:'', default_model:'large', model_options:{large:{thinking_effort:'xhigh'}}}}} }
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data:models }))
    const body = JSON.parse(options.body); requests.push(body)
    const result = {id:'r',choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:2}}
    return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}})
  }
  try {
    await discoverModelsForProvider(cfg,{refresh:true})
    const meter = requestContextBudget({model:'large',configState:cfg})
    assert.equal(meter.outputReserved,131072)
    assert.equal(meter.inputBudget,917504)
    assert.equal(meter.outputSource,'catalog')
    assert.equal(requestContextBudget({model:'p/large',providerType:'p',configState:cfg}).outputReserved,131072, 'budgeting resolves the same provider/model alias as the wire adapter')
    const independent=requestContextBudget({model:'independent',configState:cfg,measuredTokens:1000000})
    assert.equal(independent.inputBudget,1048576)
    assert.equal(independent.outputReserved,65536)
    assert.equal(independent.requiredTokens,1000000)
    assert.equal(independent.windowKind,'input')
    assert.equal(requestContextBudget({model:'local-deployment',configState:cfg}).limit,65536, 'vLLM deployment limit takes precedence over a larger advertised model window')
    await requestProvider({configState:cfg,providerType:'p',model:'large',system:'',messages:[{role:'user',content:'fixture'}],tools:[]})
    assert.equal(requests.at(-1).max_completion_tokens,131072)
    assert.equal(requests.at(-1).reasoning_effort,'xhigh')
    assert.equal(cfg.config.provider.p.max_output_tokens,undefined)
    const small = requestContextBudget({model:'small',configState:cfg})
    assert.equal(small.outputReserved,8192)
    assert.equal(small.limit,32768)
    const ui = modelRuntimeProfile(cfg,{configKey:'p',model:'large',protocol:'openai',baseUrl:cfg.config.provider.p.base_url})
    assert.deepEqual(ui.thinking.options.map(x=>x.value),['auto','low','medium','high','xhigh','max'])
    assert.equal(ui.thinking.selected,'xhigh')
    assert.equal(ui.thinking.options.find(x=>x.value==='xhigh').level,4)
    models = [{id:'large',context_length:262144,max_output_tokens:65536,reasoning_effort_levels:['low','medium','high','xhigh']}]
    await discoverModelsForProvider(cfg,{refresh:true})
    assert.equal(requestContextBudget({model:'large',configState:cfg}).outputReserved,65536)
    assert.equal(requestContextBudget({model:'large',configState:cfg,baseUrl:'https://another.example.test/v1'}).outputSource,'estimated')
    clearModelCatalogMemoryCache()
    await requestProvider({configState:cfg,providerType:'p',model:'large',system:'',messages:[],tools:[]})
    assert.equal(requests.at(-1).max_tokens,65536, 'cold request reloads disk metadata without discovery or inference probes')
  } finally {
    global.fetch=oldFetch; if(oldHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME=oldHome
    clearModelCatalogMemoryCache(); await rm(dir,{recursive:true,force:true})
  }
})

test('declared enums and adaptive thinking map independently of token thresholds', () => {
  const metadata = parseModelParameters({capabilities:{thinking:{supported:true,types:{adaptive:{supported:true},disabled:{supported:true}}},effort:{supported:true,low:{supported:true},high:{supported:true},xhigh:{supported:true}}}})
  const control = thinkingControl({metadata,protocol:'anthropic',maxTokens:64000,settings:{thinking_effort:'xhigh'}})
  assert.deepEqual(control.options.map(x=>x.value),['auto','off','low','high','xhigh'])
  assert.deepEqual(mapThinkingRequest({control,protocol:'anthropic',maxTokens:64000}),{thinking:{type:'adaptive'},outputConfig:{effort:'xhigh'}})
  const off = thinkingControl({metadata,protocol:'anthropic',maxTokens:64000,settings:{thinking_effort:'off'}})
  assert.deepEqual(mapThinkingRequest({control:off,protocol:'anthropic',maxTokens:64000}),{thinking:{type:'disabled'}})
  const invalid = thinkingControl({metadata,protocol:'anthropic',maxTokens:64000,settings:{thinking_effort:'max'}})
  assert.throws(()=>mapThinkingRequest({control:invalid,protocol:'anthropic',maxTokens:64000}),/不支持/)
})

test('budget thinking uses the actual request output, leaves text room and preserves input limit semantics', () => {
  const metadata = parseModelParameters({inputTokenLimit:1048576,outputTokenLimit:65536,temperature:1,maxTemperature:2})
  assert.equal(metadata.limits.inputOnly,true)
  assert.equal(metadata.limits.context,null)
  assert.equal(metadata.limits.input,1048576)
  assert.equal(metadata.sampling.temperature.max,2)
  const declared = parseModelParameters({capabilities:{thinking:{supported:true,types:{enabled:{supported:true},disabled:{supported:true}},min_budget_tokens:1024}}})
  for(const maxTokens of [4096,16384,65536]) {
    const control=thinkingControl({metadata:declared,protocol:'anthropic',maxTokens,settings:{thinking_effort:'xhigh'}})
    const wire=mapThinkingRequest({control,protocol:'anthropic',maxTokens})
    assert.ok(wire.thinking.budget_tokens>=1024 && wire.thinking.budget_tokens<maxTokens)
  }
})

test('a declared boolean control exposes a switch, while unknown support offers only automatic', () => {
  const metadata=parseModelParameters({parameters:{chat_template_kwargs:{properties:{enable_thinking:{type:'boolean'}}}}})
  const control=thinkingControl({metadata,protocol:'openai',maxTokens:8000,settings:{thinking_effort:'off'}})
  assert.equal(control.kind,'toggle')
  assert.deepEqual(control.options.map(x=>x.value),['auto','off','on'])
  assert.deepEqual(mapThinkingRequest({control,protocol:'openai',maxTokens:8000}),{thinkingSwitch:{parameter:'chat_template_kwargs.enable_thinking',enabled:false}})
  assert.deepEqual(thinkingControl({model:'unknown'}).options.map(x=>x.value),['auto'])
  const mixed=parseModelParameters({reasoning_effort_levels:['low','high'],parameters:{enable_thinking:{type:'boolean'}}})
  const mixedControl=thinkingControl({metadata:mixed,protocol:'openai',maxTokens:8000,settings:{thinking_effort:'high'}})
  assert.deepEqual(mapThinkingRequest({control:mixedControl,protocol:'openai',maxTokens:8000}),{reasoningEffort:'high',thinkingSwitch:{parameter:'enable_thinking',enabled:true}})
  assert.equal(thinkingControl({metadata,protocol:'responses',maxTokens:8000}).options.some(x=>x.value==='off'),false, 'unsupported wire controls must not be advertised')
})

test('insufficient thinking budgets and incompatible adapters fail before pretending a setting was applied', () => {
  const control=thinkingControl({model:'claude-sonnet-4',protocol:'anthropic',maxTokens:512,settings:{thinking_effort:'high'}})
  assert.throws(()=>mapThinkingRequest({control,protocol:'anthropic',maxTokens:512}),/不足/)
  assert.throws(()=>mapThinkingRequest({control:thinkingControl({protocol:'ollama',settings:{thinking_effort:'high'}}),protocol:'ollama',maxTokens:512}),/适配器/)
})

test('budget presets span the effective range and merge equal values instead of inventing distinct levels', () => {
  const metadata=parseModelParameters({capabilities:{thinking:{supported:true,types:{enabled:{supported:true},disabled:{supported:true}},min_budget_tokens:1024,max_budget_tokens:1025}}})
  const control=thinkingControl({metadata,protocol:'anthropic',maxTokens:4096,settings:{thinking_effort:'high'}})
  const presets=control.options.filter(option=>!['auto','off'].includes(option.value))
  const budgets=presets.map(option=>mapThinkingRequest({control:{...control,selected:option.value},protocol:'anthropic',maxTokens:4096}).thinking.budget_tokens)
  assert.equal(new Set(budgets).size,presets.length)
  assert.deepEqual(budgets,[1024,1025])
  assert.ok(presets.some(option=>option.value===control.selected))
  assert.throws(()=>mapThinkingRequest({control,protocol:'anthropic',maxTokens:4096,settings:{thinking:{type:'enabled',budget_tokens:1200}}}),/有效范围/)
})

test('native enum spelling survives cache normalization and an explicit off is sent as declared', () => {
  const original=parseModelParameters({reasoning_effort_levels:['LOW','MEDIUM','HIGH','XHIGH','MAX','OFF']})
  const metadata=parseModelParameters({modelParameters:original})
  for(const [selected, expected] of [['xhigh','XHIGH'],['off','OFF']]) {
    const control=thinkingControl({metadata,settings:{thinking_effort:selected},protocol:'openai',maxTokens:65536})
    assert.equal(mapThinkingRequest({control,protocol:'openai',maxTokens:65536}).reasoningEffort,expected)
  }
})

test('malformed API limits remain unknown instead of coercing booleans or arrays into official limits', () => {
  for(const value of [true,false,[],[65536],{},0,-1,Infinity,1.5,'']) {
    const parsed=parseModelParameters({max_output_tokens:value,context_length:value,temperature:value})
    assert.equal(parsed.limits.output,null)
    assert.equal(parsed.limits.context,null)
  }
  assert.equal(parseModelParameters({max_output_tokens:'65536'}).limits.output,65536)
})

test('known model defaults fill sparse catalogs without capping explicit choices or starving small deployments', () => {
  assert.equal(requestContextBudget({model:'gpt-5-2025-08-07'}).outputReserved,128000)
  const configState={config:{provider:{default:'p',p:{context_limit:400000,max_tokens:150000}}}}
  assert.equal(requestContextBudget({model:'gpt-5',configState}).outputReserved,150000)
  configState.config.provider.p={context_limit:32768,max_output_tokens:131072}
  const small=requestContextBudget({model:'gpt-5',configState})
  assert.equal(small.outputReserved,6553)
  assert.ok(small.inputBudget > 25000)
})

test('Kimi Code specification fills missing controls only on its official routes and never replaces explicit declarations', () => {
  const input={model:'k3',protocol:'openai',baseUrl:'https://api.kimi.com/coding/v1',maxTokens:4096}
  const control=thinkingControl(input)
  assert.equal(control.source,'specification')
  assert.deepEqual(control.options.map(x=>x.value),['auto','off','low','high','max'])
  assert.equal(control.defaultLevel,'high')
  assert.equal(control.options.find(x=>x.value==='off').label,'直答')
  assert.equal(control.options.find(x=>x.value==='off').description,'关闭思考')
  for (const [saved,selected] of [['medium','high'],['xhigh','max'],['light','low']]) {
    const alias=thinkingControl({...input,settings:{model_options:{k3:{thinking_effort:saved}}}})
    assert.equal(alias.selected,selected)
    assert.deepEqual(alias.options.map(x=>x.value),['auto','off','low','high','max'])
    assert.equal(mapThinkingRequest({control:alias,protocol:'openai',maxTokens:4096}).reasoningEffort,saved)
  }
  const invalid=thinkingControl({...input,settings:{thinking_effort:'constructor'}})
  assert.equal(invalid.selected,'constructor')
  assert.throws(()=>mapThinkingRequest({control:invalid,protocol:'openai',maxTokens:4096}),/不支持/)
  for(const baseUrl of ['https://api.kimi.com.evil.test/coding/v1','https://proxy.example.test/coding/v1','https://api.kimi.com/other','http://api.kimi.com/coding/v1','https://api.kimi.com:8443/coding/v1']) {
    assert.equal(thinkingControl({...input,baseUrl}).kind,'unknown')
  }
  assert.equal(thinkingControl({...input,protocol:'responses'}).kind,'unknown')
  const explicit=thinkingControl({...input,metadata:parseModelParameters({reasoning_effort_levels:['low','high']})})
  assert.equal(explicit.source,'catalog')
  assert.deepEqual(explicit.options.map(x=>x.value),['auto','low','high'])
  assert.equal(thinkingControl({...input,metadata:{reasoning:{supported:false}}}).kind,'unsupported')
  const fixed=thinkingControl({...input,model:'kimi-for-coding-highspeed'})
  assert.equal(fixed.kind,'fixed');assert.equal(fixed.canDisable,false)
  const disabled=thinkingControl({...input,protocol:'anthropic',baseUrl:'https://api.kimi.ai/coding/',settings:{thinking_effort:'off'}})
  assert.deepEqual(mapThinkingRequest({control:disabled,protocol:'anthropic',maxTokens:4096}),{thinking:{type:'disabled'}})
})

test('sparse Kimi catalog produces selectable native efforts and actual Chat request parameters without a model probe', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'kkcode-kimi-controls-'))
  const oldHome=process.env.KKCODE_HOME, oldFetch=global.fetch
  process.env.KKCODE_HOME=dir
  const requests=[]
  const cfg={config:{provider:{default:'coding',coding:{type:'openai-compatible',base_url:'https://api.kimi.com/coding/v1',api_key_env:'',default_model:'k3',model_options:{k3:{thinking_effort:'auto'}}}}}}
  global.fetch=async(url,options)=>{
    if(String(url).endsWith('/models')) return new Response(JSON.stringify({data:[{id:'k3',context_length:1048576}]}))
    requests.push(JSON.parse(options.body))
    return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'fixture'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}})
  }
  try {
    await discoverModelsForProvider(cfg,{refresh:true})
    const profile=modelRuntimeProfile(cfg,{configKey:'coding',protocol:'openai',model:'k3',baseUrl:cfg.config.provider.coding.base_url})
    assert.deepEqual(profile.thinking.options.map(x=>x.value),['auto','off','low','high','max'])
    assert.equal(requests.length,0)
    for(const value of ['auto','off','low','high','max']) {
      cfg.config.provider.coding.model_options.k3.thinking_effort=value
      await requestProvider({configState:cfg,providerType:'coding',model:'k3',system:'',messages:[],tools:[],maxTokens:4096})
      assert.equal(requests.at(-1).reasoning_effort,value==='auto'?undefined:value==='off'?'none':value)
    }
  } finally {
    global.fetch=oldFetch;if(oldHome===undefined)delete process.env.KKCODE_HOME;else process.env.KKCODE_HOME=oldHome
    clearModelCatalogMemoryCache();await rm(dir,{recursive:true,force:true})
  }
})
