import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCounterInteger } from '../evaluation/v4/counter-evidence.mjs'

test('counter measurement uses bounded decimal value semantics, including leading zeroes and newline', () => {
  for (const [text, value] of [['0', 0], ['00\n', 0], ['1', 1], ['1\n', 1], ['01\n', 1], ['000001\r\n', 1],
    [' \t001 \r\n', 1], ['9007199254740991', Number.MAX_SAFE_INTEGER], ['0'.repeat(127) + '1', 1]]) {
    assert.equal(parseCounterInteger(Buffer.from(text)), value, JSON.stringify(text))
  }
})

test('counter measurement rejects invalid syntax, non-ASCII digits, unsafe numbers and oversized input', () => {
  for (const text of ['', ' \r\n', '-1', '-0', '+1', '1.0', '1e0', '0x1', 'NaN', 'Infinity', '1 0', '1\n0',
    '１', '١', '\u00a01', '1\0', '9007199254740992', '0'.repeat(129)]) {
    assert.equal(parseCounterInteger(Buffer.from(text)), null, JSON.stringify(text))
  }
  assert.equal(parseCounterInteger(Buffer.from([0xff])), null)
  assert.equal(parseCounterInteger('01'), null)
  assert.equal(parseCounterInteger(null), null)
})
