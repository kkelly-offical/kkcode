import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
export default defineConfig({
  define: { __KKCODE_VERSION__: JSON.stringify(version) },
  build: { outDir: '../../src/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:18271', '/auth': 'http://127.0.0.1:18271' } }
})
