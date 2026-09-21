import { readFile } from 'node:fs/promises'
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (!/^1\.0\.\d+(?:-rc\.\d+)?$/.test(version)) throw new Error('User release policy requires 1.0.x; an explicit policy change is required for a minor/major bump.')
console.log(`release version policy ok: ${version}`)
