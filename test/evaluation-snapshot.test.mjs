import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, unlink, link } from 'node:fs/promises'
import { freezeEvaluationRuntime } from '../evaluation/v1/snapshot.mjs'
import { captureAcceptanceCandidate } from '../src/kernel/session/acceptance-manifest.mjs'

test('evaluation host snapshot freezes dirty source and separate installed dependencies without copying private state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-evaluation-snapshot-')), source = path.join(root, 'mutable')
  try {
    await mkdir(source)
    await writeFile(path.join(source, '.gitignore'), 'node_modules/\ntest-results/\n')
    await writeFile(path.join(source, 'index.mjs'), 'export const value = 1\n')
    await writeFile(path.join(source, '.env'), 'TRACKED_OLD_CREDENTIAL=synthetic-do-not-copy\n')
    await mkdir(path.join(source, 'secrets')); await writeFile(path.join(source, 'secrets', 'old'), 'TRACKED_DELETED_CREDENTIAL synthetic-do-not-copy')
    const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: 'pipe' }).trim()
    git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'])
    const baseRevision = git(['rev-parse', 'HEAD'])
    await writeFile(path.join(source, 'index.mjs'), 'export const value = 2\n')
    await writeFile(path.join(source, 'new.mjs'), 'export const added = true\n')
    await writeFile(path.join(source, '.env'), 'TRACKED_NEW_CREDENTIAL=synthetic-do-not-copy\n')
    await unlink(path.join(source, 'secrets', 'old'))
    await writeFile(path.join(source, 'secrets', 'synthetic'), 'never copy this synthetic value')
    await mkdir(path.join(source, 'node_modules')); await writeFile(path.join(source, 'node_modules', 'fixture.mjs'), 'export const dependency = true\n')
    await link(path.join(source, 'node_modules', 'fixture.mjs'), path.join(source, 'node_modules', 'fixture-alias.mjs'))
    const snapshot = await freezeEvaluationRuntime({ source, parent: path.join(root, 'private'), baseRevision })
    assert.equal(snapshot.sourceBaseRevision, baseRevision)
    assert.equal(await readFile(path.join(snapshot.cwd, 'index.mjs'), 'utf8'), 'export const value = 2\n')
    assert.equal(await readFile(path.join(snapshot.cwd, 'new.mjs'), 'utf8'), 'export const added = true\n')
    assert.equal(await readFile(path.join(snapshot.cwd, 'node_modules', 'fixture.mjs'), 'utf8'), 'export const dependency = true\n')
    await assert.rejects(lstat(path.join(snapshot.cwd, 'secrets')), { code: 'ENOENT' })
    await assert.rejects(lstat(path.join(snapshot.cwd, '.env')), { code: 'ENOENT' })
    const diff = await readFile(path.join(snapshot.root, 'source.diff'), 'utf8')
    assert.equal(/TRACKED_(?:OLD|NEW|DELETED)_CREDENTIAL/.test(diff), false, 'modified and deleted private blobs cannot leak through provenance diff')
    assert.match(diff, /value = 2/)
    assert.equal(snapshot.sourceDiffFiltered, true)
    assert.equal((await lstat(path.join(snapshot.cwd, 'node_modules', 'fixture.mjs'))).nlink, 1)
    assert.equal((await lstat(path.join(snapshot.cwd, 'node_modules', 'fixture-alias.mjs'))).nlink, 1)
    assert.notEqual((await lstat(path.join(snapshot.cwd, 'node_modules', 'fixture.mjs'))).ino, (await lstat(path.join(snapshot.cwd, 'node_modules', 'fixture-alias.mjs'))).ino)
    assert.notEqual((await lstat(path.join(snapshot.cwd, 'node_modules', 'fixture.mjs'))).ino, (await lstat(path.join(source, 'node_modules', 'fixture.mjs'))).ino)
    assert.match(snapshot.dependencies.treeHash, /^[a-f0-9]{64}$/)
    assert.equal((await captureAcceptanceCandidate(snapshot.cwd)).treeFingerprint, snapshot.candidateHash)
    await writeFile(path.join(source, 'index.mjs'), 'export const value = 3\n')
    assert.equal((await captureAcceptanceCandidate(snapshot.cwd)).treeFingerprint, snapshot.candidateHash, 'later source edits do not invalidate the frozen host runtime')
    assert.equal(git(['rev-parse', 'HEAD']), baseRevision, 'source repository is never committed or switched')
    await assert.rejects(freezeEvaluationRuntime({ source, parent: path.join(source, 'nested'), includeDependencies: false }), /outside the mutable source/)
    await assert.rejects(lstat(path.join(source, 'nested')), { code: 'ENOENT' })
    await writeFile(path.join(root, 'outside-private'), 'synthetic-outside-credential')
    await link(path.join(root, 'outside-private'), path.join(source, 'node_modules', 'outside-link.mjs'))
    await assert.rejects(freezeEvaluationRuntime({ source, parent: path.join(root, 'private'), baseRevision }), /unaccounted hardlink/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
