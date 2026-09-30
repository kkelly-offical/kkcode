import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Keep fixture programs separate from their data, with private files per launch.
// Only a generated ASCII basename enters the command; JavaScript source, cwd
// and test values never need shell quoting. Programs read data using __dirname
// while their process cwd (and the file operations being tested) stay unchanged.
// Like the tested `node --check` commands, this uses the test runner's Node PATH.
export async function nodeFixtureCommand(cwd, source, data = {}) {
  const directory = await mkdtemp(path.join(cwd, 'kkcode-process-fixture-'))
  const basename = path.basename(directory)
  if (!/^kkcode-process-fixture-[A-Za-z0-9]+$/.test(basename)) throw new Error('Unexpected fixture directory name')
  await writeFile(path.join(directory, 'data.json'), JSON.stringify(data), { flag: 'wx' })
  await writeFile(path.join(directory, 'process.cjs'), source, { flag: 'wx' })
  return `node ./${basename}/process.cjs`
}
