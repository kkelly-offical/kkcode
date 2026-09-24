import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises'
import { sanitizeDiagnostic, writeEvaluationDiagnostic, readEvaluationDiagnostic, evaluationTurnDiagnostics } from '../evaluation/v1/diagnostics.mjs'

test('evaluation diagnostics are private, bounded, inspectable and redact exact credentials', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-evaluation-diagnostic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const secret = 'SYNTHETIC/key?value=secret'
  const error = Object.assign(new Error(`Provider failure ${secret} ${encodeURIComponent(secret)} Authorization: Bearer another-secret https://name:password@example.invalid/\x1b]52;bad`), {
    code: 'SYNTHETIC_PROVIDER_ERROR', stderr: '中'.repeat(20000)
  })
  const id = await writeEvaluationDiagnostic({ root, error, taskId: 'R01', secrets: [secret] })
  const filename = path.join(root, `${id}.json`), raw = await readFile(filename, 'utf8')
  assert.doesNotMatch(raw, /SYNTHETIC\/key|SYNTHETIC%2Fkey|another-secret|name:password|\\u001b/)
  assert.match(raw, /REDACTED/)
  assert.ok(Buffer.byteLength(raw) < 65536)
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600)
  const saved = await readEvaluationDiagnostic(id, root)
  assert.equal(saved.code, 'SYNTHETIC_PROVIDER_ERROR'); assert.equal(saved.taskId, 'R01')
  assert.ok(saved.stack.includes('evaluation-diagnostics.test.mjs'))
  await assert.rejects(readEvaluationDiagnostic('../other', root), /Invalid/)
})

test('diagnostic redaction happens before truncation and removes terminal controls', () => {
  assert.equal(sanitizeDiagnostic('prefix-secret-token-tail', ['secret-token'], 18), 'prefix-[REDACTED]-')
  assert.equal(sanitizeDiagnostic('\x1b[31mhello\x00'), '?[31mhello?')
})

test('recovery diagnostics retain a provider preflight failure and redact before their own bound', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-recovery-diagnostic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const secret = 'SYNTHETIC_BOUNDARY_SECRET', prefix = 'Frozen context window refused before HTTP. '
  const message = `${prefix}${'x'.repeat(3990 - prefix.length)}${secret}${'y'.repeat(1000)}`
  const diagnostics = evaluationTurnDiagnostics([{ error: false }, { error: message }, null], [secret])
  assert.equal(diagnostics.length, 1)
  assert.ok(diagnostics[0].length <= 4000)
  assert.match(diagnostics[0], /Frozen context window refused/)
  assert.doesNotMatch(diagnostics[0], /SYNTHETIC/)
  const id = await writeEvaluationDiagnostic({ root, error: new Error(diagnostics.join('\n')), taskId: 'C07', secrets: [secret] })
  assert.match((await readEvaluationDiagnostic(id, root)).message, /Frozen context window refused/)
})
