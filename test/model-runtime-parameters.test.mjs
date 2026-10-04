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
    { id:'independent', inputTokenLimit:1048576, outputTokenLimit:65536 }]
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
    const independent=requestContextBudget({model:'independent',configState:cfg,measuredTokens:1000000})
    assert.equal(independent.inputBudget,1048576)
    assert.equal(independent.outputReserved,65536)
    assert.equal(independent.requiredTokens,1000000)
    assert.equal(independent.windowKind,'input')
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
