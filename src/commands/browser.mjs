import { Command } from 'commander'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { browserStatus, browserBridgeStatus, installBrowserBridge, authorizeBrowserBridge, revokeBrowserBridge } from '../kernel/index.mjs'
import { createBrowserRecipesCommand } from './browser-recipes.mjs'

export function createBrowserCommand() {
  const command = new Command('browser').description('Manage the isolated built-in Browser engine')
  command.addCommand(createBrowserRecipesCommand())
  command.command('status').action(async () => { console.log(JSON.stringify(await browserStatus(), null, 2)) })
  const bridge = command.command('bridge').description('授权连接本机 Chrome／Edge 标签页组；不会导出 Cookie 或开放远程桌面')
  bridge.command('install').description('显式安装固定版本 Playwright MCP，禁用 npm 生命周期脚本').action(async () => {
    const status = await installBrowserBridge({ onProgress: message => console.error(message) })
    console.log(`桥接运行包 ${status.version} 已校验安装。请在目标浏览器安装官方扩展：${status.extensionUrl}`)
  })
  bridge.command('status').action(async () => { console.log(JSON.stringify(await browserBridgeStatus(), null, 2)) })
  bridge.command('connect').description('为指定会话授权页面范围；第一次访问仍需本机扩展弹窗确认')
    .requiredOption('--session <id>', '当前会话 ID')
    .requiredOption('--origin <origins...>', '允许访问的页面 origin，例如 https://example.com；不是全浏览器网络防火墙')
    .option('--browser <channel>', 'chrome 或 msedge', 'chrome')
    .option('--profile <name>', 'Default 或 Profile N', 'Default')
    .option('--allow-interaction', '明确允许点击和输入；不指定时只读', false)
    .option('--allow-screenshots', '另行允许已选标签页渲染图像发送给模型（含嵌入内容，不保证像素级 origin 数据隔离）', false)
    .option('--minutes <number>', '授权期限 1–60 分钟', '30')
    .action(async options => {
      console.log(JSON.stringify(await authorizeBrowserBridge({ sessionId: options.session, origins: options.origin, browser: options.browser, profile: options.profile, allowInteraction: options.allowInteraction, allowScreenshots: options.allowScreenshots, minutes: Number(options.minutes), confirmed: true }), null, 2))
    })
  bridge.command('disconnect').requiredOption('--session <id>', '撤销该会话的浏览器授权').action(async options => {
    await revokeBrowserBridge({ sessionId: options.session })
    console.log('授权已撤销；活动桥接将断开，不会关闭你的标签页或清除 Cookie。')
  })
  command.command('install').description('Download the pinned Playwright Chromium engine for this OS user').option('--with-deps', 'Also install OS browser libraries (may require system administrator approval)').action(async options => {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('playwright-core')))
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'install', ...(options.withDeps ? ['--with-deps'] : []), 'chromium'], { stdio: 'inherit', windowsHide: true })
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve(undefined) : reject(new Error(`Browser installation failed (${code}); inspect the installer output`)))
    })
    console.log('Browser engine installed. Browser actions use isolated per-conversation profiles; your personal browser is not connected.')
  })
  command.action(async () => { console.log(JSON.stringify(await browserStatus(), null, 2)) })
  return command
}
