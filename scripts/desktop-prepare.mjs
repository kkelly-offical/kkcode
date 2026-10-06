import { mkdir, readFile, writeFile, cp, rm, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReleaseVersions } from './check-release-version.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = JSON.parse(await readFile(new URL('../configs/desktop-release.json', import.meta.url), 'utf8'))
await checkReleaseVersions(root)
if (process.platform !== 'win32') throw new Error('Prepare the Windows installation artifact on the Windows build runner.')
const output = path.join(root, 'test-results', 'desktop-resources')
const stage = path.join(root, 'test-results', `desktop-stage-${Date.now()}`)
await mkdir(stage, { recursive: true })
const run = (program, args, cwd = root) => {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 12 * 1024 * 1024, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.stderr || result.error?.message || result.stdout}`)
  return result.stdout
}
const archive = `node-v${target.nodeVersion}-win-x64.zip`
const origin = `https://nodejs.org/dist/v${target.nodeVersion}`
const checksumsResponse = await fetch(`${origin}/SHASUMS256.txt`)
if (!checksumsResponse.ok) throw new Error('Node checksum download failed')
const sums = await checksumsResponse.text()
const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === archive)?.[0]
if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Pinned Node archive is missing from official checksums')
const response = await fetch(`${origin}/${archive}`)
if (!response.ok) throw new Error('Node runtime download failed')
const bytes = Buffer.from(await response.arrayBuffer()), digest = createHash('sha256').update(bytes).digest('hex')
if (digest !== expected) throw new Error('Node runtime checksum mismatch')
await writeFile(path.join(stage, archive), bytes)
// A small PowerShell file keeps paths out of shell interpolation.
await writeFile(path.join(stage, 'extract.ps1'), 'param([string]$Source,[string]$Destination)\nExpand-Archive -LiteralPath $Source -DestinationPath $Destination\n')
run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(stage, 'extract.ps1'), '-Source', path.join(stage, archive), '-Destination', stage])
await rename(path.join(stage, `node-v${target.nodeVersion}-win-x64`), path.join(stage, 'node'))
const rgArchive = `ripgrep-${target.ripgrepVersion}-x86_64-pc-windows-msvc.zip`
const rgResponse = await fetch(`https://github.com/BurntSushi/ripgrep/releases/download/${target.ripgrepVersion}/${rgArchive}`)
if (!rgResponse.ok) throw new Error('Search runtime download failed')
const rgBytes = Buffer.from(await rgResponse.arrayBuffer()), rgDigest = createHash('sha256').update(rgBytes).digest('hex')
if (rgDigest !== target.ripgrepArchiveSha256) throw new Error('Search runtime checksum mismatch')
await writeFile(path.join(stage, rgArchive), rgBytes)
run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(stage, 'extract.ps1'), '-Source', path.join(stage, rgArchive), '-Destination', stage])
await rename(path.join(stage, rgArchive.replace(/\.zip$/, '')), path.join(stage, 'search'))
await rm(path.join(stage, rgArchive))
await mkdir(path.join(stage, 'agent'), { recursive: true })
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', stage]))[0]
await writeFile(path.join(stage, 'agent', 'package.json'), JSON.stringify({ name: 'kkcode-desktop-runtime', version: '1.0.0', private: true }))
run(process.execPath, [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(stage, packed.filename)], path.join(stage, 'agent'))
const runtimeAudit = run(process.execPath, [npmCli, 'audit', '--omit=dev', '--audit-level=high', '--json', '--registry=https://registry.npmjs.org'], path.join(stage, 'agent'))
await writeFile(path.join(stage, 'dependency-audit.json'), runtimeAudit)
await cp(path.join(root, 'apps', 'desktop', 'backend.mjs'), path.join(stage, 'backend.mjs'))
await writeFile(path.join(stage, 'runtime-verification.json'), JSON.stringify({ nodeVersion: target.nodeVersion, nodeArchiveSha256: digest, ripgrepVersion: target.ripgrepVersion, ripgrepArchiveSha256: rgDigest, packageVersion: packed.version, packageIntegrity: packed.integrity, dependenciesLockSha256: createHash('sha256').update(await readFile(path.join(stage, 'agent', 'package-lock.json'))).digest('hex'), productionAudit: JSON.parse(runtimeAudit).metadata.vulnerabilities }, null, 2) + '\n')
await rm(path.join(stage, archive)); await rm(path.join(stage, 'extract.ps1')); await rm(path.join(stage, packed.filename))
await rm(output, { recursive: true, force: true }); await rename(stage, output)
console.log(`Prepared Windows runtime: Node ${target.nodeVersion}, KK Code ${packed.version}`)
