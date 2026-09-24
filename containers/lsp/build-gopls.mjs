import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
const run = promisify(execFile)
const lock = JSON.parse(await readFile(new URL('./downloads.lock.json', import.meta.url), 'utf8'))
await mkdir('/opt/kkcode-lsp/bin', { recursive: true })
const env = { PATH: '/opt/go/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/build-home', GOPATH: '/tmp/build-go', GOCACHE: '/tmp/build-go-cache',
  GOBIN: '/opt/kkcode-lsp/bin', GOROOT: '/opt/go', GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOTELEMETRY: 'off',
  GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org' }
const module = `${lock.gopls.module}@${lock.gopls.version}`
const info = JSON.parse((await run('/opt/go/bin/go', ['mod', 'download', '-json', module], { env, maxBuffer: 2 * 1024 * 1024 })).stdout)
if (info.Sum !== lock.gopls.sum || info.GoModSum !== lock.gopls.goModSum) throw new Error('Pinned gopls module checksum mismatch')
await run('/opt/go/bin/go', ['install', '-trimpath', module], { env, timeout: 240000, maxBuffer: 4 * 1024 * 1024 })
const manifest = (await run('/opt/go/bin/go', ['version', '-m', '/opt/kkcode-lsp/bin/gopls'], { env })).stdout
if (!manifest.includes(lock.gopls.sum)) throw new Error('Built gopls module provenance missing')
await writeFile('/opt/kkcode-lsp/gopls.modules.lock', manifest)
console.log(`gopls ${lock.gopls.version}: sumdb-verified source and module graph`)
