import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {mkdtemp, readFile, rm, access} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {Header} from 'tar'
import {pinnedNpmIdentity, registryTarget, unpackNpmPlugin} from '../src/kernel/plugin/npm-source.mjs'

const identity = {name: '@example/plugin', version: '1.2.3'}
function tar(entries, prefix = 'package') {
  const chunks = []
  for (const entry of [{path: 'package/package.json', data: JSON.stringify({...identity, scripts: {postinstall: 'DO_NOT_EXECUTE'}})}, ...entries]) {
    const data = Buffer.from(entry.data || '')
    const header = new Header({path: entry.path.replace(/^package\//, prefix + '/'), type: entry.type || 'File', mode: 0o644, size: data.length, linkpath: entry.linkpath || ''})
    const buffer = Buffer.alloc(512); header.encode(buffer)
    chunks.push(buffer, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}
async function fixture(t) {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'kk-plugin-npm-'))
  t.after(() => rm(staging, {recursive: true, force: true}))
  return {staging, payload: path.join(staging, 'payload')}
}
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64')

test('npm source accepts only fixed package versions and credential-free public registry URLs', () => {
  assert.deepEqual(pinnedNpmIdentity('@example/plugin@1.2.3'), identity)
  for (const spec of ['plugin@latest', 'https://example.test/a.tgz', 'plugin@^1.2.3', '../local@1.2.3']) assert.throws(() => pinnedNpmIdentity(spec))
  assert.equal(registryTarget('https://registry.npmjs.org/a/-/a-1.2.3.tgz').hostname, 'registry.npmjs.org')
  for (const url of ['https://example.test/a.tgz', 'http://registry.npmjs.org/a', 'https://user:secret@registry.npmjs.org/a', 'https://registry.npmjs.org/a?token=x', 'http://127.0.0.1/a']) assert.throws(() => registryTarget(url))
})

test('verified npm archives unpack plugin components without executing lifecycle scripts', async t => {
  const f = await fixture(t)
  const bytes = tar([{path: 'package/plugin.json', data: '{"name":"plugin"}'}, {path: 'package/.mcp.json', data: '{}'}, {path: 'package/tools/example.mjs', data: 'export default {name:"example"};'}])
  assert.equal(await unpackNpmPlugin({...f, bytes, identity, integrity: integrity(bytes)}), integrity(bytes))
  assert.equal(await readFile(path.join(f.payload, '.mcp.json'), 'utf8'), '{}')
  assert.match(await readFile(path.join(f.payload, 'package.json'), 'utf8'), /DO_NOT_EXECUTE/)
})

for (const entry of [
  {path: 'package/../../escape', data: 'escape'},
  {path: 'package/link', type: 'SymbolicLink', linkpath: '/etc/passwd'},
  {path: 'package/link', type: 'Link', linkpath: 'package/package.json'},
  {path: 'package/.git/config', data: 'unsafe'},
  {path: 'package/CON', data: 'unsafe'},
  {path: 'package/Package.json', data: 'case alias'}
]) test(`unsafe npm archive is rejected before extraction: ${entry.path} ${entry.type || ''}`, async t => {
  const f = await fixture(t), bytes = tar([entry])
  await assert.rejects(unpackNpmPlugin({...f, bytes, identity, integrity: integrity(bytes)}), {code: 'DEPENDENCY_ARCHIVE'})
  await assert.rejects(access(f.payload), {code: 'ENOENT'})
})

test('archive bytes and package identity must both match the pinned source', async t => {
  const f = await fixture(t), bytes = tar([])
  await assert.rejects(unpackNpmPlugin({...f, bytes, identity, integrity: integrity(Buffer.from('different'))}), /integrity mismatch/)
  await assert.rejects(unpackNpmPlugin({...f, bytes, identity: {...identity, version: '9.9.9'}, integrity: integrity(bytes)}), /identity does not match/)
  await assert.rejects(access(f.payload), {code: 'ENOENT'})
})

test('alternate single npm archive roots remain compatible without permitting sibling roots', async t => {
  const f = await fixture(t), bytes = tar([{path: 'package/plugin.json', data: '{}'}], 'custom-name')
  await unpackNpmPlugin({...f, bytes, identity, integrity: integrity(bytes)})
  assert.equal(await readFile(path.join(f.payload, 'plugin.json'), 'utf8'), '{}')
  const other = await fixture(t), bad = tar([{path: 'sibling/foreign.txt', data: 'no'}])
  await assert.rejects(unpackNpmPlugin({...other, bytes: bad, identity, integrity: integrity(bad)}), {code: 'DEPENDENCY_ARCHIVE'})
})
