import { readFile, writeFile, readdir, mkdir, mkdtemp, copyFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = process.argv[2] && path.resolve(process.argv[2])
if (!output) throw new Error('Usage: node scripts/build-web-display-patch.mjs /private/output-directory')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
if (git('status', '--porcelain')) throw new Error('Commit the tested display source before building the release artifact')
const display = JSON.parse(await readFile(path.join(root, 'src/web/display-patch.json'), 'utf8'))
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (display.baseVersion !== packageInfo.version || display.scope !== 'web-only' || !/^1\.0\.\d+-display\.\d+$/.test(display.displayVersion)) throw new Error('Unexpected display release identity')
await mkdir(output, { recursive: true, mode: 0o700 })
const stage = await mkdtemp(path.join(output, 'payload-'))
const digest = data => createHash('sha256').update(data).digest('hex')
const row = (name, data) => ({ path: name, size: data.length, sha256: digest(data) })
async function collect(directory, prefix = '') {
  const rows = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Web payload cannot contain symlinks')
    if (entry.isDirectory()) rows.push(...await collect(path.join(directory, entry.name), prefix + entry.name + '/'))
    else if (entry.isFile()) {
      const name = prefix + entry.name, data = await readFile(path.join(directory, entry.name)); rows.push(row(name, data))
      const dest = path.join(stage, 'src/web', name); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, data)
    } else throw new Error('Unsupported Web payload entry')
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}
const files = await collect(path.join(root, 'src/web'))
const baseTag = `v${display.baseVersion}`, basePaths = git('ls-tree', '-r', '--name-only', baseTag, '--', 'src/web').split('\n')
const baseFiles = basePaths.map(name => row(name.slice('src/web/'.length), execFileSync('git', ['show', `${baseTag}:${name}`], { cwd: root })))
const manifest = { schema: 1, kind: 'kkcode-web-display', ...display, source: { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), baseTag }, files, baseFiles }
await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
for (const [from, to] of [['deploy/apply-web-display-patch.mjs', 'apply.mjs'], ['docs/web-display-install.md', 'README.md'], ['LICENSE', 'LICENSE'], ['NOTICE.md', 'NOTICE.md']]) await copyFile(path.join(root, from), path.join(stage, to))
const filename = `kkcode-web-${display.displayVersion}.tar.gz`, artifact = path.join(output, filename)
if (await lstat(artifact).catch(error => { if (error.code === 'ENOENT') return null; throw error })) throw new Error('Refusing to overwrite a display artifact')
await tar.c({ gzip: true, portable: true, mtime: new Date(0), cwd: stage, file: artifact }, ['src', 'manifest.json', 'apply.mjs', 'README.md', 'LICENSE', 'NOTICE.md'])
const sha256 = digest(await readFile(artifact))
await writeFile(path.join(output, `${filename}.sha256`), `${sha256}  ${filename}\n`, { flag: 'wx' })
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ artifact, sha256, files: files.length, source: manifest.source, stage }))
