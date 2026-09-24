import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import YAML from 'yaml'

test('acceptance workflow keeps runner-only expressions in steps and uses actual checked-in gate scripts', async () => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/acceptance.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch.inputs.scope.default, 'all')
  for (const job of Object.values(workflow.jobs)) assert.match(job.if, /^github\.event_name != 'workflow_dispatch' \|\| /, 'push always runs the complete acceptance matrix')
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.doesNotMatch(JSON.stringify(job.env || {}), /\$\{\{[^}]*\brunner\./, `${name}: runner context is unavailable in job-level env`)
    for (const step of job.steps) for (const match of (step.run || '').matchAll(/(?:node|xvfb-run -a node) (scripts\/[A-Za-z0-9._/-]+\.mjs)/g)) {
      await access(new URL(`../${match[1]}`, import.meta.url))
    }
  }
  assert.equal(workflow.jobs['strict-runtime'].env.KKCODE_REQUIRE_STRICT_BROWSER, '1')
  assert.equal(workflow.jobs['isolated-toolchains'].env.KKCODE_REQUIRE_REAL_LSP, '1')
  const branded = workflow.jobs['branded-browser-bridge']
  assert.deepEqual(branded.strategy.matrix.os, ['ubuntu-22.04', 'windows-latest', 'macos-latest'])
  assert.deepEqual(branded.strategy.matrix.channel, ['chrome', 'msedge'])
  assert.equal(branded.env.KKCODE_BRIDGE_ALLOW_EXTENSION_DEBUGGING, '1')
  assert.ok(branded.steps.some(step => step.name === 'Select private runner fixture paths'))
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) assert.notEqual(step['continue-on-error'], true)
})
