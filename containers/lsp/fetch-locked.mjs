// Image-build helper only. Never invoked by the agent runtime or with model URLs.
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const lock = JSON.parse(await readFile(new URL('./downloads.lock.json', import.meta.url), 'utf8'))
const hosts = new Set(['go.dev', 'dl.google.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const destination = '/tmp/kkcode-lsp-locked'
await mkdir(destination, { recursive: true })
for (const name of ['go', 'kotlin']) {
  const spec = lock[name], target = path.join(destination, `${name}.${spec.archive === 'zip' ? 'zip' : 'tar.gz'}`), temporary = `${target}.part`
  let url = new URL(spec.url), response
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || !hosts.has(url.hostname)) throw new Error('Unexpected locked-download origin')
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(180000) })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { await response.body?.cancel(); url = new URL(response.headers.get('location'), url); continue }
    break
  }
  if (!response?.ok) throw new Error(`Pinned ${name} download failed`)
  const file = await open(temporary, 'wx', 0o600), digest = createHash('sha256')
  let count = 0
  try {
    for await (const chunk of response.body) {
      count += chunk.length
      if (count > spec.maxBytes) throw new Error(`Pinned ${name} download exceeds its bound`)
      digest.update(chunk)
      await file.writeFile(chunk)
    }
    if (digest.digest('hex') !== spec.sha256) throw new Error(`Pinned ${name} SHA-256 mismatch`)
    await file.sync(); await file.close(); await rename(temporary, target)
    console.log(`${name} ${spec.version}: verified ${count} bytes`)
  } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error }
}
