// Immutable image adapter. The host approves this exact launcher + language;
// there is no package installation, arbitrary argv or host environment input.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const language = process.argv[2]
const env = { PATH: '/opt/go/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/lsp-home', TMPDIR: '/tmp', LANG: 'C.UTF-8', CI: '1',
  GOROOT: '/opt/go', GOPATH: '/tmp/gopath', GOCACHE: '/tmp/gocache', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOTELEMETRY: 'off', GOFLAGS: '-mod=readonly',
  PYTHONNOUSERSITE: '1', PYTHONPATH: '' }
let command, args
if (['typescript', 'javascript'].includes(language)) {
  command = process.execPath; args = ['/opt/kkcode-lsp/node_modules/typescript-language-server/lib/cli.mjs', '--stdio', '--log-level', '1']
} else if (language === 'python') {
  command = process.execPath; args = ['/opt/kkcode-lsp/node_modules/pyright/langserver.index.js', '--stdio']
} else if (language === 'go') {
  command = '/opt/kkcode-lsp/bin/gopls'; args = ['serve']
} else if (language === 'kotlin') {
  command = ['/opt/kotlin/server/bin/kotlin-language-server', '/opt/kotlin/bin/kotlin-language-server'].find(existsSync)
  if (!command) throw new Error('Pinned Kotlin launcher was not found')
  args = []
  env.JAVA_HOME = '/usr/lib/jvm/java-17-openjdk-amd64'
  env.JAVA_TOOL_OPTIONS = '-Duser.home=/tmp/lsp-home -Djava.io.tmpdir=/tmp -Djava.awt.headless=true -Xmx768m'
} else throw new Error('Unsupported approved language')
const child = spawn(command, args, { env, shell: false, stdio: 'inherit' })
child.on('error', () => { process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
