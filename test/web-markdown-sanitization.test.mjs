import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

// This covers KK Code's ordinary string-sanitization integration, not an
// IN_PLACE/hook advisory reproduction: the application does not use those APIs.
test('Web Markdown sanitizes strings without in-place hooks and retains only safe browser links', async t => {
  if (!await access(chromium.executablePath()).then(() => true, () => false)) {
    if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Browser required')
    t.skip('Dedicated Chromium unavailable'); return
  }
  const component = await readFile(new URL('../apps/web/src/TranscriptView.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(component, /\bIN_PLACE\b|DOMPurify\.(?:addHook|setConfig)\s*\(/)
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import DOMPurify from 'dompurify';
    import { Markdown } from './apps/web/src/TranscriptView.tsx';
    const sanitize = DOMPurify.sanitize.bind(DOMPurify);
    window.sanitizeCalls = [];
    DOMPurify.sanitize = (value, config) => {
      window.sanitizeCalls.push({ type: typeof value, inPlace: config?.IN_PLACE === true });
      return sanitize(value, config);
    };
    window.renderMarkdown = text => createRoot(document.getElementById('root')).render(React.createElement(Markdown, { text }));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route('**/*', route => route.abort())
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const markdown = [
    '# Sanitized report',
    '<p onmouseover="void(0)">Preserved paragraph</p>',
    '<a href="javascript:void(0)" onclick="void(0)">Unsafe script link</a>',
    '<a href="data:text/html,unsafe">Unsafe data link</a>',
    '<a href="https://name:password@example.com/">Credential link</a>',
    '<img src="https://example.com/image.png" onerror="void(0)">',
    '<svg onload="void(0)"><text>Not HTML</text></svg>',
    '<iframe src="https://example.com/embedded"></iframe>',
    '<script>void(0)</script>',
    '[Official documentation](https://example.com/docs?view=all)',
    '![Image reference](https://example.com/image.png)',
  ].join('\n\n')
  await page.evaluate(text => window.renderMarkdown(text), markdown)
  await expect(page.getByRole('heading', { name: 'Sanitized report' })).toBeVisible()
  await expect(page.getByText('Preserved paragraph', { exact: true })).toBeVisible()
  await expect(page.locator('.markdown img, .markdown svg, .markdown iframe, .markdown script')).toHaveCount(0)
  for (const text of ['Unsafe script link', 'Unsafe data link', 'Credential link']) {
    await expect(page.getByText(text, { exact: true })).not.toHaveAttribute('href')
  }
  assert.equal(await page.locator('.markdown').evaluate(element => [...element.querySelectorAll('*')].some(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name)))), false)
  const safe = page.getByRole('link', { name: 'Official documentation', exact: true })
  await expect(safe).toHaveAttribute('href', 'https://example.com/docs?view=all')
  await expect(safe).toHaveAttribute('target', '_blank')
  await expect(safe).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(safe).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(page.getByRole('link', { name: 'Image reference ↗', exact: true })).toHaveAttribute('href', 'https://example.com/image.png')
  const calls = await page.evaluate(() => window.sanitizeCalls)
  assert.ok(calls.length > 0)
  assert.ok(calls.every(call => call.type === 'string' && call.inPlace === false))
})
