import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { checkReleaseVersions } from '../scripts/check-release-version.mjs'
import { releaseVersionPolicy, releaseWorkspacePaths, resolveReleaseMetadata, validateReleaseManifests } from '../scripts/release-policy.mjs'

function manifests(version = '1.0.1-preview.1') {
  const directories = ['apps/web', 'apps/gateway', 'packages/protocol', 'packages/sdk']
  const manifest = { name: '@kkelly-offical/kkcode', version, workspaces: directories }
  const workspaceManifests = Object.fromEntries(directories.map(directory => [directory, { name: `@kkcode/${path.basename(directory)}`, version, private: true }]))
  const lockfile = { name: manifest.name, version, lockfileVersion: 3, packages: { '': structuredClone(manifest), ...structuredClone(workspaceManifests) } }
  return { manifest, lockfile, workspaceManifests }
}

test('stable, RC and preview versions map to three distinct npm channels', () => {
  for (const [version, channel, distTag, prerelease] of [
    ['1.0.0', 'stable', 'latest', false], ['1.0.27', 'stable', 'latest', false],
    ['1.0.1-rc.0', 'rc', 'next', true], ['1.0.2-rc.12', 'rc', 'next', true],
    ['1.0.1-preview.0', 'preview', 'preview', true], ['1.0.2-preview.18', 'preview', 'preview', true]
  ]) assert.deepEqual(releaseVersionPolicy(version), { version, channel, distTag, prerelease })
})

test('version policy rejects unauthorized bumps, unsupported channels and output injection', () => {
  for (const version of ['1.1.0', '2.0.0', '0.9.9', '1.0.01', '1.0.1-preview', '1.0.1-preview.01', '1.0.1-rc.01', '1.0.1-alpha.0', '1.0.1-Preview.0', 'v1.0.1', '1.0.1+build', '1.0.1\n', '1.0.1-preview.0\npublish=true', '1.0.9007199254740992', '1.0.1-preview.9007199254740992', '1.0.1-rc.9007199254740992', '', null, 100]) {
    assert.throws(() => releaseVersionPolicy(version), /release policy/, String(version))
  }
})

test('tag metadata uses the shared channel policy and manual runs never publish', () => {
  for (const version of ['1.0.1', '1.0.1-rc.0', '1.0.1-preview.0']) {
    const policy = releaseVersionPolicy(version)
    assert.deepEqual(resolveReleaseMetadata({ version, refType: 'tag', refName: `v${version}` }), { publish: true, release_version: version, dist_tag: policy.distTag, prerelease: policy.prerelease })
    assert.deepEqual(resolveReleaseMetadata({ version, refType: 'branch', refName: `v${version}` }), { publish: false, release_version: version, dist_tag: '', prerelease: false })
  }
  for (const refName of ['1.0.1-preview.0', 'v1.0.1', 'v1.0.1-preview.1', 'v1.0.1-preview.0\n']) assert.throws(() => resolveReleaseMetadata({ version: '1.0.1-preview.0', refType: 'tag', refName }), /exactly match/)
})

test('version checks cover root, every workspace and every lockfile entry', () => {
  const fixture = manifests()
  assert.equal(validateReleaseManifests(fixture.manifest, fixture.lockfile, fixture.workspaceManifests).workspaces.length, 4)
  const mismatches = [
    value => { value.lockfile.version = '1.0.1' },
    value => { value.lockfile.packages[''].version = '1.0.1' },
    value => { delete value.lockfile.packages[''] },
    value => { value.lockfile.name = '@wrong/name' },
    value => { value.lockfile.packages[''].workspaces = ['apps/web'] }
  ]
  for (const directory of fixture.manifest.workspaces) {
    mismatches.push(value => { value.workspaceManifests[directory].version = '1.0.1' })
    mismatches.push(value => { value.lockfile.packages[directory].version = '1.0.1' })
    mismatches.push(value => { delete value.lockfile.packages[directory] })
    mismatches.push(value => { value.lockfile.packages[directory].name = '@wrong/workspace' })
    mismatches.push(value => { value.workspaceManifests[directory].private = false })
    mismatches.push(value => { delete value.workspaceManifests[directory].private })
  }
  for (const mutate of mismatches) {
    const value = manifests(); mutate(value)
    assert.throws(() => validateReleaseManifests(value.manifest, value.lockfile, value.workspaceManifests), /must|version/)
  }
})

test('release workspace enumeration cannot read outside the repository or silently omit globbed packages', () => {
  for (const workspaces of [['../outside'], ['/absolute'], ['file:/outside'], ['apps/*'], ['apps/web', 'apps/web'], ['apps/./web'], ['apps/web#fragment'], ['apps/%2e%2e/outside'], undefined]) {
    assert.throws(() => releaseWorkspacePaths({ workspaces }), /workspace/)
  }
  assert.deepEqual(releaseWorkspacePaths({ workspaces: { packages: ['apps/web'] } }), ['apps/web'])
})

test('the filesystem version checker actually reads workspace manifests and their lock entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-release-policy-')), { manifest, lockfile, workspaceManifests } = manifests()
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest))
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lockfile))
    for (const [directory, data] of Object.entries(workspaceManifests)) { await mkdir(path.join(root, directory), { recursive: true }); await writeFile(path.join(root, directory, 'package.json'), JSON.stringify(data)) }
    assert.equal((await checkReleaseVersions(root)).distTag, 'preview')
    await writeFile(path.join(root, 'packages/sdk/package.json'), JSON.stringify({ ...workspaceManifests['packages/sdk'], version: '1.0.1' }))
    await assert.rejects(checkReleaseVersions(root), /packages\/sdk\/package.json version must be 1.0.1-preview.1/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('preview releases retain matrix, protected main ancestry and immutable artifact gates', async () => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.jobs.matrix_verify.strategy.matrix.include.length, 4)
  assert.ok(workflow.jobs.matrix_verify.steps.some(step => step.run === 'npm run version:check'))
  assert.equal(workflow.jobs.release_verify.needs, 'matrix_verify')
  assert.equal(workflow.jobs.release_verify.environment, 'npm-release')
  const steps = workflow.jobs.release_verify.steps, metadata = steps.find(step => step.id === 'release').run
  assert.match(metadata, /node scripts\/check-release-version\.mjs/)
  assert.match(metadata, /git fetch --no-tags origin main/)
  assert.match(metadata, /git merge-base --is-ancestor "\$\{GITHUB_SHA\}" FETCH_HEAD/)
  assert.ok(metadata.indexOf('git merge-base') < metadata.indexOf('await appendFile'))
  assert.match(metadata, /resolveReleaseMetadata\(/)
  assert.doesNotMatch(metadata, /if.*(?:preview|rc)/, 'no prerelease-specific ancestry bypass')
  const publish = steps.findIndex(step => step.name === 'Publish npm package')
  for (const name of ['npm run release:verify', 'Audit production dependencies', 'Verify immutable npm package', 'Confirm npm package stayed immutable']) {
    const index = steps.findIndex(step => step.name === name || step.run === name)
    assert.ok(index >= 0 && index < publish, name)
  }
  assert.equal(steps[publish].if, "steps.release.outputs.publish == 'true'")
  assert.match(steps[publish].run, /npm publish "\$PACKAGE_TARBALL" --ignore-scripts --access public --tag "\$DIST_TAG"/)
  const github = steps.find(step => step.name === 'Create or update GitHub Release')
  assert.equal(github.if, "steps.release.outputs.publish == 'true'")
  assert.equal((github.run.match(/--prerelease --latest=false/g) || []).length, 2, 'both preview creation and update must avoid the Latest badge')
})
