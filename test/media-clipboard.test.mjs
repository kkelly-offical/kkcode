import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { readClipboardMedia, readMediaFileAsBlock } from '../src/kernel/tool/media-util.mjs'
import { MAX_MEDIA_BYTES } from '../src/kernel/core/media.mjs'
import { wavBytes, mp3Bytes, mp4Bytes } from './helpers/media-fixtures.mjs'

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kkcode-media-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('copied local media is sniffed from bytes, never trusted by extension', async t => {
  const dir = await fixture(t)
  for (const [name, bytes, type] of [['audio.bin', wavBytes, 'audio'], ['mp3.bin', mp3Bytes, 'audio'], ['video.wav', mp4Bytes, 'video']]) {
    const file = path.join(dir, name); await writeFile(file, bytes)
    const block = await readMediaFileAsBlock(file)
    assert.equal(block.type, type)
    assert.deepEqual(Buffer.from(block.data, 'base64'), bytes)
    assert.equal(block.bytes, bytes.length)
  }
  const fake = path.join(dir, 'secret.mp4'); await writeFile(fake, 'not media')
  assert.equal((await readMediaFileAsBlock(fake)).type, 'error')
  assert.equal((await readMediaFileAsBlock('https://example.test/media.mp4')).type, 'error')
  assert.equal((await readMediaFileAsBlock('\\\\host\\share\\media.mp4')).type, 'error')
})

test('media reads reject folders, missing files, oversize data and unsupported formats without path leaks', async t => {
  const dir = await fixture(t), folder = path.join(dir, 'folder')
  await mkdir(folder)
  const big = path.join(dir, 'big.wav'), handle = await open(big, 'w')
  await handle.truncate(MAX_MEDIA_BYTES + 1); await handle.close()
  const unsupported = path.join(dir, 'audio.m4a')
  await writeFile(unsupported, Buffer.from('00000018667479704d3441200000020069736f6d69736f32', 'hex'))
  for (const file of [folder, big, unsupported, path.join(dir, 'missing')]) {
    const result = await readMediaFileAsBlock(file)
    assert.equal(result.type, 'error')
    assert.ok(!result.message.includes(dir))
  }
})

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} native copied file reference becomes an audio attachment`, async t => {
    const dir = await fixture(t), file = path.join(dir, 'space 文件.wav')
    await writeFile(file, wavBytes)
    const statuses = [], calls = []
    const executeFile = async (command, args) => {
      calls.push({ command, args })
      if (platform === 'win32') return { stdout: JSON.stringify([file]) }
      if (platform === 'darwin') return { stdout: file }
      return { stdout: args.includes('--list-types') ? 'text/plain\ntext/uri-list\n' : Buffer.from(`${pathToFileURL(file)}\r\n`) }
    }
    const result = await readClipboardMedia({ platform, executeFile, onStatus: text => statuses.push(text) })
    assert.equal(result.type, 'audio')
    assert.equal(result.mediaType, 'audio/wav')
    assert.equal(statuses.at(-1), '')
    if (platform === 'win32') assert.ok(calls[0].args.includes('-STA'))
  })
}

test('Linux native binary media uses bounded execFile, supports X11 fallback and clears status', async () => {
  for (const selected of ['wl-paste', 'xclip']) {
    const statuses = []
    const result = await readClipboardMedia({ platform: 'linux', onStatus: value => statuses.push(value), executeFile: async (command, args, options) => {
      if (command !== selected) throw Object.assign(new Error('not installed'), { code: 'ENOENT' })
      assert.equal(options.maxBuffer, MAX_MEDIA_BYTES + 1)
      if (args.includes('--list-types') || args.includes('TARGETS')) return { stdout: 'video/mp4\ntext/plain' }
      assert.equal(options.encoding, 'buffer')
      return { stdout: mp4Bytes }
    } })
    assert.equal(result.type, 'video')
    assert.equal(statuses.at(-1), '')
  }
})

test('multiple copied files and remote URI lists are rejected, not partially reported as attached', async () => {
  for (const list of ['file:///one.wav\nfile:///two.wav', 'file://server/private.wav']) {
    const result = await readClipboardMedia({ platform: 'linux', executeFile: async (_command, args) => ({ stdout: args.includes('--list-types') ? 'text/uri-list' : Buffer.from(list) }) })
    assert.equal(result.type, 'error')
  }
})

test('clipboard timeouts and maxBuffer errors remain errors; absent media falls back to text', async () => {
  for (const code of ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ETIMEDOUT']) {
    const result = await readClipboardMedia({ platform: 'linux', executeFile: async () => { throw Object.assign(new Error('internal command and private path'), { code }) } })
    assert.equal(result.type, 'error')
    assert.doesNotMatch(result.message, /private path/)
  }
  assert.equal(await readClipboardMedia({ platform: 'linux', executeFile: async () => { throw Object.assign(new Error('not installed'), { code: 'ENOENT' }) } }), null)
})
