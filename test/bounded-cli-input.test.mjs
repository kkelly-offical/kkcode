import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, open, link, symlink, lstat, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readBoundedJsonInput } from '../src/commands/bounded-input.mjs'

const exec = promisify(execFile), maximum = 1024 * 1024
const canary = 'invalid-json-sensitive-content-must-not-appear'
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-bounded-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('bounded CLI JSON reads exact-limit UTF-8 and rejects malformed contents without echoing them', async t => {
  const root = await fixture(t), file = path.join(root, 'input.json'), body = JSON.stringify({ text: '中文参数' })
  await writeFile(file, body)
  assert.deepEqual(await readBoundedJsonInput(file, { maxBytes: Buffer.byteLength(body) }), { text: '中文参数' })
  await assert.rejects(readBoundedJsonInput(file, { maxBytes: Buffer.byteLength(body) - 1 }), { code: 'CLI_INPUT_SIZE' })
  await writeFile(file, `{${canary}`)
  await assert.rejects(readBoundedJsonInput(file), error => error.code === 'CLI_INPUT_JSON' && !error.message.includes(canary) && !error.stack.includes(canary))
})

test('bounded CLI JSON rejects huge sparse files, directories, symlinks and multiple links before reading', async t => {
  const root = await fixture(t), huge = path.join(root, 'huge.json')
  const handle = await open(huge, 'wx')
  try { await handle.truncate(2 * 1024 * 1024 * 1024) } finally { await handle.close() }
  await assert.rejects(readBoundedJsonInput(huge), { code: 'CLI_INPUT_SIZE' })
  await assert.rejects(readBoundedJsonInput(root), { code: 'CLI_INPUT_TYPE' })
  const file = path.join(root, 'regular.json'), hardlink = path.join(root, 'hard.json')
  await writeFile(file, '{}'); await link(file, hardlink)
  await assert.rejects(readBoundedJsonInput(hardlink), { code: 'CLI_INPUT_TYPE' })
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'alias.json'); await symlink(file, alias)
    await assert.rejects(readBoundedJsonInput(alias), { code: 'CLI_INPUT_TYPE' })
  }
})

const commandModule = new URL('../src/commands/runs.mjs', import.meta.url).href
async function actualCli(args, state) {
  const source = `import {createRunsCommand} from ${JSON.stringify(commandModule)};try{await createRunsCommand().parseAsync(${JSON.stringify(args)},{from:'user'});process.stdout.write(JSON.stringify({rejected:false}));}catch(error){process.stdout.write(JSON.stringify({rejected:true,code:error.code,message:error.message}));}`
  const result = await exec(process.execPath, ['--input-type=module', '-e', source], { timeout: 5000, maxBuffer: 65536, env: { ...process.env, KKCODE_HOME: state } })
  return JSON.parse(result.stdout)
}

for (const route of ['contract', 'resume-metadata', 'graph-metadata']) for (const kind of ['oversized', 'invalid-json', 'fifo']) test(`actual ${route} CLI refuses ${kind} without blocking or opening a run`, { skip: kind === 'fifo' && process.platform === 'win32', timeout: 15000 }, async t => {
  const root = await fixture(t), state = path.join(root, 'state'), hosts = path.join(state, 'run-hosts')
  await mkdir(hosts, { recursive: true })
  const file = route === 'contract' ? path.join(root, 'contract.json') : path.join(hosts, 'unstarted.json')
  if (kind === 'fifo') await exec('mkfifo', [file], { timeout: 2000 })
  else if (kind === 'invalid-json') await writeFile(file, `{${canary}`)
  else {
    const handle = await open(file, 'wx')
    try { await handle.truncate(maximum + 1) } finally { await handle.close() }
  }
  const args = route === 'contract' ? ['start', '--contract', file, '--image', `sha256:${'a'.repeat(64)}`, '--cwd', root, '--json']
    : route === 'resume-metadata' ? ['resume', 'unstarted', '--json'] : ['graph', 'execute', 'unstarted', 'unstarted-graph', '--json']
  const result = await actualCli(args, state)
  assert.equal(result.rejected, true, JSON.stringify(result))
  assert.equal(result.message.includes(canary), false)
  assert.match(result.message, /文件|JSON|宿主|资料/)
  await assert.rejects(lstat(path.join(state, 'run-store', 'runs.sqlite')), { code: 'ENOENT' })
})
