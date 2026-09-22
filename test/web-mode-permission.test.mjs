import test from 'node:test'
import assert from 'node:assert/strict'
import { MODE_OPTIONS, PERMISSION_OPTIONS, modeLabel, permissionLabel } from '../apps/web/src/modes.mjs'

test('mode and permission catalogs match the sessions.configure contract values', () => {
  assert.deepEqual(MODE_OPTIONS.map(option => option.id), ['agent', 'plan', 'auto', 'ultra', 'yolo'])
  assert.deepEqual(PERMISSION_OPTIONS.map(option => option.id), ['readonly', 'manual', 'accept-edits', 'yolo'])
  for (const option of [...MODE_OPTIONS, ...PERMISSION_OPTIONS]) {
    assert.ok(option.label && option.desc, `${option.id} needs a label and description`)
  }
})

test('labels fall back predictably for empty or unknown values', () => {
  assert.equal(permissionLabel('accept-edits'), '允许编辑')
  assert.equal(permissionLabel(''), '每次确认')
  assert.equal(permissionLabel('custom'), 'custom')
  assert.equal(modeLabel('plan'), 'Plan')
  assert.equal(modeLabel('agent-auto'), 'Auto')
  assert.equal(modeLabel(''), 'Agent')
})
