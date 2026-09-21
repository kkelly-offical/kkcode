import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tests = ['mcp-official-sdk-acceptance', 'extension-compatibility-acceptance', 'tool-schema-compatibility-acceptance', 'mcp-client-stdio', 'mcp-client-http', 'mcp-client-sse', 'mcp-registry', 'mcp-circuit-breaker', 'skill-registry-compat', 'plugin-manifest-compat']
const child = spawn(process.execPath, ['--test', ...tests.map(name => `test/${name}.test.mjs`)], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' })
child.once('error', error => { console.error(`Compatibility acceptance could not start: ${error.message}`); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
