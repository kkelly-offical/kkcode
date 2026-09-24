import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const actual = await readFile(new URL('./result.txt', import.meta.url), 'utf8')
assert.equal(actual, 'KK Code governed GitHub delivery acceptance\n')
console.log('Original frozen fixture assertion passed.')
