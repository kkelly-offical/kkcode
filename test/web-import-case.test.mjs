import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Match Vite's source extension candidates after case-folding as on common
// Windows/macOS filesystems. A Linux build alone cannot catch these collisions.
const extensions = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']
const candidates = (files, target) => {
  const names = new Set(extensions.flatMap(extension => [target + extension, path.join(target, 'index' + extension)]).map(file => path.normalize(file).toLowerCase()))
  return files.filter(file => names.has(path.normalize(file).toLowerCase()))
}
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : entry.isFile() ? [file] : []
  }))).flat()
}

test('case-folded resolver detects the historical Transcript.tsx/transcript.mjs collision', () => {
  const directory = path.resolve('ui-fixture')
  assert.equal(candidates([path.join(directory, 'Transcript.tsx'), path.join(directory, 'transcript.mjs')], path.join(directory, 'Transcript')).length, 2)
  assert.deepEqual(candidates([path.join(directory, 'TranscriptView.tsx'), path.join(directory, 'transcript.mjs')], path.join(directory, 'TranscriptView')), [path.join(directory, 'TranscriptView.tsx')])
})

test('Web extensionless relative imports have exactly one case-insensitive resolution', async () => {
  const directory = fileURLToPath(new URL('../apps/web/src/', import.meta.url))
  const files = await sourceFiles(directory)
  let checked = 0
  for (const file of files.filter(file => extensions.includes(path.extname(file)))) {
    const text = await readFile(file, 'utf8')
    for (const [, specifier] of text.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["'](\.{1,2}\/[^"'?#]+)["']/g)) {
      if (path.extname(specifier)) continue
      const target = path.resolve(path.dirname(file), specifier)
      const matches = candidates(files, target)
      assert.equal(matches.length, 1, `${path.relative(directory, file)}: ${specifier} must resolve uniquely after case-folding; found ${matches.map(match => path.relative(directory, match)).join(', ') || 'none'}`)
      assert.ok(extensions.some(extension => matches[0] === target + extension || matches[0] === path.join(target, 'index' + extension)), `${specifier} must use the exact on-disk path casing`)
      checked++
    }
  }
  assert.ok(checked > 0, 'The regression must inspect actual Web imports')
})
