import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectPathKey, projectSessions, sessionProjects } from '../apps/web/src/projects.mjs'

test('projects with identical names remain separated by exact directory and device', () => {
  const sessions = [{ id: 'a', cwd: '/work/one/app', status: 'running' }, { id: 'b', cwd: '/work/two/app' }, { id: 'c', cwd: '/work/one/app/subfolder' }]
  assert.equal(sessionProjects(sessions, '', 'device-a').length, 3)
  assert.deepEqual(projectSessions(sessions, '/work/one/app/').map(s => s.id), ['a'])
  assert.notEqual(sessionProjects(sessions, '', 'device-a')[0].id, sessionProjects(sessions, '', 'device-b')[0].id)
})
test('Windows separator/case variations match while POSIX case remains distinct', () => {
  assert.equal(projectPathKey('C:\\Work\\KKCode\\'), projectPathKey('c:/work/kkcode'))
  assert.notEqual(projectPathKey('/work/KKCode'), projectPathKey('/work/kkcode'))
  assert.equal(projectPathKey('/'), '/')
  assert.deepEqual(projectSessions([{ id: 1, cwd: 'C:\\Work\\App' }, { id: 2, cwd: 'C:\\Work\\App-other' }], 'c:/work/app').map(s => s.id), [1])
})
