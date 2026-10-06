import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAndroidReleaseTarget } from '../scripts/android-release-target.mjs'
import { checkReleaseVersions } from '../scripts/check-release-version.mjs'
import { MODE_IDS } from '../src/kernel/core/modes.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFile(path.join(root, file), 'utf8')
const entryDocs = [
  'README.md', 'docs/README.md', 'docs/getting-started.md', 'docs/configuration.md',
  'docs/modes-and-permissions.md', 'docs/cli-reference.md', 'docs/capabilities.md',
  'docs/versions.md', 'docs/history.md', 'docs/contributing.md', 'docs/implementation-1.1.6.md',
  'docs/implementation-1.0.5.md', 'docs/implementation-1.0.6-preview.0.md', 'docs/implementation-1.0.6-preview.1.md', 'docs/ROADMAP.md', 'docs/enterprise-deployment.md'
]

test('README stays a compact product entry rather than an accumulated release manual', async () => {
  const text = await read('README.md')
  assert.ok(text.trimEnd().split('\n').length <= 100)
  for (const topic of ['产品特色', '快速开始', '文档导航', 'Base URL', 'Android', 'Ultra', 'MCP', 'SDK']) assert.ok(text.includes(topic), topic)
  for (const doc of ['getting-started', 'configuration', 'modes-and-permissions', 'cli-reference', 'capabilities', 'versions', 'history']) assert.ok(text.includes(`docs/${doc}.md`), doc)
  assert.doesNotMatch(text, /0\.3\.0|0\.4\.0|gpt-5\.6|claude-sonnet-5/)
})

test('current entrypoint links exist in the checkout and in the npm documentation allowlist', async () => {
  const manifest = JSON.parse(await read('package.json'))
  const packaged = file => ['README.md', 'LICENSE', 'package.json'].includes(file)
    || manifest.files.some(entry => file === entry || entry.endsWith('/') && file.startsWith(entry))
  const currentDocs = new Set(entryDocs)
  for (const match of (await read('docs/README.md')).matchAll(/\]\(([^)]+)\)/g)) {
    if (!/^(?:https?:|#)/.test(match[1]) && match[1].endsWith('.md')) {
      currentDocs.add(path.posix.normalize(path.posix.join('docs', match[1])))
    }
  }
  let checked = 0
  for (const file of currentDocs) {
    assert.ok(packaged(file), `Entry document missing from package: ${file}`)
    for (const match of (await read(file)).matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (/^(?:https?:|#)/.test(target)) continue
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), target.split('#')[0]))
      assert.ok(!relative.startsWith('../') && !path.posix.isAbsolute(relative), `${file}: escaped link`)
      await access(path.join(root, relative))
      assert.ok(packaged(relative), `${file}: linked ${relative} is not in the installed documentation`)
      checked++
    }
  }
  assert.ok(checked >= 80, 'Link collection did not traverse the current documentation')
})

