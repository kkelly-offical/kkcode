import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { verifyAuditChain } from '../src/storage/audit-store.mjs'

const execFile = promisify(execFileCallback)
const rounds = Number(process.argv[2] || 20), writers = 4, entriesPerWriter = 40
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('Use 1–100 audit stress rounds')
const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-audit-contention-'))
const previous = process.env.KKCODE_HOME, moduleUrl = new URL('../src/storage/audit-store.mjs', import.meta.url).href
try {
  for (let round = 0; round < rounds; round++) {
    const directory = path.join(root, String(round))
    await mkdir(directory)
    const children = await Promise.allSettled(Array.from({ length: writers }, (_, writer) => execFile(process.execPath, ['--input-type=module', '-e',
      `import { appendAuditEntry } from ${JSON.stringify(moduleUrl)}; for(let index=0;index<${entriesPerWriter};index++) await appendAuditEntry({type:'contention-fixture',writer:${writer},index});`
    ], { env: { ...process.env, KKCODE_HOME: directory }, timeout: 60000, maxBuffer: 1024 * 1024 })))
    const failed = children.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    process.env.KKCODE_HOME = directory
    const result = await verifyAuditChain()
    if (!result.ok || result.entries !== writers * entriesPerWriter) throw new Error(`Audit contention failed in round ${round}: ${JSON.stringify(result)}`)
  }
  const report = { platform: process.platform, node: process.version, rounds, writers, entriesPerWriter, entriesVerified: rounds * writers * entriesPerWriter, ok: true }
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/audit-concurrency.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  if (previous === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = previous
  await rm(root, { recursive: true, force: true })
}
