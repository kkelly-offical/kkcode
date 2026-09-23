// Runs only in an explicitly selected disposable acceptance VM. Never packaged.
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'

const [mode, root] = process.argv.slice(2)
if (!path.isAbsolute(root || '') || !path.basename(root).startsWith('kkcode-preview-acceptance-')) throw new Error('Use a dedicated acceptance directory')
const state = path.join(root, 'state'), marker = path.join(root, 'provider.json')
if (mode === 'start') {
  await mkdir(state, { recursive: true, mode: 0o700 }); await mkdir(path.join(root, 'workspace'), { recursive: true })
  const child = spawn(process.execPath, [process.argv[1], 'provider', root], { detached: true, stdio: 'ignore' }); child.unref()
  let ready
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await readFile(marker, 'utf8').then(JSON.parse).catch(() => null)
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!ready) throw new Error('Isolated fixture provider failed to start')
  await writeFile(path.join(state, 'config.json'), JSON.stringify({
    provider: { default: 'ssh-fixture', 'ssh-fixture': { type: 'openai-compatible', base_url: `http://127.0.0.1:${ready.port}/v1`, api_key_env: '', default_model: 'ssh-fixture', stream: false, retry_attempts: 0, context_limit: 32768 } },
    skills: { auto_seed: false }, mcp: { auto_discover: false }, session: { title_generation: false }, agent: { verify_completion: false }, updates: { enabled: false }
  }), { mode: 0o600 })
  console.log(JSON.stringify({ ready: true }))
} else if (mode === 'provider') {
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'ssh-fixture', context_length: 32768 }] })); return }
    let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 2 * 1024 * 1024) { response.writeHead(413); response.end(); return } }
    const input = JSON.parse(raw), text = JSON.stringify(input.messages || [])
    if (text.includes('SSH_DETACH_SLOW')) await new Promise(resolve => setTimeout(resolve, 20000))
    response.end(JSON.stringify({ id: 'isolated-fixture', object: 'chat.completion', model: 'ssh-fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'SSH_BACKGROUND_COMPLETED' }, finish_reason: 'stop' }], usage: { prompt_tokens: 128, completion_tokens: 8 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(marker, JSON.stringify({ pid: process.pid, port: server.address().port }), { mode: 0o600 })
  // Finite lifetime, even if the acceptance driver is interrupted.
  setTimeout(() => { server.closeAllConnections(); server.close() }, 20 * 60000)
} else throw new Error('Use start or provider')
