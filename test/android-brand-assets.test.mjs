import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

test('Android uses the reviewed brand master with adaptive safe margins', async () => {
  const root = new URL('../', import.meta.url)
  const file = name => readFile(new URL(name, root))
  const manifest = (await file('android/app/src/main/AndroidManifest.xml')).toString()
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/)
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher"/)
  const adaptive = (await file('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')).toString()
  assert.match(adaptive, /<adaptive-icon/)
  assert.match(adaptive, /@drawable\/kkcode_launcher_foreground/)
  const foreground = (await file('android/app/src/main/res/drawable/kkcode_launcher_foreground.xml')).toString()
  for (const side of ['Left', 'Top', 'Right', 'Bottom']) assert.ok(foreground.includes(`android:inset${side}="20%"`))
  const art = await file('android/app/src/main/res/drawable-nodpi/kkcode_launcher_art.png')
  const master = await file('docs/assets/brand/kkcode-android-icon-v2.png')
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.equal(hash(art), hash(master), 'Android and documented brand asset are identical')
  assert.deepEqual(art.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(art.readUInt32BE(16), art.readUInt32BE(20), 'square PNG master')
  assert.ok(art.length < 8 * 1024 * 1024, 'launcher master size stays bounded')
})
