import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

test('desktop backend pairs locally, authorizes only a selected folder, and shuts down cleanly', { timeout: 40000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kkcode-desktop-'))
  const home = path.join(directory, 'private'), workspace = path.join(directory, 'project')
  await mkdir(workspace)
  const root = fileURLToPath(new URL('../', import.meta.url))
  const child = fork(path.join(root, 'apps/desktop/backend.mjs'), [root], { env: { ...process.env, KKCODE_HOME: home, KKCODE_DESKTOP_ROOTS: JSON.stringify([workspace]) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  child.stderr.on('data', data => { errors += data.toString() })
  const waitFor = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Desktop response timeout: ${errors.slice(-1000)}`)) }, 20000)
    const onMessage = message => { if (predicate(message)) { cleanup(); resolve(message) } }
    const onExit = code => { cleanup(); reject(new Error(`Backend exited (${code}): ${errors.slice(-1000)}`)) }
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
  try {
    const ready = await waitFor(message => message.type === 'ready')
    const url = new URL(ready.url)
    assert.equal(url.hostname, '127.0.0.1')
    const health = await (await fetch(`${url.origin}/health`)).json()
    assert.equal(health.ok, true)
    const unpaired = await fetch(`${url.origin}/api/v1/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'before-pair', method: 'status' }) })
    assert.equal(unpaired.status, 401)
    const pair = await fetch(`${url.origin}/api/v1/auth/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrap: new URLSearchParams(url.hash.slice(1)).get('bootstrap'), native: true }) })
    assert.equal(pair.status, 200)
    const { token } = await pair.json()
    const rpc = async (method, params = {}) => {
      const response = await fetch(`${url.origin}/api/v1/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: randomUUID(), method, params }) })
      return { status: response.status, value: await response.json() }
    }
    const status = await rpc('status')
    assert.equal(status.status, 200, JSON.stringify(status.value))
    assert.equal(status.value.result.active.length, 0)
    const add = waitFor(message => message.id === 'allow')
    child.send({ id: 'allow', type: 'allow-root', path: workspace })
    assert.equal((await add).result.path, workspace)
    assert.equal((await rpc('folders.list', { path: workspace })).status, 200)
    const deny = waitFor(message => message.id === 'deny-private')
    child.send({ id: 'deny-private', type: 'allow-root', path: home })
    assert.ok((await deny).error, 'private agent storage must never become a browsable project')
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.send({ id: 'close', type: 'close' })
    assert.equal(await exited, 0)
  } finally {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited }
    await rm(directory, { recursive: true, force: true })
  }
})
