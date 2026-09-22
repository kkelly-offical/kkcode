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
        const start = list.findIndex(rule => rule.type === CSSRule.STYLE_RULE && rule.selectorText === ':root' && rule.style.getPropertyValue('--primary-hover').trim() === '#30302d')
        if(start < 0) continue
        const saved = list.slice(start).map(rule => rule.cssText)
        for(let i = sheet.cssRules.length - 1; i >= start; i--) sheet.deleteRule(i)
        return { sheetIndex, start, saved }
      }
      throw new Error('Pixel visual layer was not found; no layout comparison was performed')
    })
    const original = await controls()
    await page.evaluate(({ sheetIndex, start, saved }) => { const sheet = document.styleSheets[sheetIndex]; for(const [offset, text] of saved.entries()) sheet.insertRule(text, start + offset) }, rules)
    assert.equal(painted.length, original.length, `${name}/${theme}: no control added or removed by styling`)
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
  console.log(`Pixel theme: ${comparisons} control rectangles unchanged against the original CSS; dark/light desktop/mobile/320px screenshots captured`)
} finally {
  await browser.close(); await server.close()
  if(old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old
  await rm(temporary, { recursive: true, force: true })
}
