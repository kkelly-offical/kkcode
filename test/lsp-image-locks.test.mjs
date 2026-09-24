import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createIsolatedLanguageServerConfigs } from '../src/kernel/lsp/image-preset.mjs'

test('language image inputs are explicit fixed versions with registry/download integrity', async () => {
  const directory = new URL('../containers/lsp/', import.meta.url)
  const packages = JSON.parse(await readFile(new URL('package-lock.json', directory), 'utf8'))
  assert.equal(packages.lockfileVersion, 3)
  assert.deepEqual(packages.packages[''].dependencies, { pyright: '1.1.414', typescript: '6.0.3', 'typescript-language-server': '6.0.0' })
  for (const [name, spec] of Object.entries(packages.packages)) if (name) {
    assert.match(spec.version, /^\d+\.\d+\.\d+$/)
    assert.equal(new URL(spec.resolved).origin, 'https://registry.npmjs.org')
    assert.match(spec.integrity, /^sha512-[A-Za-z0-9+/]+=*$/)
  }
  const downloads = JSON.parse(await readFile(new URL('downloads.lock.json', directory), 'utf8'))
  assert.equal(downloads.platform, 'linux-amd64')
  for (const name of ['go', 'kotlin']) {
    assert.match(downloads[name].sha256, /^[a-f0-9]{64}$/)
    assert.equal(new URL(downloads[name].url).protocol, 'https:')
    assert.ok(downloads[name].maxBytes <= 100000000)
  }
  assert.equal(downloads.kotlin.version, 'fwcd-1.3.13')
  assert.equal(downloads.kotlin.compilerVersion, '2.1.0')
  assert.match(downloads.gopls.sum, /^h1:/); assert.match(downloads.gopls.goModSum, /^h1:/)
})

test('language image preset never installs a server or permits arbitrary argv', () => {
  const configurations = createIsolatedLanguageServerConfigs()
  assert.deepEqual(Object.keys(configurations), ['typescript', 'javascript', 'python', 'go', 'kotlin'])
  for (const [language, configuration] of Object.entries(configurations)) {
    assert.equal(configuration.command, '/usr/local/bin/node')
    assert.deepEqual(configuration.args, ['/opt/kkcode-lsp/launch.mjs', language])
    assert.equal(Object.isFrozen(configuration), true)
  }
  assert.equal(configurations.typescript.initializationOptions.disableAutomaticTypingAcquisition, true)
  assert.throws(() => createIsolatedLanguageServerConfigs(['shell']))
  assert.throws(() => createIsolatedLanguageServerConfigs([]))
})
