import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DeviceService } from '../src/device/service.mjs'
import { resolveManagedMcpConfig } from '../src/kernel/mcp/managed-config.mjs'
test('owner-managed MCP credentials are encrypted and bound to the connection; busy and foreign writes fail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-extension-test-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'home')
  await mkdir(process.env.KKCODE_HOME)
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ mcp: { auto_discover: false, servers: {} }, skills: { auto_seed: false } }))
  const service = await new DeviceService({ cwd: root, roots: [root] }).initialize()
  const call = (method, params = {}, principal) => service.request({ id: randomUUID(), method, params }, principal)
  try {
    await call('extensions.manage', { action: 'mcp.save', name: 'design', transport: 'streamable-http', url: 'https://design.invalid/mcp?userToken=private-url', headers: [{ key: 'Authorization', value: 'private-header' }] })
    const configPath = path.join(process.env.KKCODE_HOME, 'config.json'), raw = await readFile(configPath, 'utf8'), config = JSON.parse(raw).mcp.servers.design
    assert.ok(config.credential_ref); assert.ok(!raw.includes('private-'))
    const resolved = await resolveManagedMcpConfig('design', { ...config, url: 'https://attacker.invalid', headers: { Authorization: 'replaced' } })
    assert.equal(resolved.url, 'https://design.invalid/mcp?userToken=private-url')
    assert.equal(resolved.headers.Authorization, 'private-header')
    const catalog = await call('extensions.catalog')
    assert.ok(!JSON.stringify(catalog).includes('private-'))
    assert.deepEqual(catalog.mcp[0].headerKeys, ['Authorization'])
    for (const name of await readdir(path.join(process.env.KKCODE_HOME, 'credentials'))) assert.ok(!(await readFile(path.join(process.env.KKCODE_HOME, 'credentials', name))).includes(Buffer.from('private-header')))
    await assert.rejects(call('extensions.manage', { action: 'mcp.toggle', name: 'design', enabled: false }, { id: 'intruder', client: 'foreign' }), { code: 'forbidden' })
    service.configurationUpdating = true
    await assert.rejects(call('extensions.manage', { action: 'mcp.toggle', name: 'design', enabled: false }), { code: 'configuration_busy' })
    service.configurationUpdating = false
    const kernel = await service.kernel(), initialize = kernel.extensions.mcp.initialize
    let release, entered, finished = false
    const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
    kernel.extensions.mcp.initialize = async (...args) => { entered(); await gate; return initialize(...args) }
    const toggle = call('extensions.manage', { action: 'mcp.toggle', name: 'design', enabled: false }).then(result => { finished = true; return result })
    try {
      await Promise.race([started, toggle.then(() => { throw new Error('Connection edit completed before the registry applied it') })])
      assert.equal(finished, false, 'a pending registry refresh cannot be advertised as a completed edit')
      // During the refresh, a health snapshot of the old connection cannot
      // overwrite the current persisted switch state in another client's list.
      const snapshot = kernel.extensions.mcp.healthSnapshot
      kernel.extensions.mcp.healthSnapshot = () => [{ name: 'design', enabled: true, ok: true }]
      try { assert.equal((await call('extensions.catalog')).mcp[0].enabled, false) }
      finally { kernel.extensions.mcp.healthSnapshot = snapshot }
    } finally { release(); await toggle; kernel.extensions.mcp.initialize = initialize }
    assert.equal((await call('extensions.catalog')).mcp[0].enabled, false)
    assert.equal(kernel.extensions.mcp.connectionConfig('design').enabled, false)
    assert.equal(kernel.extensions.mcp.healthSnapshot()[0].reason, 'disabled')
    for (const name of ['../outside', 'plugin/skill', '..', 'C:\\escape', '__proto__']) {
      await assert.rejects(call('extensions.manage', { action: 'skill.save', name, content: `---\nname: ${name}\ndescription: unsafe path\n---\nBody` }), { code: 'extension_input' })
    }
    await call('extensions.manage', { action: 'skill.save', name: 'safe-skill', content: '---\nname: safe-skill\ndescription: Imported fixture\n---\nPreserve the user scope.' })
    assert.match(await readFile(path.join(process.env.KKCODE_HOME, 'skills', 'safe-skill', 'SKILL.md'), 'utf8'), /Preserve the user scope/)
  } finally { await service.close(); if(previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) }
})
