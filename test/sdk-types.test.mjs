import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { DEVICE_METHODS } from '../src/protocol/index.mjs'

test('typed RPC surface covers every version 1 operation', async () => {
  const types = await readFile(new URL('../src/sdk/client.d.mts', import.meta.url), 'utf8')
  const names = [...types.matchAll(/^  '([^']+)': \{ params:/gm)].map(match => match[1])
  assert.deepEqual(names.sort(), [...DEVICE_METHODS].sort())
})

test('external strict TypeScript consumers receive kernel and RPC types without allowJs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kkcode-sdk-types-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'consumer.mts')
  const sdk = fileURLToPath(new URL('../src/sdk/index.mjs', import.meta.url)).replaceAll('\\', '/')
  await writeFile(source, `import { createKernel, DeviceClient } from ${JSON.stringify(sdk)};
const kernel = await createKernel({ cwd: '.', boot: false });
await kernel.executeTurn({ prompt: 'inspect', signal: new AbortController().signal });
// @ts-expect-error cwd must be a string
await createKernel({ cwd: 42 });
// @ts-expect-error unknown kernel API
kernel.missing();
const client = new DeviceClient({ url: 'http://localhost' });
const sessions = await client.call('sessions.list', {});
sessions[0]?.title?.toUpperCase();
// @ts-expect-error unknown RPC method
await client.call('sessions.misspelled', {});
// @ts-expect-error deletion requires explicit confirmation
await client.call('sessions.delete', { sessionId: 'x' });
await kernel.shutdown();
`)
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
  const result = await promisify(execFile)(process.execPath, [compiler, '--ignoreConfig', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', 'false', source], { timeout: 30000 })
  assert.equal(result.stdout.trim(), '')
})
