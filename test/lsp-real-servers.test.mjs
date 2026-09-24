import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createLanguageService } from '../src/kernel/lsp/service.mjs'
import { createIsolatedLanguageServerConfigs } from '../src/kernel/lsp/image-preset.mjs'

const image = process.env.KK_LSP_REAL_IMAGE
const cases = [
  { language: 'typescript', file: 'sample.ts', symbol: 'fixtureSymbol', source: 'export function fixtureSymbol(): number { return "not-a-number" }\n', error: /string.*number|number.*string/i },
  { language: 'javascript', file: 'sample.js', symbol: 'fixtureSymbol', source: '// @ts-check\n/** @returns {number} */\nexport function fixtureSymbol() { return "not-a-number" }\n', error: /string.*number|number.*string/i },
  { language: 'python', file: 'sample.py', symbol: 'fixture_symbol', source: 'def fixture_symbol() -> int:\n    return "not-a-number"\n', error: /str|int|return/i },
  { language: 'go', file: 'sample.go', symbol: 'FixtureSymbol', source: 'package fixture\nfunc FixtureSymbol() int { return "not-a-number" }\n', error: /string.*int|int.*string/i },
  { language: 'kotlin', file: 'sample.kt', symbol: 'fixtureSymbol', source: 'fun fixtureSymbol(): Int = "not-a-number"\n', error: /mismatch|String.*Int|Int.*String/i }
]
for (const fixture of cases) test(`real pinned ${fixture.language} server supplies diagnostics and symbols through strict read-only LSP`, { timeout: 180000 }, async t => {
  if (!image) { if (process.env.KKCODE_REQUIRE_REAL_LSP === '1') assert.fail('Build the locked LSP image and set KK_LSP_REAL_IMAGE to its immutable ID'); t.skip('Explicit locked language-server image not supplied'); return }
  const cwd = await mkdtemp(path.join(os.tmpdir(), `kk-lsp-real-${fixture.language}-`))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(path.join(cwd, fixture.file), fixture.source)
  if (['typescript', 'javascript'].includes(fixture.language)) await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true }, include: ['*.ts', '*.js'] }))
  if (fixture.language === 'python') await writeFile(path.join(cwd, 'pyrightconfig.json'), JSON.stringify({ typeCheckingMode: 'strict', pythonVersion: '3.11', include: ['sample.py'] }))
  if (fixture.language === 'go') await writeFile(path.join(cwd, 'go.mod'), 'module example.invalid/kkfixture\n\ngo 1.26.0\n')
  const servers = createIsolatedLanguageServerConfigs([fixture.language])
  const service = await createLanguageService({ cwd, servers, image, mode: 'strict', timeoutMs: 75000, authorizeStart: async () => true })
  t.after(() => service.close())
  const diagnostics = await service.inspect({ operation: 'diagnostics', path: fixture.file })
  assert.equal(diagnostics.isolation.strict, true)
  assert.equal(diagnostics.isolation.network, 'none')
  assert.ok(['push_snapshot', 'pull_full', 'typescript_sync'].includes(diagnostics.diagnosticMode))
  assert.ok(diagnostics.items.some(item => fixture.error.test(item.message)), `${fixture.language} must report the deliberate type error, not silently treat missing analysis as clean: ${JSON.stringify(diagnostics.items)}`)
  const symbols = await service.inspect({ operation: 'symbols', path: fixture.file })
  assert.equal(symbols.isolation.strict, true)
  assert.ok(symbols.items.some(item => item.name.includes(fixture.symbol)), `${fixture.language} must identify the actual declaration`)
  t.diagnostic(JSON.stringify({ language: fixture.language, diagnosticMode: diagnostics.diagnosticMode, diagnostics: diagnostics.items.length, symbols: symbols.items.length, sourceHash: diagnostics.sourceHash, image }))
})
