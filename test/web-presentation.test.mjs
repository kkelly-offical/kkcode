import test from 'node:test'
import assert from 'node:assert/strict'
import { groupSessions } from '../apps/web/src/sessions.mjs'
import { buildTranscript, changeSummary, toolPresentation } from '../apps/web/src/transcript.mjs'
import { commandSuggestions } from '../apps/web/src/commands.mjs'

const now = new Date(2026, 8, 21, 12).getTime()
test('slash completion prioritizes command names over incidental description matches', () => {
  const commands = [{ name: 'mode', description: 'switch explicit mode' }, { name: 'plan', description: 'read-only plan' }, { name: 'ultra', aliases: ['longagent'] }]
  assert.equal(commandSuggestions(commands, 'pl')[0].name, 'plan')
  assert.equal(commandSuggestions(commands, 'long')[0].name, 'ultra')
  assert.deepEqual(commandSuggestions(commands, 'absent'), [])
  assert.equal(commands[0].name, 'mode')
})
test('home sorts running sessions before time groups, filters search/archive without mutating data', () => {
  const sessions = [
    { id: 'old', title: 'Past', cwd: '/work/old', updatedAt: now - 4 * 86400000 },
    { id: 'today', title: '界面优化', cwd: '/work/kkcode', updatedAt: now, status: 'active' },
    { id: 'running', title: 'Tests', cwd: 'C:\\dev\\KKCode', updatedAt: now - 86400000, status: 'running' },
    { id: 'archived', title: 'Archived', cwd: '/work/old', updatedAt: now, archived: true },
  ]
  assert.deepEqual(groupSessions(sessions, { now }).map(([name]) => name), ['优先级', '今天', '过去 7 天'])
  assert.deepEqual(groupSessions(sessions, { now, sort: 'time' }).map(([name]) => name), ['今天', '昨天', '过去 7 天'])
  assert.equal(groupSessions(sessions, { now, query: ' kkcode ' }).flatMap(([, values]) => values).length, 2)
  assert.deepEqual(groupSessions(sessions, { now, archived: true })[0][1].map(item => item.id), ['archived'])
  assert.equal(groupSessions(sessions, { now, sort: 'project' })[0][0], 'kkcode')
  assert.deepEqual(sessions.map(item => item.id), ['old', 'today', 'running', 'archived'])
})
test('home uses calendar days rather than a rolling 24-hour bucket', () => {
  const midnight = new Date(2026, 8, 21, 0, 1).getTime()
  assert.equal(groupSessions([{ updatedAt: midnight - 120000 }], { now: midnight })[0][0], '昨天')
})
const event = (id, type, payload = {}, timestamp = 1000, turnId = 'turn-a') => ({ id, type, payload, timestamp, turnId })
const metadata = { mutations: [{ filePath: '/work/main.ts', addedLines: 2, removedLines: 1, structuredPatch: [{ oldStart: 1, oldLineCount: 1, newStart: 1, newLineCount: 2, lines: [{ type: 'remove', text: 'old' }, { type: 'add', text: 'new' }] }] }] }
test('tool lifecycle becomes one expandable row and uses real diff counts', () => {
  const events = [event('start', 'tool.start', { invocationId: 'tool-1', tool: 'edit', args: { file_path: '/work/main.ts' } }), event('done', 'tool.finish', { invocationId: 'tool-1', tool: 'edit', status: 'completed', metadata })]
  const before = JSON.stringify(events), rows = buildTranscript({}, events)
  assert.equal(rows.length, 1)
  assert.equal(toolPresentation(rows[0].payload).title, '已编辑 main.ts')
  assert.deepEqual(changeSummary(rows), { files: 1, added: 2, removed: 1 })
  assert.equal(JSON.stringify(events), before)
  assert.equal(buildTranscript({}, [...events, events[1]]).length, 1)
})
test('thinking tokens merge, acquire elapsed time and end when text starts', () => {
  const rows = buildTranscript({}, [event('a', 'stream.thinking.start'), event('b', 'stream.thinking.delta', { text: 'first ' }, 1100), event('c', 'stream.thinking.delta', { text: 'second' }, 2400), event('d', 'stream.text.delta', { text: 'Answer' }, 5000)])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].text, 'first second')
  assert.equal(rows[0].durationMs, 4000)
  assert.equal(rows[0].done, true)
})
test('stream text is not repeated by turn.finish/turn.result and synthetic relay turn IDs', () => {
  const rows = buildTranscript({}, [event('a', 'turn.start', { prompt: 'Hello' }), event('b', 'stream.text.delta', { text: 'One' }), event('c', 'stream.end'), event('d', 'turn.finish', { reply: 'One' }), event('e', 'turn.result', { reply: 'One', turnId: 'turn-a' }, 5000, 'remote-id')])
  assert.deepEqual(rows.map(row => row.text), ['Hello', 'One'])
})
test('history renders persisted tools and reasoning, without blank tool-result user bubbles', () => {
  const rows = buildTranscript({ messages: [{ id: 'u', role: 'user', content: [{ type: 'tool_result', content: 'hidden' }], createdAt: 1 }, { id: 'a', role: 'assistant', content: [{ type: 'reasoning', text: 'Thought' }, { type: 'text', text: 'Answer' }], createdAt: 4 }], parts: [{ id: 'p', type: 'tool-call', tool: 'edit', status: 'running', createdAt: 2 }, { id: 'p2', runPartId: 'p', type: 'tool-call', tool: 'edit', status: 'completed', metadata, createdAt: 3 }] })
  assert.deepEqual(rows.map(row => row.type), ['tool', 'thinking', 'assistant'])
  assert.equal(rows[0].payload.status, 'completed')
  assert.deepEqual(changeSummary(rows), { files: 1, added: 2, removed: 1 })
})
test('compaction is a divider, failure is not counted as a successful edit', () => {
  const rows = buildTranscript({}, [event('a', 'session.compacted'), event('b', 'tool.error', { tool: 'edit', metadata })])
  assert.equal(rows[0].type, 'compacted')
  assert.equal(toolPresentation(rows[1].payload).failed, true)
  assert.deepEqual(changeSummary(rows), { files: 0, added: 0, removed: 0 })
})
test('midstream snapshots append future text to the replayed prefix exactly once', () => {
  const prefix = [
    event('live-user', 'turn.start', { prompt: 'Continue' }, 1000),
    event('live-thought', 'stream.thinking.delta', { text: 'Checking ', step: 1 }, 1100),
    event('live-text', 'stream.text.delta', { text: 'The saved prefix ', step: 1 }, 1200),
  ]
  const snapshot = { messages: [{ id: 'user', role: 'user', turnId: 'turn-a', content: 'Continue', createdAt: 1000 }], liveEvents: prefix }
  const tail = event('future-text', 'stream.text.delta', { text: 'and future tail.', step: 1 }, 1300)
  const rows = buildTranscript(snapshot, [...snapshot.liveEvents, tail, tail])
  assert.deepEqual(rows.filter(row => row.type === 'user').map(row => row.text), ['Continue'])
  assert.deepEqual(rows.filter(row => row.type === 'assistant').map(row => row.text), ['The saved prefix and future tail.'])
  assert.deepEqual(rows.filter(row => row.type === 'thinking').map(row => row.text), ['Checking '])
  const completed = { messages: [...snapshot.messages, { id: 'assistant', role: 'assistant', turnId: 'turn-a', step: 1, content: 'The saved prefix and future tail.', createdAt: 1400 }], liveEvents: [] }
  assert.deepEqual(buildTranscript(completed, completed.liveEvents).map(row => row.text), ['Continue', 'The saved prefix and future tail.'])
  // A canonical assistant step also suppresses any in-flight duplicate replay.
  assert.equal(buildTranscript(completed, [...prefix, tail]).filter(row => row.type === 'assistant').length, 1)
})
test('a truncated canonical step does not suppress its auto-continued stream', () => {
  const snapshot = { messages: [{ id: 'partial', role: 'assistant', turnId: 'turn-a', step: 2, truncated: true, content: 'First generation.', createdAt: 1000 }] }
  const rows = buildTranscript(snapshot, [event('next-generation', 'stream.text.delta', { text: 'Continued generation.', step: 2 }, 2000)])
  assert.deepEqual(rows.filter(row => row.type === 'assistant').map(row => row.text), ['First generation.', 'Continued generation.'])
})
