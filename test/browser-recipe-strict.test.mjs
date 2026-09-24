import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createDockerExecutionBackend, markStrictBuiltinTools } from '../src/kernel/isolation/docker-executor.mjs'
import { markBrowserRecipeCall } from '../src/kernel/tool/browser-recipe.mjs'

test('real strict recipe composite rejects forged bridges and does not hold its governed leaf queue', { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-recipe-strict-')), cwd = path.join(root, 'workspace')
  await mkdir(cwd); await writeFile(path.join(cwd, 'evidence.txt'), 'isolated leaf evidence')
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = createDockerExecutionBackend({ image: process.env.KKCODE_STRICT_TEST_IMAGE, networkOrigins: ['https://recipe.invalid'] })
  await backend.ensureReady({ cwd, contract: { allowedPaths: ['.'] } })
  const [outer, leaf] = markStrictBuiltinTools([{ name: 'browser_recipe' }, { name: 'read' }])
  let outerCalls = 0
  await assert.rejects(backend.executeTool({ tool: outer, context: { cwd, runBrowserRecipeCall: () => {} }, invoke: () => { outerCalls++; return '' } }), error => error.code === 'strict_tool_denied')
  assert.equal(outerCalls, 0)
  const bridge = markBrowserRecipeCall(async () => {})
  await assert.rejects(backend.executeTool({ tool: { name: 'browser_recipe' }, context: { cwd, runBrowserRecipeCall: bridge }, invoke: () => '' }), /可信能力/)
  // This verifies the broker's composite/leaf queue, NOT OS-sandboxed Chromium
  // availability. The nested read actually runs through the Docker file bridge.
  const result = await backend.executeTool({ tool: outer, context: { cwd, runBrowserRecipeCall: bridge }, invoke: () => backend.executeTool({ tool: leaf, args: { path: 'evidence.txt' }, context: { cwd }, invoke: () => { throw new Error('host file fallback must not run') } }) })
  assert.match(result.output, /isolated leaf evidence/)
})
