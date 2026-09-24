import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { PACKAGE_VERSION } from "../src/version.mjs"
import { scanDirectoryTree } from "./secret-scan.mjs"
import { verificationCommand } from './verification-command.mjs'

function run(command, args, cwd, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = ""
    const invocation = verificationCommand(command, args)
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: invocation.shell,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
    })
    if (capture) child.stdout.on("data", (chunk) => { stdout += chunk })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`))
    })
  })
}

const root = process.cwd()
const scratch = await mkdtemp(path.join(tmpdir(), "kkcode-package-smoke-"))
try {
  const packJson = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
    root,
    { capture: true }
  )
  const packed = JSON.parse(packJson)
  const tarball = path.join(scratch, packed[0].filename)
  await run("npm", ["init", "-y"], scratch)
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], scratch)
  const packageRoot = path.join(scratch, "node_modules", "@kkelly-offical", "kkcode")
  const payloadScan = scanDirectoryTree(packageRoot)
  if (payloadScan.findings.length > 0) {
    throw new Error(`packed payload secret scan failed:\n${payloadScan.findings.join("\n")}`)
  }
  console.log(`packed payload secret scan ok: ${payloadScan.scanned} files`)

  const entry = path.join(packageRoot, "src", "index.mjs")
  const version = await run(process.execPath, [entry, "--version"], scratch, { capture: true })
  if (version !== PACKAGE_VERSION) {
    throw new Error(`package smoke version mismatch: expected ${PACKAGE_VERSION}, got ${version}`)
  }
  console.log(`package smoke ok: ${version}`)
  // The advertised npm gateway script and deployment guidance must survive packing.
  await run(process.execPath, ['--check', path.join(packageRoot, 'apps', 'gateway', 'main.mjs')], scratch)
  await readFile(path.join(packageRoot, 'docs', 'enterprise-deployment.md'), 'utf8')
  await run(process.execPath, ["--input-type=module", "-e", "const sdk = await import('@kkelly-offical/kkcode/sdk'); const client = await import('@kkelly-offical/kkcode/sdk/client'); const protocol = await import('@kkelly-offical/kkcode/protocol'); if (typeof sdk.createKernel !== 'function' || sdk.DeviceClient !== client.DeviceClient || protocol.PROTOCOL_VERSION !== '1') throw new Error('Invalid installed SDK exports'); console.log('installed kernel SDK, browser client and protocol exports ok')"], scratch)
  await readFile(path.join(packageRoot, 'docs', 'sdk-storage.md'), 'utf8')
  await readFile(path.join(packageRoot, 'docs', 'data-policy.md'), 'utf8')
  await readFile(path.join(packageRoot, 'containers', 'office', 'Dockerfile'), 'utf8')
  await readFile(path.join(packageRoot, 'containers', 'office', 'requirements.lock'), 'utf8')
  await run(process.execPath, ['--input-type=module', '-e', `
    const expected = {runs:'createRunCoordinator', memory:'createMemoryController', models:'resolveTaskModel', tasks:'createTaskGraphHost',
      browser:'createBrowserController', office:'createOfficeService', lsp:'createLanguageService', forge:'createForgeClient', artifacts:'downloadArtifact', diagnostics:'diagnoseRun', environments:'inspectNpmEnvironment', 'browser-recipes':'createBrowserRecipeStore'};
    for (const [domain, symbol] of Object.entries(expected)) {
      const module = await import('@kkelly-offical/kkcode/sdk/'+domain);
      if(typeof module[symbol] !== 'function') throw new Error('Installed SDK domain missing: '+domain+'/'+symbol);
    }
    console.log('installed domain SDK exports ok');
  `], scratch)
  await run(process.execPath, ['--input-type=module', '-e', `
    import { openRunStore, createArtifactStore } from '@kkelly-offical/kkcode/sdk/storage';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    const root = await mkdtemp(path.join(tmpdir(), 'kkcode-installed-storage-'));
    let store;
    try {
      store = await openRunStore({directory:path.join(root,'runs')});
      const record = await store.createRun({id:'package-smoke',ownerId:'smoke',contract:{objective:'package persistence fixture',requiredCriteria:[]}});
      if ((await store.getRun(record.id)).id !== record.id) throw new Error('Installed RunStore failed');
      const artifacts = createArtifactStore({root:path.join(root,'artifacts')});
      const actor = {accountId:'smoke',projectId:'smoke',sessionId:'smoke',runId:record.id};
      const artifact = await artifacts.put({actor,content:'installed storage fixture'});
      const page = await artifacts.read({actor,id:artifact.id});
      if (Buffer.from(page.data,'base64').toString('utf8') !== 'installed storage fixture') throw new Error('Installed artifact read failed');
      console.log('installed persistence SDK and SQLite worker roundtrip ok');
    } finally { await store?.close(); await rm(root,{recursive:true,force:true}); }
  `], scratch)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
