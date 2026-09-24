import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKernel } from '../src/kernel/index.mjs'
import { createHostServices, normalizeHostServices, configureHostServices, readHostServices, hostServicesHash } from '../src/kernel/core/host-services.mjs'
import { createLanguageService } from '../src/kernel/lsp/service.mjs'
import { currentRuntime } from '../src/kernel/core/runtime-context.mjs'

const image = `sha256:${'a'.repeat(64)}`
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-host-services-')), old = process.env.KKCODE_HOME
  const cwd = path.join(root, 'workspace'); await mkdir(cwd); process.env.KKCODE_HOME = path.join(root, 'state')
  t.after(async () => { if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  return { root, cwd }
}
test('host service setup requires exact configuration confirmation and never reads project service settings', async t => {
  const f = await fixture(t), configuration = { schemaVersion: 1, office: { image } }
  await mkdir(path.join(f.cwd, '.kkcode'))
  await writeFile(path.join(f.cwd, '.kkcode', 'host-services.json'), JSON.stringify(configuration))
  assert.deepEqual(await readHostServices(), { schemaVersion: 1 })
  await assert.rejects(configureHostServices(configuration, 'wrong'), { code: 'host_services_config' })
  assert.deepEqual(await readHostServices(), { schemaVersion: 1 })
  await configureHostServices(configuration, hostServicesHash(configuration))
  assert.deepEqual(await readHostServices(), configuration)
  const services = await createHostServices(f.cwd)
  assert.equal(services.services.office.strict, true)
  assert.equal(services.diagnostics[0].readiness, 'configured-not-probed', 'constructing a handle does not claim the fake image is usable')
  await services.close()
})
test('service configuration rejects credentials, floating images, host code and model-shaped capabilities', async t => {
  const f = await fixture(t)
  for (const configuration of [
    { schemaVersion: 1, office: { image: 'latest' } },
    { schemaVersion: 1, office: { image, api_key: 'synthetic' } },
    { schemaVersion: 1, lsp: { image, mode: 'host', servers: {} } },
    { schemaVersion: 1, lsp: { image, servers: { javascript: { command: '/usr/bin/npx', args: ['server'] } } } },
    { schemaVersion: 1, lsp: { image, servers: { javascript: { command: '/usr/bin/node', env: { TOKEN: 'synthetic' } } } } }
  ]) assert.throws(() => normalizeHostServices(configuration), { code: 'host_services_config' })
  await assert.rejects(createHostServices(f.cwd, { office: { strict: true, run() {} } }), { code: 'host_services_config' })
})
test('unreadable private service configuration disables services without breaking ordinary kernel boot', async t => {
  const f = await fixture(t)
  await mkdir(process.env.KKCODE_HOME)
  await writeFile(path.join(process.env.KKCODE_HOME, 'host-services.json'), '{secret=not-valid-json', { mode: 0o600 })
  const services = await createHostServices(f.cwd)
  assert.deepEqual(services.services, {}); assert.equal(services.diagnostics[0].available, false)
  assert.equal(JSON.stringify(services.diagnostics).includes('secret'), false)
  await services.close()
  if (process.platform !== 'win32') {
    await writeFile(path.join(process.env.KKCODE_HOME, 'host-services.json'), '{"schemaVersion":1}')
    await chmod(path.join(process.env.KKCODE_HOME, 'host-services.json'), 0o644)
    await assert.rejects(readHostServices(), { code: 'host_services_config' })
  }
})
test('kernel owns branded service routing; per-turn JSON cannot replace the service and SDK services remain caller-owned', async t => {
  const f = await fixture(t)
  const service = await createLanguageService({ cwd: f.cwd, mode: 'host', servers: {}, authorizeStart: () => false })
  const kernel = await createKernel({ cwd: f.cwd, boot: false, trustState: { trusted: false }, services: { lsp: service } })
  try {
    assert.equal(kernel.run(() => currentRuntime().services.lsp), service)
    await kernel.tools.initialize({ cwd: f.cwd, config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } } })
    let invoked = false
    const result = await kernel.tools.call('office_capabilities', {}, { officeService: { run() { invoked = true; return {} } } })
    assert.equal(invoked, false)
    assert.match(result.output, /尚未配置/)
  } finally { await kernel.shutdown() }
  assert.equal(service.status().closed, false, 'injected instances belong to the host and may be shared only intentionally')
  service.close()
})
