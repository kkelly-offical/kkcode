import { parentPort, workerData } from 'node:worker_threads'
import { createReadStream } from 'node:fs'
import { Parser } from 'tar'

const privateNames = new Set(['.git', '.kkcode', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker', '.npmrc', '.pypirc', '.netrc', '.envrc', '.mcp.json', 'id_rsa', 'id_ed25519', 'credentials'])
const sensitive = part => privateNames.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part)

try {
  const result = await new Promise((resolve, reject) => {
    let entries = 0, bytes = 0, manifest = null, stopped = false
    const seen = new Set(), input = createReadStream(workerData.file)
    const parser = new Parser({ strict: true, maxMetaEntrySize: 65536, maxDecompressionRatio: 200 })
    const stop = () => { if (!stopped) { stopped = true; input.destroy(); parser.abort(new Error('Unsafe package archive')); reject(new Error('Unsafe package archive')) } }
    input.on('error', stop); parser.on('error', stop)
    parser.on('entry', entry => {
      const name = entry.path.replace(/\/$/, '')
      if (++entries > 20000 || !name.startsWith('package/') && name !== 'package' || /[\\\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..' || part === 'node_modules' || sensitive(part)) || seen.has(name) || !['File', 'Directory', 'OldFile'].includes(entry.type) || entry.mode & 0o6000 || !Number.isSafeInteger(entry.size) || entry.size < 0 || (bytes += entry.size) > workerData.maxBytes) { stop(); return }
      seen.add(name)
      if (name !== 'package/package.json') { entry.resume(); return }
      if (entry.size > 262144 || manifest !== null) { stop(); return }
      const chunks = []
      entry.on('data', chunk => chunks.push(chunk))
      entry.on('end', () => { try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { stop() } })
    })
    parser.on('end', () => { if (!stopped) manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? resolve({ manifest, entries, bytes, hasBindingGyp: seen.has('package/binding.gyp') }) : stop() })
    input.pipe(parser)
  })
  parentPort.postMessage({ ok: true, ...result })
} catch { parentPort.postMessage({ ok: false }) }
