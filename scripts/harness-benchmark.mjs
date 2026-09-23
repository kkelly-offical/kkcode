import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKernel } from '../src/kernel/index.mjs'
import { modelToolSurface } from '../src/kernel/tool/discovery.mjs'
import { buildSystemPromptBlocks, toolDescriptions } from '../src/kernel/session/system-prompt.mjs'
import { requestContextBudget } from '../src/kernel/session/context-budget.mjs'
import { PACKAGE_VERSION } from '../src/version.mjs'

const rounds = Number(process.argv[2] || 100)
if (!Number.isInteger(rounds) || rounds < 10 || rounds > 300) throw new Error('Use 10–300 offline fixture rounds')
const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-harness-bench-')), old = process.env.KKCODE_HOME
process.env.KKCODE_HOME = path.join(root, 'private')
const kernel = await createKernel({ cwd: root, boot: false, trustState: { trusted: true } })
try {
  const config = kernel.configState.config
  config.provider = { default: 'fixture', fixture: { default_model: 'fixture', stream: false, retry_attempts: 0 } }
  config.session.title_generation = false; config.skills.auto_seed = false; config.mcp.auto_discover = false
  config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
  await kernel.bootExtensions()
  const full = await kernel.tools.list({ mode: 'assistant', config, cwd: root })
  const eager = modelToolSurface(full, { config: { tool: { discovery: { enabled: false } } } })
  const deferred = modelToolSurface(full, { config })
  const system = await kernel.run(() => buildSystemPromptBlocks({ cwd: root, model: 'fixture', mode: 'assistant', tools: deferred, skills: [] }))
  const eagerText = [system.blocks.filter(block => block.label !== 'tools').map(block => block.text).join('\n\n'), await toolDescriptions(eager)].join('\n\n')
  const measure = (system, tools) => requestContextBudget({ system, tools, model: 'fixture' }).tokens
  let calls = 0
  kernel.providers.registerProvider('fixture', { async request() { calls++; return { text: `ACK ${calls}`, toolCalls: [], stopReason: 'end_turn', usage: { input: 100, output: 3 } } }, async *requestStream() { throw new Error('No stream in offline fixture') } })
  const samples = [], initialListeners = kernel.events.listenerCount()
  for (let i = 0; i < rounds; i++) {
    const before = performance.now()
    const result = await kernel.executeTurn({ sessionId: 'benchmark', prompt: `Offline deterministic fixture round ${i}`, model: 'fixture', providerType: 'fixture' })
    if (result.error) throw new Error('Offline fixture failed: ' + result.error)
    samples.push(performance.now() - before)
  }
  if (kernel.events.listenerCount() !== initialListeners) throw new Error('Per-turn event listener leak')
  samples.sort((a, b) => a - b)
  const report = {
    version: PACKAGE_VERSION, rounds, kind: 'offline deterministic mock-provider; NOT a model quality or cloud-latency benchmark',
    eagerToolCount: eager.length, deferredToolCount: deferred.length,
    eagerFullManualInputEstimate: measure(eagerText, eager), deferredCompactInputEstimate: measure(system, deferred),
    turnP50Ms: Math.round(samples[Math.floor(samples.length * .5)]), turnP95Ms: Math.round(samples[Math.floor(samples.length * .95)]),
    providerCalls: calls, listenerLeak: false, platform: process.platform, node: process.version, testedAt: new Date().toISOString()
  }
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/harness-benchmark-${rounds}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await kernel.shutdown(); if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) }
