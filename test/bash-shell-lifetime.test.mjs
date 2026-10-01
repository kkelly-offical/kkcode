import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {ToolRegistry} from '../src/kernel/tool/registry.mjs'
import {BackgroundManager} from '../src/kernel/orchestration/background-manager.mjs'

const config = {permission: {level: 'yolo', rules: []}, tool: {sources: {builtin: true, local: false, plugin: false, mcp: false}}, git: {auto: {enabled: false}}}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-shell-lifetime-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'private-state')
  t.after(async () => {
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, {recursive: true, force: true})
  })
  await ToolRegistry.initialize({config, cwd: root, force: true, allowProjectSources: false})
  return {root, call: (name, args) => ToolRegistry.call(name, args, {cwd: root, config, sessionId: 'shell-lifetime', turnId: 'lifetime-turn'})}
}

test('sysinfo reports the actual command shell, not an inherited login-shell hint', {skip: process.platform === 'win32'}, async t => {
  const {call} = await setup(t), previous = process.env.SHELL
  process.env.SHELL = '/nonexistent/login-shell'
  t.after(() => {if (previous === undefined) delete process.env.SHELL; else process.env.SHELL = previous})
  const result = await call('sysinfo', {sections: ['runtime']})
  const runtime = JSON.parse(result.output).sections.runtime
  assert.equal(runtime.shell, '/bin/sh')
  const probe = await call('bash', {command: 'printf "%s\\n" "$0"'})
  assert.equal(probe.ok, true)
  assert.equal(probe.output, runtime.shell)
})

test('Windows command shell ignores a POSIX login-shell hint and executes native cmd syntax', {skip: process.platform !== 'win32'}, async t => {
  const {call} = await setup(t), previous = process.env.SHELL
  process.env.SHELL = '/nonexistent/login-shell'
  t.after(() => {if (previous === undefined) delete process.env.SHELL; else process.env.SHELL = previous})
  const result = await call('sysinfo', {sections: ['runtime']})
  assert.equal(JSON.parse(result.output).sections.runtime.shell, process.env.ComSpec || 'cmd.exe')
  const probe = await call('bash', {command: 'echo cmd-value&& exit /b 0'})
  assert.equal(probe.ok, true)
  assert.equal(probe.output, 'cmd-value')
})

test('background launch persists and advertises its actual finite command timeout', async t => {
  const {call} = await setup(t)
  const launch = await call('bash', {command: 'exit 0', timeout: 1750, run_in_background: true})
  const task = await BackgroundManager.waitForTask(launch.metadata.backgroundTask.id, {timeoutMs: 5000, tickMs: 10})
  assert.equal(task.status, 'completed')
  assert.equal(task.payload.commandTimeoutMs, 1750)
  assert.equal(task.payload.workerTimeoutMs, 1750)
  assert.equal(launch.metadata.backgroundTask.commandTimeoutMs, 1750)
  assert.match(launch.output, /1750.*ms/)
  assert.match(launch.output, /does not extend/i)
})

test('background launch clamps a requested unbounded lifetime instead of advertising forever', async t => {
  const {call} = await setup(t)
  const launch = await call('bash', {command: 'exit 0', timeout: 99_000_000, run_in_background: true})
  const task = await BackgroundManager.waitForTask(launch.metadata.backgroundTask.id, {timeoutMs: 5000, tickMs: 10})
  assert.equal(task.status, 'completed')
  assert.equal(task.payload.commandTimeoutMs, 600_000)
  assert.equal(launch.metadata.backgroundTask.commandTimeoutMs, 600_000)
})

test('malformed optional timeout configuration cannot silently remove the process deadline', async t => {
  const {root} = await setup(t)
  for (const timeout of ['not-a-number', NaN]) {
    const invalidOptional = {...config, tool: {...config.tool, bash_timeout_ms: timeout}}
    const launch = await ToolRegistry.call('bash', {command: 'exit 0', run_in_background: true}, {cwd: root, config: invalidOptional, sessionId: 'shell-lifetime', turnId: 'lifetime-turn'})
    const task = await BackgroundManager.waitForTask(launch.metadata.backgroundTask.id, {timeoutMs: 5000, tickMs: 10})
    assert.equal(task.status, 'completed')
    assert.equal(task.payload.commandTimeoutMs, 120_000)
    assert.equal(launch.metadata.backgroundTask.commandTimeoutMs, 120_000)
    assert.doesNotMatch(launch.output, /NaN|Infinity/)
  }
})

test('finite timeout values retain the original lower and upper clamps', async t => {
  const {call} = await setup(t)
  for (const [timeout, expected] of [[20, 1000], [-5, 1000], [650000, 600000]]) {
    const launch = await call('bash', {command: 'exit 0', run_in_background: true, timeout})
    const task = await BackgroundManager.waitForTask(launch.metadata.backgroundTask.id, {timeoutMs: 5000, tickMs: 10})
    assert.equal(task.status, 'completed')
    assert.equal(task.payload.commandTimeoutMs, expected)
    assert.equal(launch.metadata.backgroundTask.commandTimeoutMs, expected)
  }
})
