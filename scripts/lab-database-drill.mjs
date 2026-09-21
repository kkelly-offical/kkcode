import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const exec = promisify(execFile)
const state = process.env.KKCODE_LAB_STATE || '/root/.local/share/kkcode-enterprise-lab'
const manifest = JSON.parse(await readFile(path.join(state, 'public.json'), 'utf8'))
const compose = ['compose', '--env-file', path.join(state, 'lab.env'), '-f', path.resolve('deploy/lab/compose.yaml')]
const folder = path.join(state, 'backups')
await mkdir(folder, { recursive: true, mode: 0o700 }); await chmod(folder, 0o700)
const keyPath = path.join(folder, 'backup.key')
let key
try { key = await readFile(keyPath) } catch (error) { if (error.code !== 'ENOENT') throw error; key = randomBytes(32); await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 }) }
assert.equal(key.length, 32)
const run = async (service, args, input) => {
  const { stdout: container } = await exec('docker', [...compose, 'ps', '-q', service])
  if (!/^[a-f0-9]{12,64}$/.test(container.trim())) throw new Error('Lab database container was not found')
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', container.trim(), ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error(`${service}: database command failed (sensitive diagnostics suppressed)`)) : resolve(stdout))
    child.stdin.end(input)
  })
}
const results = []
for (const [service, user, database, table] of [['gateway-database', 'kkcode', 'kkcode', 'kkcode_gateway'], ['sso-database', 'keycloak', 'keycloak', 'user_entity']]) {
  const suffix = randomBytes(6).toString('hex'), restore = `kkcode_restore_${suffix}`
  const dump = await run(service, ['pg_dump', '-U', user, '-d', database, '--format=custom', '--no-owner'])
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(dump), cipher.final()])
  const artifact = path.join(folder, `${database}-${Date.now()}-${suffix}.pgdump.aesgcm`)
  await writeFile(artifact, Buffer.concat([Buffer.from('KKBACKUP1'), iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 })
  const bytes = await readFile(artifact)
  assert.equal(bytes.subarray(0, 9).toString(), 'KKBACKUP1')
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(9, 21)); decipher.setAuthTag(bytes.subarray(21, 37))
  const restored = Buffer.concat([decipher.update(bytes.subarray(37)), decipher.final()])
  assert.equal(createHash('sha256').update(restored).digest('hex'), createHash('sha256').update(dump).digest('hex'))
  await run(service, ['createdb', '-U', user, restore])
  try {
    await run(service, ['pg_restore', '-U', user, '-d', restore, '--exit-on-error', '--no-owner'], restored)
    const rows = Number((await run(service, ['psql', '-U', user, '-d', restore, '-Atc', `SELECT count(*) FROM ${table}`])).toString().trim())
    assert.ok(Number.isSafeInteger(rows) && rows > 0)
    // Restored gateway data must contain only metadata, never model credentials or conversation bodies.
    if (database === 'kkcode') {
      const invalid = Number((await run(service, ['psql', '-U', user, '-d', restore, '-Atc', "SELECT count(*) FROM kkcode_gateway WHERE key LIKE 'conversation:%' OR key LIKE 'model-credentials:%' OR key LIKE 'rpc-payload:%'"])).toString().trim())
      assert.equal(invalid, 0)
    }
    results.push({ database, restoredRows: rows, encryptedBackup: artifact, bytes: dump.length, restoreVerified: true })
    console.log(`${database}: encrypted pg_dump verified and restored into an isolated temporary database (${rows} rows)`)
  } finally {
    assert.match(restore, /^kkcode_restore_[a-f0-9]{12}$/)
    await run(service, ['dropdb', '-U', user, restore])
  }
}
await writeFile(path.join(folder, 'last-drill.json'), JSON.stringify({ gateway: manifest.gateway, at: new Date().toISOString(), results }, null, 2), { mode: 0o600 })
console.log('Live databases unchanged; only the two explicitly created restore databases were removed. Encrypted backups retained outside Git.')
