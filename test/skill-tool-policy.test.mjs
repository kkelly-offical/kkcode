import test from 'node:test'
import assert from 'node:assert/strict'
import { createSkillToolPolicy } from '../src/kernel/skill/tool-policy.mjs'
import { buildSkillCatalog } from '../src/repl/slash-router.mjs'

test('skill tool restrictions intersect, understand portable names and cannot be widened by another skill', () => {
  const policy = createSkillToolPolicy(['Read', 'Grep', 'Bash(git:*)'])
  assert.equal(policy.allows('read'), true)
  assert.equal(policy.allows('edit'), false)
  assert.equal(policy.allows('bash', { command: 'git status' }), true)
  assert.equal(policy.allows('bash', { command: 'git status && touch forbidden' }), false)
  assert.equal(policy.allows('bash', { command: 'npm install' }), false)
  policy.add(['*'])
  assert.equal(policy.allows('edit'), false)
  policy.add(['read'])
  assert.equal(policy.allows('grep'), false)
  assert.equal(policy.allows('read'), true)
  assert.equal(createSkillToolPolicy([]).allows('read'), false)
  assert.throws(() => createSkillToolPolicy('read'), /bounded list/)
})

test('user-only completion catalog omits skills marked not user-invocable', () => {
  assert.deepEqual(buildSkillCatalog({ skills: [{ name: 'automatic', userInvocable: false }, { name: 'manual', type: 'skill_md' }] }), [{ name: 'manual', desc: 'skill (skill_md)' }])
})