test('active topic guides do not send users back to unreleased hotfix or old deployment instructions', async () => {
  for (const file of ['remote-folder-browsing', 'remote-command-contract', 'media-input', 'responses-api', 'android-gateway-login', 'enterprise-ha-recovery']) {
    const text = await read(`docs/${file}.md`)
    assert.match(text, /1\.0\.5/)
    assert.doesNotMatch(text, /^# .*\(1\.0\.[1-4]\)|^# .*（1\.0\.[1-4]）/m)
    assert.doesNotMatch(text, /unreleased local hotfix|kkcode-gateway:1\.0\.[1-4]/)
  }
  assert.match(await read('docs/config.example.yaml'), /适用源码：1\.0\.6.*正式版/)
  assert.match(await read('docs/media-input.md'), /OpenAI Responses.*input_image/)
})

test('1.0.13 candidate preserves verified publication, preview, signing and historical facts', async () => {
  const manifest = await checkReleaseVersions(root)
  const android = await readAndroidReleaseTarget(root)
  assert.equal(manifest.version, '1.0.13')
  assert.equal(manifest.channel, 'stable')
  assert.equal(manifest.distTag, 'latest')
  assert.equal(android.version, manifest.version)
  assert.equal(android.versionCode, 10020)
  assert.equal(android.channel, 'stable')
  const readme = await read('README.md'), versions = await read('docs/versions.md')
  assert.match(readme, /当前稳定版本.*1\.0\.12/)
  assert.match(readme, /公开稳定与预览渠道以.*版本与升级/)
  assert.doesNotMatch(readme, /1\.1\.6/)
  assert.match(versions, /已发布稳定渠道.*1\.0\.12 \/ Android10019/)
  assert.match(versions, /上一已核实稳定版.*1\.0\.11/)
  assert.match(versions, /已发布预览渠道.*1\.0\.6-preview\.1 \/ Android10012/)
  assert.match(versions, /历史预览.*1\.0\.5-preview\.0/)
  assert.match(versions, /从未公开发行过1\.1\.6/)
  assert.match(versions, /源码版本、流水线启动都不等于已公开下载/)
  assert.match(versions, /PR#34已按用户管理员合入授权集成/)
  assert.match(versions, /release-verification\.json/)
  assert.match(await read('CHANGELOG.md'), /## 1\.0\.5 — Stable/)
  const notice = await read('NOTICE.md')
  assert.match(notice, /\*\*Version\*\*: See \[package\.json\]\(package\.json\)/)
  assert.doesNotMatch(notice, /\*\*Version\*\*: \d/)
  for (const [guide, image] of [['language-services', 'kkcode-lsp'], ['office-tools', 'kkcode-office'], ['enterprise-deployment', 'kkcode-gateway']]) {
    const text = await read(`docs/${guide}.md`)
    assert.ok(text.includes(`${image}:${manifest.version}`), `${guide}: local build tag must follow the source target`)
    assert.ok(!text.includes(`${image}:1.1.6`), `${guide}: obsolete source-only build tag`)
  }
  const androidGuide = await read('docs/android-release.md')
  assert.ok(androidGuide.includes(`kkcode-android-${manifest.version}.apk`))
  assert.ok(!androidGuide.includes('kkcode-android-1.1.6.apk'))
})

test('source progress and completion docs distinguish authored todos, check observations and stable JSONL', async () => {
  const modes = await read('docs/modes-and-permissions.md'), sdk = await read('docs/sdk-guide.md'), context = await read('docs/context-and-harness.md'), headless = await read('docs/headless-jsonl-contract.md')
  for (const tool of ['agent_list', 'agent_wait', 'agent_send', 'agent_followup', 'agent_interrupt']) assert.ok(modes.includes(tool))
  for (const contract of ['todos.v1', 'todos.list', 'todo.updated', 'todo_conflict', 'getSessionTodos', 'completed', 'verified']) assert.ok(sdk.includes(contract))
  assert.match(context, /checks_observed.*不是完整语义验收/)
  assert.match(context, /公共完成检查只观察已有记录，不自动执行命令/)
  assert.match(headless, /schemaVersion.*仍为.*"1"/)
  assert.match(headless, /completion/)
  assert.match(headless, /incomplete.*blocked.*unknown/)
  const lock = JSON.parse(await read('package-lock.json'))
  assert.equal(lock.packages['node_modules/koa/node_modules/content-type'].version, '1.0.5', 'source version edits must not rewrite third-party dependencies')
  assert.equal(lock.packages['node_modules/pgpass'].version, '1.0.5')
})

test('current mode documentation follows runtime IDs while retaining legacy aliases and governance', async () => {
  const text = await read('docs/modes-and-permissions.md')
  for (const mode of MODE_IDS) assert.ok(text.includes(`| \`${mode}\` |`), mode)
  assert.match(text, /`agent-auto`.*兼容别名/)
  assert.match(text, /不会自动批准/)
  assert.match(text, /普通Ultra.*严格任务.*不是相同的隔离等级/)
})

test('history is preserved separately and runtime limitations remain explicit', async () => {
  const current = await read('docs/implementation-1.0.5.md')
  assert.ok(current.trimEnd().split('\n').length <= 110)
  assert.match(current, /history\/implementation-1\.0\.5-preview\.0\.md/)
  const archive = await read('docs/history/implementation-1.0.5-preview.0.md')
  assert.match(archive, /历史归档/)
  assert.match(archive, /108通过／11失败／/)
  assert.match(archive, /releaseGatePassed=false/)
  const limits = await read('docs/capabilities.md')
  for (const marker of ['C04', 'C11', 'GitLab', 'workspaces', 'inode', '17条历史CodeQL']) assert.ok(limits.includes(marker), marker)
  assert.match(await read('docs/ROADMAP.md'), /github\.com\/kkelly-offical\/kkcode\/issues\/21/)
})
