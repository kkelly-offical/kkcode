import test from "node:test"
import assert from "node:assert/strict"
import { createStdioFramingDecoder, encodeRpcMessage } from "../src/mcp/stdio-framing.mjs"

test("stdio framing decoder parses content-length frame", () => {
  const decoder = createStdioFramingDecoder({ framing: "content-length" })
  const frame = encodeRpcMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }, "content-length")
  const messages = decoder.push(frame)
  assert.equal(messages.length, 1)
  const parsed = JSON.parse(messages[0])
  assert.equal(parsed.id, 1)
})

test("stdio framing decoder parses newline frame", () => {
  const decoder = createStdioFramingDecoder({ framing: "newline" })
  const frame = encodeRpcMessage({ jsonrpc: "2.0", id: 7, result: {} }, "newline")
  const messages = decoder.push(frame)
  assert.equal(messages.length, 1)
  const parsed = JSON.parse(messages[0])
  assert.equal(parsed.id, 7)
})

test("stdio framing decoder parses split content-length chunks", () => {
  const decoder = createStdioFramingDecoder({ framing: "content-length" })
  const frame = Buffer.from(encodeRpcMessage({ jsonrpc: "2.0", id: 9, result: { ok: true } }, "content-length"))
  const partA = frame.subarray(0, 10)
  const partB = frame.subarray(10)
  const first = decoder.push(partA)
  assert.equal(first.length, 0)
  const second = decoder.push(partB)
  assert.equal(second.length, 1)
  const parsed = JSON.parse(second[0])
  assert.equal(parsed.id, 9)
})

test("stdio framing decoder auto mode accepts both content-length and newline", () => {
  const decoder = createStdioFramingDecoder({ framing: "auto" })
  const a = encodeRpcMessage({ jsonrpc: "2.0", id: 11, result: {} }, "content-length")
  const b = encodeRpcMessage({ jsonrpc: "2.0", id: 12, result: {} }, "newline")
  const first = decoder.push(a)
  const second = decoder.push(b)
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.equal(JSON.parse(first[0]).id, 11)
  assert.equal(JSON.parse(second[0]).id, 12)
})
