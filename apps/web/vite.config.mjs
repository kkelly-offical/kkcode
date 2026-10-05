import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const displayRelease = JSON.parse(readFileSync(new URL('./display-release.json', import.meta.url), 'utf8'))
const displayVersion = version === displayRelease.baseVersion ? `${version}-${displayRelease.revision}` : ''
export default defineConfig({
  define: { __KKCODE_VERSION__: JSON.stringify(version), __KKCODE_WEB_DISPLAY__: JSON.stringify(displayVersion) },
  plugins: [{ name: 'web-display-release', generateBundle() {
    if (displayVersion) this.emitFile({ type: 'asset', fileName: 'display-patch.json', source: JSON.stringify({ baseVersion: version, displayVersion, scope: 'web-only' }, null, 2) + '\n' })
  } }],
  build: { outDir: '../../src/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:18271', '/auth': 'http://127.0.0.1:18271' } }
})
