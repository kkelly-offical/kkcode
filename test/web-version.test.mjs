import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import config from '../apps/web/vite.config.mjs'

test('Web build injects the exact root release version, including prerelease labels', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(config.define.__KKCODE_VERSION__, JSON.stringify(manifest.version))
  const source = await readFile(new URL('../apps/web/src/version.ts', import.meta.url), 'utf8')
  assert.match(source, /export const APP_VERSION\s*=\s*__KKCODE_VERSION__/)
  assert.doesNotMatch(source, /\b(?:import|require)\s*(?:\(|.*?from)/)
})

test('all Web version labels use the injected constant rather than hard-coded releases', async () => {
  for (const name of ['Composer', 'Home', 'Settings']) {
    const source = await readFile(new URL(`../apps/web/src/${name}.tsx`, import.meta.url), 'utf8')
    assert.match(source, /import\s*\{\s*APP_VERSION\s*\}\s*from\s*["']\.\/version["']/)
    assert.match(source, /KK Code\s*\{APP_VERSION\}/)
    assert.doesNotMatch(source, /KK Code\s+v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/, `${name} must not drift from the package version`)
  }
})
