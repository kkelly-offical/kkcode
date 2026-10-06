import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { readDocument } from '../src/device/document-reader.mjs'
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const office = (parts) => Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, strToU8(text)])))).toString('base64')
test('Office attachments extract real text without executing relationships or macros', async () => {
  const data = office({ 'word/document.xml': '<w:document xmlns:w="word"><w:p><w:r><w:t>附件内容</w:t></w:r><w:r><w:t> hello</w:t></w:r></w:p></w:document>', 'word/vbaProject.bin': 'not executable', 'word/_rels/document.xml.rels': '<Relationship Target="https://invalid.example/secret"/>' })
  assert.equal(await readDocument(data, docx), '附件内容 hello')
})
test('spreadsheet attachment resolves shared strings and stored values', async () => {
  const data = office({ 'xl/sharedStrings.xml': '<sst><si><t>项目</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><row><c t="s"><v>0</v></c><c><f>1+1</f><v>2</v></c></row></worksheet>' })
  assert.match(await readDocument(data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /项目\t2/)
})
test('malformed, empty, hostile XML and oversized documents fail with actionable messages', async () => {
  await assert.rejects(readDocument(Buffer.from('fake pdf').toString('base64'), 'application/pdf'), /文件内容不是 PDF/)
  await assert.rejects(readDocument(office({ 'word/document.xml': '<doc/>' }), docx), /未找到可读取/)
  await assert.rejects(readDocument(office({ 'word/document.xml': '<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///etc/passwd">]><doc>&x;</doc>' }), docx), /XML 声明/)
  await assert.rejects(readDocument(office({ 'word/document.xml': '<doc><p><t>' + 'x'.repeat(300000) + '</t></p></doc>' }), docx), /超过 256 KiB/)
})
test('PDF attachment reaches the text extractor', async () => {
  const stream = 'BT /F1 12 Tf 72 720 Td (Attachment test) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n', offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  assert.match(await readDocument(Buffer.from(pdf).toString('base64'), 'application/pdf'), /Attachment test/)
})
