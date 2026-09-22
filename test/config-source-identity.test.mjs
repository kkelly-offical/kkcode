import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, link } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config/load-config.mjs'
import { assertProviderOutboundAllowed, projectProviderControlReasons } from '../src/kernel/provider/security.mjs'

const config = { provider: { default: 'fixture', fixture: { type: 'openai-compatible', base_url: 'https://fixture.invalid/v1', api_key: 'fixture-key', default_model: 'fixture-model' } } }
const options = { providerName: 'fixture', protocol: 'openai', operation: 'provider inference' }
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-config-identity-'))
  const account = path.join(directory, 'account'), userRoot = path.join(account, '.kkcode'), project = path.join(directory, 'project')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = userRoot
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(directory, { recursive: true, force: true }) })
  await mkdir(userRoot, { recursive: true }); await mkdir(project)
  const userFile = path.join(userRoot, 'config.json'); await writeFile(userFile, JSON.stringify(config))
  return { account, userRoot, userFile, project }
}

test('a home-directory session does not mistake its user config for project-controlled provider credentials', async t => {
  const { account, userFile } = await fixture(t)
  const loaded = await loadConfig(account)
  assert.equal(loaded.source.userPath, userFile); assert.equal(loaded.source.projectPath, null)
  assert.deepEqual(loaded.source.projectRaw, {})
  assert.deepEqual(projectProviderControlReasons(loaded, options), [])
  await assert.doesNotReject(assertProviderOutboundAllowed(loaded, options))
})

test('a distinct project file remains untrusted even when its bytes equal user config', async t => {
  const { account } = await fixture(t)
  const file = path.join(account, 'kkcode.config.json'); await writeFile(file, JSON.stringify(config))
  const loaded = await loadConfig(account)
  assert.equal(loaded.source.projectPath, file)
  assert.ok(projectProviderControlReasons(loaded, options).length >= 3)
  await assert.rejects(assertProviderOutboundAllowed(loaded, options), error => error.details.reason === 'workspace_untrusted')
})

test('physical user-file aliases are skipped without hiding a later distinct project configuration', async t => {
  const { userFile, project } = await fixture(t)
  await link(userFile, path.join(project, 'kkcode.config.json'))
  assert.equal((await loadConfig(project)).source.projectPath, null)
  await mkdir(path.join(project, '.kkcode'))
  const later = path.join(project, '.kkcode', 'config.json'); await writeFile(later, JSON.stringify(config))
  const loaded = await loadConfig(project)
  assert.equal(loaded.source.projectPath, later)
  await assert.rejects(assertProviderOutboundAllowed(loaded, options), error => error.details.reason === 'workspace_untrusted')
})

test('a physical alias of the user env file retains user-source attribution', async t => {
  const { userRoot, project } = await fixture(t)
  const env = path.join(userRoot, '.env')
  await writeFile(env, 'KKCODE_PROVIDER__FIXTURE__BASE_URL=https://user-env.invalid/v1\n')
  await link(env, path.join(project, '.env'))
  const loaded = await loadConfig(project)
  assert.equal(loaded.source.envScope, 'user')
  assert.equal(loaded.userConfig.provider.fixture.base_url, 'https://user-env.invalid/v1')
  assert.deepEqual(projectProviderControlReasons(loaded, options), [])
})
