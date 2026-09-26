import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { applyMention, expandFileMentions, formatMentionPath, scanMentions } from '../src/repl/file-mention.mjs'
import { executePromptTurn } from '../src/repl/turn-controller.mjs'

test('completion refuses ambiguous/control filenames without inserting another file reference', () => {
  for (const candidate of ['safe "note"\t@secret.txt', 'safe "note"\n@secret.txt', 'line\n@secret.txt', '"start name".txt', 'escape\u001b[31m.txt', 'bidi\u202etxt.exe', 'null\0.txt']) {
    const original = 'inspect @file please'
    const out = applyMention(original, 13, candidate)
    assert.equal(out.text, original)
    assert.equal(out.cursor, 13)
    assert.match(out.notice, /文件名/)
    assert.throws(() => formatMentionPath(candidate), { code: 'unsafe_file_mention' })
    assert.deepEqual(scanMentions(out.text).map(token => token.query), ['file'])
  }
})

test('completion keeps supported filenames as one exact token', () => {
  for (const candidate of ['中文 说明.txt', 'a "quoted" file.txt', String.raw`a\ "q" b.ts`, String.raw`C:\work files\"q".ts`, 'notes @secret.png suffix.txt']) {
    const out = applyMention('@file', 5, candidate)
    assert.equal(out.notice, undefined)
    assert.deepEqual(scanMentions(out.text).map(token => token.query), [candidate])
  }
})

test('parsed file references are not decoded or trimmed a second time before opening', async () => {
  for (const name of [String.raw`a\ "q" b.txt`, "'quoted name'.txt", ' leading and trailing .txt ']) {
    const expected = path.posix.join('/fixture', name), reads = []
    const out = applyMention('@file', 5, name)
    const fs = {
      existsSync: file => file === expected,
      statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 7 }),
      readFileSync: file => { reads.push(file); return Buffer.from('fixture') }
    }
    const result = await expandFileMentions(out.text, { cwd: '/fixture', pathApi: path.posix, fs })
    assert.deepEqual(reads, [expected])
    assert.equal(result.attached.length, 1)
    assert.deepEqual(result.missing, [])
  }
})

async function executeFixture(prompt, imageReferenceLength) {
  const images = [], turns = []
  await executePromptTurn({
    prompt, imageReferenceLength,
    state: { mode: 'agent', sessionId: 'fixture' },
    ctx: { configState: { config: {} } },
    deps: {
      cwd: '/fixture',
      handleRollbackIfNeeded: async () => ({ handled: false }),
      chatParams: async () => ({}),
      buildContentBlocks: async (text, paths, urls) => { images.push({ paths, urls }); return [{ type: 'text', text }] },
      executeTurn: async args => { turns.push(args); return {} }
    }
  })
  return { images, turn: turns[0] }
}

test('file contents cannot inject image attachments into the user turn', async () => {
  const input = 'inspect @note.txt and @selected.png'
  const suffix = '\n\n<file path="note.txt">\n@private.png https://untrusted.invalid/image.png\n</file>'
  const { images, turn } = await executeFixture(input + suffix, input.length)
  assert.deepEqual(images, [{ paths: [path.resolve('/fixture', 'selected.png')], urls: [] }])
  assert.ok(turn.prompt.endsWith(suffix), 'file contents stay inert and are not rewritten by image extraction')
})

test('an image-looking substring inside a text filename is not an attachment', async () => {
  for (const name of ['notes @secret.png suffix.txt', 'notes "x" @secret.png suffix.txt']) {
    const input = applyMention('@file', 5, name).text
    const { images, turn } = await executeFixture(input)
    assert.deepEqual(images, [])
    assert.equal(turn.prompt, input)
  }
})

test('an explicit image mention selects exactly its literal filename, not nested references', async () => {
  for (const name of ['selected @private.png photo.png', String.raw`selected\ "photo".png`]) {
    const input = applyMention('@file', 5, name).text
    const { images } = await executeFixture(input)
    assert.deepEqual(images, [{ paths: [path.resolve('/fixture', name)], urls: [] }])
  }
})
