import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGitPushTransport } from '../src/kernel/forge/git-transport.mjs'
import { createGitHttpFixture as fixture, TOKEN } from './helpers/forge-http.mjs'

const create = f => createGitPushTransport({ cwd: f.cwd, repository: f.repository, candidateSha: f.candidateSha, sourceBranch: 'kk/verified', targetBranch: 'main', targetSha: f.targetSha, token: TOKEN, allowPrivate: true })
const request = f => ({ repository: f.repository, candidateSha: f.candidateSha, sourceBranch: 'kk/verified', refspec: `${f.candidateSha}:refs/heads/kk/verified`, force: false })

test('host Git pushes the fixed sealed snapshot over actual HTTP without workspace helpers/config', { timeout: 30000 }, async t => {
  const f = await fixture(t), canary = path.join(f.base, 'executed-canary'), hooks = path.join(f.base, 'hooks')
  await mkdir(hooks)
  await writeFile(path.join(hooks, 'pre-push'), `#!/bin/sh\ntouch '${canary}'\nexit 1\n`); await chmod(path.join(hooks, 'pre-push'), 0o755)
  await f.git(['config', 'core.hooksPath', hooks])
  await f.git(['config', 'credential.helper', `!touch '${canary}'`])
  await f.git(['config', 'core.sshCommand', `touch '${canary}'`])
  await f.git(['config', 'url.http://127.0.0.1:9/unapproved/.insteadOf', 'http://127.0.0.1:'])
  const transport = await create(f); t.after(() => transport.close())
  assert.deepEqual(await transport.files(), [{ path: 'app.txt', kind: 'file', executable: false, size: 17, hash: createHash('sha256').update('sealed candidate\n').digest('hex') }])
  // The source repository can change after sealing. Transport owns its pack.
  await writeFile(path.join(f.cwd, 'app.txt'), 'unapproved later edit')
  const supplied = request(f), pending = transport.push(supplied)
  supplied.refspec = `${f.candidateSha}:refs/heads/main`
  supplied.sourceBranch = 'main'
  supplied.repository = { id: 'changed-identity' }
  const result = await pending
  assert.equal(result.candidateSha, f.candidateSha)
  assert.equal((await f.git(['rev-parse', 'refs/heads/kk/verified'], f.remote)).stdout.trim(), f.candidateSha)
  assert.equal((await f.git(['rev-parse', 'refs/heads/main'], f.remote)).stdout.trim(), f.targetSha)
  await assert.rejects(readFile(canary), { code: 'ENOENT' })
  assert.ok(f.requests.every(entry => entry.auth && entry.agent.startsWith('KK-Code/')))
})

test('Git transport refuses changed targets, scope tampering and redirects without writing refs', { timeout: 30000 }, async t => {
  const f = await fixture(t), transport = await create(f); t.after(() => transport.close())
  await assert.rejects(transport.push({ ...request(f), refspec: `${f.candidateSha}:refs/heads/main` }), { code: 'FORGE_SCOPE' })
  await f.git(['update-ref', 'refs/heads/main', f.candidateSha], f.remote).catch(async () => {
    // Transfer the candidate locally only to construct a moved-target fixture.
    await f.git(['push', f.remote, `${f.candidateSha}:refs/heads/main`])
  })
  await assert.rejects(transport.push(request(f)), { code: 'FORGE_TARGET_MOVED' })
  await assert.rejects(f.git(['rev-parse', '--verify', 'refs/heads/kk/verified'], f.remote))
  f.redirect()
  await assert.rejects(transport.push(request(f)), error => error.code === 'FORGE_GIT_FAILED' && !error.message.includes(TOKEN))
})
