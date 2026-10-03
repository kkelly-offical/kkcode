import {createHash, timingSafeEqual} from 'node:crypto'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {x as extract} from 'tar'
import {guardedFetch} from '../../net/url-guard.mjs'
import {buildRequestHeaders} from '../../http/identity.mjs'
import {auditPackageArchive} from '../../dependencies/archive-audit.mjs'

const REGISTRY = 'https://registry.npmjs.org'
const fail = message => {throw Object.assign(new Error(message), {code: 'plugin_npm_source'})}
export function pinnedNpmIdentity(spec) {
  const match = /^(?<name>(?:@[a-z0-9_~-][a-z0-9._~-]*\/)?[a-z0-9_~-][a-z0-9._~-]*)@(?<version>\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.exec(spec)
  if (!match || match[0] !== spec) fail('npm plugins require an exact version and a registry package name')
  return {name: match.groups.name, version: match.groups.version}
}
export function registryTarget(input) {
  const url = new URL(input)
  if (url.origin !== REGISTRY || url.username || url.password || url.search || url.hash) fail('npm plugin downloads must stay on the public registry without credentials or query parameters')
  return url
}
async function download(url, maxBytes, signal) {
  registryTarget(url)
  const {response} = await guardedFetch(url, {headers: {...buildRequestHeaders({target: 'npm', accept: 'application/json, application/octet-stream'}), 'cache-control': 'no-store'}, signal},
    {maxWireBytes: maxBytes, maxDecodedBytes: maxBytes, assertTarget: registryTarget})
  if (!response.ok) fail(`npm registry download failed (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}

export function verifyNpmIntegrity(bytes, integrity) {
  const match = /^sha(256|384|512)-([A-Za-z0-9+/=]+)$/.exec(integrity || '')
  if (!match) fail('npm plugin has no verifiable content integrity')
  const expected = Buffer.from(match[2], 'base64'), actual = createHash('sha' + match[1]).update(bytes).digest()
  if (expected.toString('base64') !== match[2] || expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('npm plugin archive integrity mismatch')
}

/** Downloads bytes only. Never executes lifecycle scripts, resolves dependencies
 * or reads npm credentials/configuration; no shared HTTP cache is created. */
export async function fetchNpmPlugin({spec, staging, payload, expectedIntegrity = null, signal = AbortSignal.timeout(120000)}) {
  const identity = pinnedNpmIdentity(spec)
  const manifest = JSON.parse((await download(`${REGISTRY}/${encodeURIComponent(identity.name)}/${identity.version}`, 2 * 1024 * 1024, signal)).toString('utf8'))
  if (manifest.name !== identity.name || manifest.version !== identity.version) fail('Registry metadata does not match the pinned npm package')
  const integrity = manifest.dist?.integrity
  if (typeof integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity)) fail('npm plugin has no verifiable content integrity')
  if (expectedIntegrity && expectedIntegrity !== integrity) fail('Pinned npm version integrity changed; refusing replacement')
  registryTarget(manifest.dist?.tarball)
  const bytes = await download(manifest.dist.tarball, 64 * 1024 * 1024, signal)
  return unpackNpmPlugin({bytes, identity, integrity, staging, payload, signal})
}

export async function unpackNpmPlugin({bytes, identity, integrity, staging, payload, signal}) {
  verifyNpmIntegrity(bytes, integrity)
  const archive = path.join(staging, 'package.tgz')
  await writeFile(archive, bytes, {flag: 'wx', mode: 0o600})
  const inspected = await auditPackageArchive(archive, 128 * 1024 * 1024, signal, {profile: 'plugin'})
  if (inspected.manifest.name !== identity.name || inspected.manifest.version !== identity.version) fail('Archive package identity does not match registry metadata')
  signal?.throwIfAborted()
  await mkdir(payload, {mode: 0o700})
  await extract({file: archive, cwd: payload, strip: 1, strict: true, preserveOwner: false, noMtime: true, maxMetaEntrySize: 65536, maxDecompressionRatio: 200})
  signal?.throwIfAborted()
  return integrity
}
