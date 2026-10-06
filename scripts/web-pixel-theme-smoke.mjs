import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'

const temporary = await mkdtemp(path.join(os.tmpdir(), 'kkcode-pixel-layout-')), old = process.env.KKCODE_HOME
process.env.KKCODE_HOME = path.join(temporary, 'state')
await mkdir(process.env.KKCODE_HOME)
await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ skills: { auto_seed: false }, mcp: { auto_discover: false }, provider: { default: 'fixture', fixture: { type: 'openai-compatible', default_model: 'fixture-model' } } }))
const service = await new DeviceService({ cwd: temporary, roots: [temporary] }).initialize()
await service.request({ id: 'pixel-layout-session', issuedAt: Date.now(), method: 'sessions.create', params: { cwd: temporary, title: '布局验收' } })
const server = await createDeviceServer({ service, port: 0 }), info = await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
let comparisons = 0
async function controls() {
  return page.locator('button,input,textarea,select').evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }).map(element => {
    const r = element.getBoundingClientRect()
    return { label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80) || element.getAttribute('placeholder'), x: r.x, y: r.y, width: r.width, height: r.height }
  }))
}
async function compare(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  for(const theme of ['dark', 'light']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme)
    const painted = await controls()
    const rules = await page.evaluate(() => {
      for(const [sheetIndex, sheet] of [...document.styleSheets].entries()) {
        const list = [...sheet.cssRules]
        const start = list.findIndex(rule => rule.type === CSSRule.STYLE_RULE && rule.selectorText === ':root' && rule.style.getPropertyValue('--pixel-finish').trim() === '1')
        if(start < 0) continue
        // The 1.0.12 experience layer intentionally changes layout and controls.
        // Keep it applied while checking that the original decorative pixel
        // skin itself adds no layout shifts in either theme.
        const boundary = list.findIndex((rule, index) => index > start && rule.type === CSSRule.STYLE_RULE && rule.selectorText === ':root' && rule.style.getPropertyValue('--experience-layout').trim() === '1')
        const end = boundary < 0 ? list.length : boundary
        const saved = list.slice(start, end).map(rule => rule.cssText)
        for(let i = end - 1; i >= start; i--) sheet.deleteRule(i)
        return { sheetIndex, start, saved }
      }
      throw new Error('Pixel visual layer was not found; no layout comparison was performed')
    })
    const original = await controls()
    await page.evaluate(({ sheetIndex, start, saved }) => { const sheet = document.styleSheets[sheetIndex]; for(const [offset, text] of saved.entries()) sheet.insertRule(text, start + offset) }, rules)
    assert.equal(painted.length, original.length, `${name}/${theme}: no control added or removed by styling\npainted=${JSON.stringify(painted.map(item => item.label))}\nbase=${JSON.stringify(original.map(item => item.label))}`)
    for(let i = 0; i < painted.length; i++) {
      assert.equal(painted[i].label, original[i].label)
      for(const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(painted[i][field] - original[i][field]) < .5, `${name}/${theme} ${painted[i].label}: ${field} shifted (${original[i][field]} -> ${painted[i][field]})`)
    }
    await page.screenshot({ path: `test-results/pixel-${name}-${theme}.png`, animations: 'disabled' })
    comparisons += painted.length
  }
}
try {
  await mkdir('test-results', { recursive: true })
  await page.goto(info.url)
  await page.getByRole('button', { name: /布局验收/ }).first().click()
  await page.getByRole('textbox', { name: '消息' }).waitFor()
  await expect(page.getByRole('button', { name: '选择模型，当前 fixture 的 fixture-model', exact: true })).toBeVisible()
  await expect(page.locator('.chat-title strong')).toHaveText('布局验收')
  await compare('desktop-chat')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: '返回会话列表' })).toBeVisible()
  await compare('mobile-chat')
  await page.getByRole('button', { name: '返回会话列表' }).click()
  await expect(page.getByRole('textbox', { name: '搜索聊天' })).toBeVisible()
  await compare('mobile-home')
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await compare('mobile-menu')
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await compare('mobile-settings')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 320, height: 640 })
  await compare('narrow-home')
  // New companion controls are functional, respect the existing draft, and never send it.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: /布局验收/ }).first().click()
  await page.getByRole('textbox', { name: '消息' }).fill('保留我的要求')
  await page.getByRole('button', { name: '像素伙伴', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '鸢尾', exact: true }).click()
  await dialog.getByRole('button', { name: '了解项目', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('保留我的要求\n\n梳理项目结构，说明主要模块与入口。')
  await expect(page.locator('.message.user')).toHaveCount(0)
  assert.equal(await page.evaluate(() => localStorage.getItem('kkcode.studio.palette')), 'iris')
  await page.getByRole('button', { name: '像素伙伴', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: '收起玩偶，保留状态', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(page.locator('.studio-companion .pixel-buddy')).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: /布局验收/ }).first().click()
  await expect(page.locator('.studio-companion')).toHaveClass(/compact/)
  await page.getByRole('button', { name: '像素伙伴', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: '鸢尾', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('checkbox', { name: '收起玩偶，保留状态', exact: true }).uncheck()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打开产物', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('会话产物')
  await page.keyboard.press('Escape')
  for(const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 })
    await expect(page.getByRole('textbox', { name: '消息' })).toBeInViewport()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px must not overflow`)
    await expect(page.getByRole('button', { name: '像素伙伴', exact: true })).toBeInViewport()
  }
  assert.equal(await page.locator('.buddy-eyes').first().evaluate(node => getComputedStyle(node).animationName), 'none', 'reduced motion disables companion animation')
  console.log(`Pixel theme: ${comparisons} control rectangles unchanged against the original CSS; dark/light desktop/mobile/320px screenshots captured`)
} finally {
  await browser.close(); await server.close()
  if(old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old
  await rm(temporary, { recursive: true, force: true })
}
