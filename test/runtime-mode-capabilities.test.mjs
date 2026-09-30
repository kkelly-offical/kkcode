import test from 'node:test'
import assert from 'node:assert/strict'
import { approvalOf, capabilitiesOf } from '../src/kernel/core/modes.mjs'
import { getAgent, getAgentPrompt, resolveAgentForMode } from '../src/kernel/agent/agent.mjs'
import { modeReminder } from '../src/kernel/session/system-prompt.mjs'
import { renderPublicModeContract } from '../src/kernel/session/mode-contract.mjs'
import { modelToolSurface } from '../src/kernel/tool/discovery.mjs'
import { evaluatePermission, toolCapability } from '../src/kernel/permission/rules.mjs'

test('Agent, Auto and Yolo share agent, execution capabilities and guidance; approval differs', async () => {
  for (const mode of ['agent', 'auto', 'yolo']) {
    assert.equal(resolveAgentForMode(mode), getAgent('assistant'))
    assert.equal(capabilitiesOf(mode), capabilitiesOf('agent'))
    assert.equal(await modeReminder(mode), await modeReminder('assistant'))
    for (const capability of ['edit', 'task', 'verify', 'delegate', 'todo']) assert.ok(capabilitiesOf(mode).includes(capability))
  }
  assert.deepEqual(['agent', 'auto', 'yolo'].map(approvalOf), ['manual', 'accept-edits', 'yolo'])
  assert.equal(capabilitiesOf('ultra'), capabilitiesOf('agent'))
  assert.match(renderPublicModeContract(), /not a prerequisite for complex implementation/)
  assert.doesNotMatch(await getAgentPrompt('assistant'), /lightweight automation|recommend explicit.*rather than improvising/)
})

test('Plan exposes persistent planning and read-only delegation without editing tools', async () => {
  const plan = getAgent('plan')
  for (const name of ['todo_read', 'todowrite', 'bash', 'task', 'task_group', 'task_list', 'task_output', 'agent_list', 'agent_wait', 'agent_followup', 'agent_interrupt']) assert.ok(plan.tools.includes(name), name)
  for (const name of ['write', 'edit', 'agent_send']) assert.ok(!plan.tools.includes(name), name)
  assert.equal(plan.permission, 'readonly')
  assert.match(await modeReminder('plan'), /read-only bash commands/)
  assert.match(await getAgentPrompt('plan'), /read-only ceiling/)
  const config = { permission: { level: 'readonly', rules: [] } }
  for (const tool of ['todo_read', 'todowrite', 'agent_list', 'agent_wait', 'agent_interrupt']) assert.equal(evaluatePermission({ config, tool }).action, 'allow', tool)
  for (const tool of ['task', 'task_group', 'agent_followup']) {
    assert.equal(evaluatePermission({ config, tool }).action, 'deny', tool)
    assert.equal(evaluatePermission({ config, tool, capability: 'readonly-task' }).action, 'allow', tool)
  }
  assert.equal(evaluatePermission({ config, tool: 'agent_send', capability: 'readonly-task' }).action, 'deny')
})

test('dynamic tool capability claims cannot grant themselves read-only or edit approval', () => {
  for (const tool of ['mcp_remote_write', 'plugin_execute', 'unregistered_tool']) {
    for (const capability of ['read', 'search', 'prompt', 'readonly-task', 'safe-shell']) {
      assert.equal(toolCapability(tool, '', { capability }), 'unknown')
      assert.equal(evaluatePermission({ config: { permission: { level: 'readonly' } }, tool, capability }).action, 'deny')
      assert.equal(evaluatePermission({ config: { permission: { level: 'accept-edits' } }, tool, capability }).action, 'ask')
    }
  }
  assert.equal(toolCapability('skill', '', { capability: 'prompt' }), 'prompt')
  assert.equal(toolCapability('bash', 'rm -rf dist', { capability: 'read' }), 'risky-shell')
})

test('inherited permission ceilings intersect rather than replace current policy', () => {
  const config = { permission: { level: 'yolo', rules: [] } }
  const request = { config, tool: 'write', pattern: 'src/a.mjs' }
  assert.equal(evaluatePermission({ ...request, permissionCeilings: [{ level: 'manual' }] }).action, 'ask')
  assert.equal(evaluatePermission({ ...request, permissionCeilings: [{ level: 'readonly' }] }).action, 'deny')
  assert.equal(evaluatePermission({ ...request, permissionCeilings: [{ level: 'yolo', rules: [{ tool: 'write', action: 'deny' }] }] }).action, 'deny')
  assert.equal(evaluatePermission({ ...request, config: { permission: { level: 'readonly' } }, permissionCeilings: [{ level: 'yolo' }] }).action, 'deny')
  for (const permissionCeilings of [null, [{ level: 'untrusted' }], [{ rules: [{ tool: 'write', action: 'unknown' }] }], Array(33).fill({ level: 'yolo' })]) assert.equal(evaluatePermission({ ...request, permissionCeilings }).action, 'deny')
})

test('launch capabilities eagerly advertise lifecycle controls without widening allowlists', () => {
  const names = ['task', 'task_group', 'bash', 'tool_search', 'task_list', 'task_output', 'task_stop', 'agent_list', 'agent_wait', 'agent_send', 'agent_followup', 'agent_interrupt', 'browser']
  const tools = names.map(name => ({ name }))
  const result = modelToolSurface(tools).map(tool => tool.name)
  for (const name of names.filter(name => name !== 'browser')) assert.ok(result.includes(name), name)
  assert.ok(!result.includes('browser'))
  assert.deepEqual(modelToolSurface(tools, { allowedTools: ['task', 'agent_wait'] }).map(tool => tool.name), ['task', 'agent_wait'])
})
