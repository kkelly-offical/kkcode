import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'

test('grep/glob report missing ripgrep as a dependency error, never an empty search result', () => {
  const script = `import { createToolRegistry } from './src/kernel/tool/registry.mjs';
    const registry = createToolRegistry();
    await registry.initialize({ config: { tool: { sources: { local: false, plugin: false, mcp: false } } } });
    for (const name of ['glob', 'grep']) {
      const tool = await registry.get(name);
      console.log(await tool.execute({ pattern: 'fixture' }, { cwd: process.cwd() }));
    }`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
  env.PATH = ''
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.split('\n').filter(line => /\[search error\].*ripgrep.*not installed/.test(line)).length, 2)
  assert.doesNotMatch(child.stdout, /no matches|no files matched/)
})

test('all cross-platform verification/release jobs install and verify ripgrep', async () => {
  for (const [file, jobs] of [['verify.yml', ['verify']], ['release.yml', ['matrix_verify', 'release_verify']], ['acceptance.yml', ['system']]]) {
    const workflow = YAML.parse(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'))
    for (const job of jobs) assert.ok(workflow.jobs[job].steps.some(step => step.uses === './.github/actions/setup-search'), `${file}/${job}`)
  }
  const action = YAML.parse(await readFile(new URL('../.github/actions/setup-search/action.yml', import.meta.url), 'utf8'))
  assert.equal(action.runs.steps.length, 3)
  for (const step of action.runs.steps) assert.match(step.run, /rg --version/)
})
