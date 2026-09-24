import { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { open } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { createBrowserRecipeAuthority, createScopedBrowserRecipeStore, createBrowserRecipeFixtureRunner, createBrowserRecipeHost } from '../sdk/browser-recipes.mjs'

async function jsonFile(file) {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Recipe 输入需要不超过 1 MiB 的普通 JSON 文件。')
    const buffer = Buffer.alloc(1024 * 1024 + 1)
    let length = 0
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead }
    if (length > 1024 * 1024) throw new Error('Recipe JSON 文件超过大小限制。')
    try { return JSON.parse(buffer.subarray(0, length).toString('utf8')) } catch { throw new Error('Recipe JSON 无法解析；未输出原文。') }
  } finally { await handle.close() }
}
async function prompt(text, signal = undefined) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('此操作需要终端中的真实用户确认；不支持 --yes 或模型代确认。')
  const line = createInterface({ input: process.stdin, output: process.stderr })
  try { return await line.question(text, { signal }) } finally { line.close() }
}
function authority() {
  return createBrowserRecipeAuthority({ confirm: async request => {
    console.error(JSON.stringify(request, null, 2))
    const expected = request.hash || 'record'
    return (await prompt(`请检查以上站点/动作范围。确认请输入 ${expected}；其他输入取消：`)).trim() === expected
  } })
}
const print = value => console.log(JSON.stringify(value, null, 2))

/** Separate command factory; parent browser command mounts it explicitly. No
 * recipe management operation is installed in the model tool registry. */
export function createBrowserRecipesCommand() {
  const command = new Command('recipe').description('实验性：用户录制→脱敏候选→人工审核→独立离线验证→固定哈希启用')
  command.command('list').action(async () => print(await (await createScopedBrowserRecipeStore()).list()))
  command.command('show <id>').action(async id => print(await (await createScopedBrowserRecipeStore()).get({ id })))
  command.command('record <url>').option('--minutes <number>', '录制时限 1–30 分钟', '10').action(async (url, options) => {
    if (!process.stdin.isTTY) throw new Error('录制需要目标电脑的可见浏览器和交互终端。')
    const host = await createBrowserRecipeHost({ authority: authority(), headless: false })
    try {
      await host.open(url)
      const recorder = await host.store.start({ origin: new URL(url).origin, minutes: Number(options.minutes) })
      await host.attachRecorder(recorder)
      console.error('请在专用隔离浏览器中完成操作。输入值/密码不会录制；按 Enter 完成，超时会自动收束为待审核候选。')
      try { await prompt('', recorder.signal) } catch (error) { if (!recorder.signal.aborted) throw error }
      print(await recorder.finish())
    } finally { await host.close() }
  })
  command.command('review <id>').requiredOption('--hash <sha256>', 'show 中的完整候选哈希').action(async (id, options) => print(await (await createScopedBrowserRecipeStore({ authority: authority() })).review({ id, hash: options.hash })))
  command.command('validate <id>').requiredOption('--hash <sha256>', '已人工审核的完整候选哈希').requiredOption('--fixture <file>', '本机独立离线 fixture JSON：html、parameters、assertions').action(async (id, options) => {
    const fixture = await jsonFile(options.fixture)
    // Arbitrary config from a fixture file must not select a browser binary or
    // disable its sandbox. Those remain host SDK-only acceptance controls.
    const runner = createBrowserRecipeFixtureRunner({ html: fixture.html, parameters: fixture.parameters, assertions: fixture.assertions, browserConfig: { tool: { browser: { chromium_sandbox: true, executable_path: chromium.executablePath() } } } })
    print(await (await createScopedBrowserRecipeStore({ fixtureRunner: runner })).validate({ id, hash: options.hash }))
  })
  command.command('enable <id>').requiredOption('--hash <sha256>', '已通过独立验证的完整候选哈希').action(async (id, options) => print(await (await createScopedBrowserRecipeStore({ authority: authority() })).enable({ id, hash: options.hash })))
  command.command('disable <id>').action(async id => print(await (await createScopedBrowserRecipeStore()).disable({ id })))
  command.command('run <id>').requiredOption('--hash <sha256>', '已启用的完整候选哈希').requiredOption('--url <url>', '目标站点页面；运行前须与录制指纹匹配').option('--parameters <file>', '运行时字符串参数 JSON，不存入Recipe').option('--headless', '在无登录需求的页面显式无头运行', false).action(async (id, options) => {
    const parameters = options.parameters ? await jsonFile(options.parameters) : {}
    const host = await createBrowserRecipeHost({ headless: options.headless })
    try {
      await host.open(options.url)
      if (!options.headless) await prompt('如需登录，请在专用浏览器手动完成并回到目标页面；按 Enter 执行已启用的固定 Recipe：')
      print(await host.store.run({ id, hash: options.hash, parameters }))
    } finally { await host.close() }
  })
  return command
}
