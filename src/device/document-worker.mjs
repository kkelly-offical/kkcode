import { parentPort, workerData } from 'node:worker_threads'
import { unzipSync } from 'fflate'
import { DOMParser } from '@xmldom/xmldom'

const MAX_TEXT = 256 * 1024, MAX_XML = 8 * 1024 * 1024
let text = ''
function append(value) {
  text += value
  if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('文档文本超过 256 KiB，请拆分文件或选择需要的页面。')
}
function xml(bytes) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('文档含不支持的 XML 声明。')
  return new DOMParser({ onError: () => { throw new Error('文档结构损坏。') } }).parseFromString(value, 'application/xml')
}
const elements = (root, name) => Array.from(root.getElementsByTagName('*')).filter(node => node.localName === name)
try {
  const bytes = Buffer.from(workerData.data, 'base64')
  if (workerData.mediaType === 'application/pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是 PDF。')
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0 })
    let doc
    try {
      doc = await task.promise
      if (doc.numPages > 200) throw new Error('PDF 超过 200 页，请拆分后上传。')
      for (let page = 1; page <= doc.numPages; page++) {
        const content = await (await doc.getPage(page)).getTextContent()
        const line = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim()
        if (line) append(`\n[第 ${page} 页]\n${line}\n`)
      }
    } finally { await task.destroy() }
  } else {
    let total = 0, entries = 0
    const parts = unzipSync(bytes, { filter: entry => {
      if (++entries > 2048) throw new Error('文档包含过多文件。')
      const selected = /^(word\/(document|header\d+|footer\d+)\.xml|xl\/(sharedStrings|worksheets\/sheet\d+)\.xml|ppt\/slides\/slide\d+\.xml)$/.test(entry.name)
      if (!selected) return false
      total += entry.originalSize
      if (entry.originalSize > MAX_XML || total > MAX_XML) throw new Error('文档展开后过大，请拆分文件。')
      return true
    } })
    const keys = Object.keys(parts).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    const kind = workerData.mediaType.split('.').at(-1)
    if (kind === 'document' && !keys.includes('word/document.xml') || kind === 'sheet' && !keys.some(k => k.startsWith('xl/worksheets/')) || kind === 'presentation' && !keys.some(k => k.startsWith('ppt/slides/'))) throw new Error('文档内容与文件类型不符。')
    const strings = parts['xl/sharedStrings.xml'] ? elements(xml(parts['xl/sharedStrings.xml']), 'si').map(node => elements(node, 't').map(t => t.textContent).join('')) : []
    for (const key of keys.filter(key => !key.endsWith('sharedStrings.xml'))) {
      const doc = xml(parts[key])
      if (key.startsWith('xl/')) {
        append(`\n[${key.split('/').at(-1)}]\n`)
        for (const row of elements(doc, 'row')) append(elements(row, 'c').map(cell => {
          const value = elements(cell, 'v')[0]?.textContent || ''
          return cell.getAttribute('t') === 's' ? strings[Number(value)] || '' : cell.getAttribute('t') === 'inlineStr' ? elements(cell, 't').map(t => t.textContent).join('') : value
        }).join('\t') + '\n')
      } else {
        for (const paragraph of elements(doc, 'p')) append(elements(paragraph, 't').map(t => t.textContent).join('') + '\n')
      }
    }
  }
  if (!text.trim()) throw new Error('未找到可读取的文字。扫描版文档请导出为图片后上传，或先进行文字识别。')
  parentPort.postMessage({ text: text.trim() })
} catch (error) {
  const safe = /^(文档|PDF |文件内容|未找到)/.test(error.message) ? error.message : '无法解析此文档；请确认文件未损坏、未加密，并使用 PDF、DOCX、XLSX 或 PPTX 格式。'
  parentPort.postMessage({ error: safe })
}
