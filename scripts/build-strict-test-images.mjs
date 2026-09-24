import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, readFile, rm, utimes } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// Explicit CI/operator action only. Never imported by the agent runtime.
const root = fileURLToPath(new URL('../', import.meta.url))
const base = 'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3'
const platform = 'linux/amd64'
const fixture = path.join(root, 'test', 'fixtures', 'fake-lsp-server.mjs')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kkcode-test-images-'))
const context = path.join(temporary, 'context'), dockerConfig = path.join(temporary, 'docker-config')
await mkdir(context); await mkdir(dockerConfig, { mode: 0o700 })
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG'].includes(key)))
/** @returns {Promise<string>} */
function docker(args, { capture = false, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['--config', dockerConfig, ...args], { cwd: context, env: environment, shell: false,
      windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 2, 'inherit'] })
    let output = '', failed = false
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('Test image build timed out; inspect local Docker before retrying.')) }, timeoutMs)
    child.stdout?.on('data', chunk => { output += chunk.toString(); if (output.length > 1024 * 1024) { failed = true; child.kill(); reject(new Error('Unexpectedly large Docker inspection response.')) } })
    child.once('error', error => { clearTimeout(timer); failed = true; reject(error) })
    child.once('close', code => { clearTimeout(timer); if (!failed) code === 0 ? resolve(output) : reject(new Error(`Docker test image command failed (${code}).`)) })
  })
}

try {
  const dockerfile = path.join(root, 'containers', 'strict-test', 'Dockerfile')
  const source = await readFile(dockerfile, 'utf8')
  if (!source.includes(`FROM ${base} AS strict-test`)) throw new Error('The reviewed test base digest and build receipt disagree.')
  await copyFile(dockerfile, path.join(context, 'Dockerfile'))
  await copyFile(fixture, path.join(context, 'fake-lsp-server.mjs'))
  await utimes(path.join(context, 'fake-lsp-server.mjs'), 0, 0)
  const fixtureSha256 = createHash('sha256').update(await readFile(path.join(context, 'fake-lsp-server.mjs'))).digest('hex')
  const images = {}
  for (const [target, kind] of [['strict-test', 'strict-v1'], ['lsp-fixture', 'lsp-fixture-v1']]) {
    const iid = path.join(temporary, `${target}.iid`)
    // Only these two public fixture files enter the build context. No .git,
    // npmrc, KKCODE_HOME, Docker login state or workspace files are sent.
    await docker(['build', '--platform', platform, '--network', 'none', '--pull=false', '--target', target, '--iidfile', iid, context])
    const imageId = (await readFile(iid, 'utf8')).trim()
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Docker did not return an immutable image ID.')
    const inspected = JSON.parse(await docker(['image', 'inspect', imageId], { capture: true }))
    const image = inspected[0]
    if (image.Id !== imageId || image.Os !== 'linux' || image.Architecture !== 'amd64' || image.Config?.Labels?.['io.kkcode.test-image'] !== kind ||
        image.Config?.Labels?.['io.kkcode.base-digest'] !== base.split('@')[1] || image.Config?.Labels?.['io.kkcode.test-only'] !== 'true') throw new Error('Built image identity or test-only labels are not the expected pinned fixture.')
    images[target] = imageId
  }
  // stdout is one machine-readable receipt; Docker progress goes to stderr.
  process.stdout.write(JSON.stringify({ schema: 'kk.test-images.v1', base, platform,
    fixtureSha256,
    environment: { KKCODE_STRICT_TEST_IMAGE: images['strict-test'], KK_LSP_TEST_IMAGE: images['lsp-fixture'] } }) + '\n')
} finally {
  // Only our explicit mkdtemp workspace is removed; built images remain for CI.
  await rm(temporary, { recursive: true, force: true })
}
