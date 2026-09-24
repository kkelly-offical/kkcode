import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, readFile, writeFile, rm, access, link } from "node:fs/promises"
import { createOfficeService, createOfficeTools, isOfficeService } from "../src/kernel/office/service.mjs"
import { runStrictCommand } from "../src/kernel/isolation/docker-executor.mjs"
import { ArtifactStore } from "../src/storage/artifact-store.mjs"
import { createTaskArtifactAccess, trustedArtifactRef } from "../src/kernel/tool/artifacts.mjs"

const image = process.env.KKCODE_OFFICE_TEST_IMAGE
const real = { skip: !image, timeout: 180000 }
const originalHome = process.env.KKCODE_HOME
const root = await mkdtemp(path.join(os.tmpdir(), "kk-office-test-"))
process.env.KKCODE_HOME = path.join(root, "private-state")
test.after(async () => {
  if (originalHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = originalHome
  await rm(root, { recursive: true, force: true })
})
async function fixture(t) {
  const cwd = await mkdtemp(path.join(root, "workspace-"))
  const service = await createOfficeService({ cwd, image: image || `sha256:${"a".repeat(64)}` })
  t.after(() => service.dispose())
  return { cwd, service }
}
const exists = filename => access(filename).then(() => true, () => false)

test("office tools require a real host-owned service and immutable image", async t => {
  const cwd = await mkdtemp(path.join(root, "unavailable-"))
  await assert.rejects(createOfficeService({ cwd, image: "office:latest" }), /固定镜像/)
  const { service } = await fixture(t)
  assert.equal(isOfficeService(service), true)
  assert.equal(isOfficeService({ ...service }), false)
  const tools = createOfficeTools()
  assert.equal(tools.length, 7)
  assert.equal(tools.every(tool => tool.inputSchema?.type === "object"), true)
  assert.equal((await tools[0].execute({}, { officeService: { run: async () => ({ ok: true }) } })).status, "error")
  await assert.rejects(service.run({ operation: "arbitrary_shell", command: "echo no" }), /操作无效/)
  await assert.rejects(service.run({ operation: "inspect", inputs: ["../private.docx"] }), /文档路径/)
})

test("document input hardlinks are rejected before any parser starts", real, async t => {
  const { cwd, service } = await fixture(t)
  await writeFile(path.join(cwd, "one.docx"), "synthetic")
  await link(path.join(cwd, "one.docx"), path.join(cwd, "two.docx"))
  await assert.rejects(service.run({ operation: "inspect", inputs: ["two.docx"] }), /硬链接/)
})

test("real image reports pinned parser/render/OCR capabilities", real, async t => {
  const { service } = await fixture(t)
  const result = await service.capabilities()
  assert.equal(result.capabilities.protocol, 1)
  assert.equal(result.capabilities.versions["python-docx"], "1.2.0")
  assert.equal(result.capabilities.versions.openpyxl, "3.1.5")
  assert.ok(result.capabilities.ocrLanguages.includes("eng"))
  assert.ok(result.capabilities.ocrLanguages.includes("chi_sim"))
  assert.equal(result.isolation.network, "none")
})

test("DOCX is reopened, rendered and text-verified; editing delivers a new version", real, async t => {
  const { cwd, service } = await fixture(t)
  const first = await service.run({ operation: "create", format: "docx", filename: "report.docx", outputDir: "first", spec: {
    title: "KK Code 工作报告", blocks: [{ type: "heading", text: "验收结果", level: 1 },
      { type: "paragraph", text: "Original text for verified delivery." }, { type: "table", rows: [["检查", "结果"], ["渲染", "通过"]] }]
  } })
  assert.equal(first.validation.render.textVerified, true)
  assert.equal(first.validation.render.pageCount, 1)
  assert.equal(first.validation.render.pages[0].nonBlank, true)
  assert.ok(first.outputs.some(item => item.mime === "image/png"))
  const original = await readFile(path.join(cwd, first.primary))
  const edited = await service.run({ operation: "edit", inputs: [first.primary], outputDir: "edited", filename: "report-v2.docx",
    changes: { replace: [{ find: "Original text", replace: "Revised text" }] } })
  assert.equal(edited.validation.render.textVerified, true)
  assert.deepEqual(await readFile(path.join(cwd, first.primary)), original)
  const inspected = await service.run({ operation: "inspect", inputs: [edited.primary] })
  assert.ok(inspected.content.paragraphs.some(value => value.includes("Revised text")))
  await assert.rejects(service.run({ operation: "create", format: "md", outputDir: "first", spec: { text: "must not overwrite" } }), /已经存在/)
  assert.deepEqual(await readFile(path.join(cwd, first.primary)), original)
})

test("XLSX formulas are actually recalculated, plain formula-looking data stays text", real, async t => {
  const { service } = await fixture(t)
  const result = await service.run({ operation: "create", format: "xlsx", filename: "budget.xlsx", outputDir: "book", spec: {
    sheets: [{ name: "Budget", rows: [["Value", "Note"], [2, "first"], [3, "second"], [{ formula: "=SUM(A2:A3)" }, "total"], ["=WEBSERVICE(\"https://example.test\")", "untrusted data"]] }]
  } })
  assert.equal(result.validation.structural.recalculated, true)
  assert.equal(result.validation.structural.formulaCount, 1)
  assert.equal(result.validation.structural.formulas[0].value, 5)
  assert.ok(result.validation.render.pageCount > 0)
  const inspected = await service.run({ operation: "inspect", inputs: [result.primary] })
  assert.equal(inspected.content.sheets[0].rows[4][0], '=WEBSERVICE("https://example.test")')
  await assert.rejects(service.run({ operation: "create", format: "xlsx", outputDir: "bad-formula", spec: {
    sheets: [{ name: "Bad", rows: [[{ formula: '=WEBSERVICE("https://example.test")' }]] }]
  } }), /外部引用|本地计算/)
})

test("PPTX chart/body content is rendered and page bounds checked", real, async t => {
  const { service } = await fixture(t)
  const result = await service.run({ operation: "create", format: "pptx", filename: "deck.pptx", outputDir: "slides", spec: {
    slides: [{ title: "Verified presentation", body: ["Reliable local execution", "Original documents preserved"],
      chart: { type: "bar", categories: ["A", "B"], series: [{ name: "Checks", values: [2, 4] }] } }]
  } })
  assert.equal(result.validation.structural.slides, 1)
  assert.equal(result.validation.structural.boundsChecked, true)
  assert.equal(result.validation.render.textVerified, true)
  assert.equal(result.validation.render.pageCount, 1)
})

test("PDF creation, merge, page selection and OCR produce verified new artifacts", real, async t => {
  const { cwd, service } = await fixture(t)
  const first = await service.run({ operation: "create", format: "pdf", filename: "one.pdf", outputDir: "pdf-one", spec: {
    title: "KKCODE OCR TEST", blocks: [{ type: "paragraph", text: "Verified document number 12345" }]
  } })
  const merged = await service.run({ operation: "merge_pdf", inputs: [first.primary, first.primary], filename: "two.pdf", outputDir: "pdf-merge" })
  assert.equal(merged.validation.render.pageCount, 2)
  const selected = await service.run({ operation: "select_pdf_pages", inputs: [merged.primary], pages: [2], filename: "selected.pdf", outputDir: "pdf-selected" })
  assert.equal(selected.validation.render.pageCount, 1)
  const ocr = await service.run({ operation: "ocr", inputs: [first.primary], language: "eng", outputDir: "ocr", filename: "recognized.md" })
  assert.equal(ocr.validation.structural.requiresReview, true)
  assert.ok(ocr.validation.structural.averageConfidence > 40)
  assert.match(await readFile(path.join(cwd, ocr.primary), "utf8"), /KKCODE|12345/)
  const annotated = await service.run({ operation: "annotate_pdf", inputs: [first.primary], outputDir: "notes", filename: "notes.pdf",
    annotations: [{ page: 1, rect: [40, 40, 100, 90], text: "需要核验的中文便笺" }] })
  assert.equal(annotated.validation.structural.notesAdded, 1)
  assert.equal(annotated.validation.structural.contentsVerified, true)
})

test("Markdown export preserves headings and clickable source links", real, async t => {
  const { service, cwd } = await fixture(t)
  const markdown = await service.run({ operation: "create", format: "md", outputDir: "markdown", filename: "notes.md", spec: {
    text: "# Verified report\n\nSource: [Python documentation](https://docs.python.org/3/).\n\n参考：[中文资料](https://example.invalid/zh)。\n\n- Original data preserved\n"
  } })
  const exported = await service.run({ operation: "render", inputs: [markdown.primary], outputDir: "markdown-export" })
  assert.equal(exported.validation.render.textVerified, true)
  assert.equal(exported.validation.render.pageCount, 1)
  assert.equal(exported.validation.render.hyperlinksVerified, true)
  const links = await runStrictCommand({ image, workspaceDir: cwd, readOnly: true, argv: ["/opt/office-venv/bin/python", "-c",
    "from pypdf import PdfReader;import json;d=PdfReader('markdown-export/document.pdf');print(json.dumps([str(a.get_object().get('/A',{}).get('/URI','')) for p in d.pages for a in p.get('/Annots',[])]))"] })
  assert.equal(links.exitCode, 0, links.stderr)
  assert.ok(JSON.parse(links.stdout).includes("https://docs.python.org/3/"))
  assert.ok(JSON.parse(links.stdout).includes("https://example.invalid/zh"))
  await assert.rejects(service.run({ operation: "create", format: "docx", outputDir: "ambiguous-links", spec: {
    blocks: [{ type: "paragraph", text: "[Same](https://one.invalid/) and [Same](https://two.invalid/)" }]
  } }), /不同地址|歧义/)
})

test("existing PDF text forms are filled and read back without changing the input", real, async t => {
  const { cwd, service } = await fixture(t)
  const script = [
    "from pypdf import PdfWriter",
    "from pypdf.generic import DictionaryObject,NameObject,ArrayObject,TextStringObject,NumberObject",
    "w=PdfWriter();p=w.add_blank_page(width=612,height=792)",
    "font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})",
    "font_ref=w._add_object(font)",
    "field=DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Widget'),NameObject('/FT'):NameObject('/Tx'),NameObject('/T'):TextStringObject('name'),NameObject('/V'):TextStringObject(''),NameObject('/Rect'):ArrayObject([NumberObject(x) for x in [50,650,350,690]]),NameObject('/DA'):TextStringObject('/Helv 12 Tf 0 g')})",
    "ref=w._add_object(field);p[NameObject('/Annots')]=ArrayObject([ref])",
    "w._root_object[NameObject('/AcroForm')]=DictionaryObject({NameObject('/Fields'):ArrayObject([ref]),NameObject('/DR'):DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/Helv'):font_ref})}),NameObject('/DA'):TextStringObject('/Helv 12 Tf 0 g')})",
    "w.write('form.pdf')"
  ].join("\n")
  const built = await runStrictCommand({ image, workspaceDir: cwd, argv: ["/opt/office-venv/bin/python", "-c", script] })
  assert.equal(built.exitCode, 0, built.stderr)
  const original = await readFile(path.join(cwd, "form.pdf"))
  const result = await service.run({ operation: "fill_pdf", inputs: ["form.pdf"], fields: { name: "KK Code" }, outputDir: "filled", filename: "filled.pdf" })
  assert.equal(result.validation.structural.valuesVerified, true)
  assert.equal(result.validation.structural.filledFields.name, "KK Code")
  assert.deepEqual(await readFile(path.join(cwd, "form.pdf")), original)
})

test("active Office objects and encrypted PDF are explicitly rejected without output", real, async t => {
  const { cwd, service } = await fixture(t)
  const generated = await service.run({ operation: "create", format: "docx", outputDir: "original", spec: { blocks: [{ type: "paragraph", text: "Preserve me" }] } })
  const original = await readFile(path.join(cwd, generated.primary))
  const program = [
    "import zipfile;from pypdf import PdfWriter;from pathlib import Path",
    `data=Path(${JSON.stringify(generated.primary)}).read_bytes();Path('macro.docx').write_bytes(data)`,
    "z=zipfile.ZipFile('macro.docx','a');z.writestr('word/vbaProject.bin',b'unsafe');z.close()",
    "w=PdfWriter();w.add_blank_page(width=612,height=792);w.encrypt('synthetic');f=open('locked.pdf','wb');w.write(f);f.close()"
  ].join("\n")
  const built = await runStrictCommand({ image, workspaceDir: cwd, argv: ["/opt/office-venv/bin/python", "-c", program] })
  assert.equal(built.exitCode, 0, built.stderr)
  await assert.rejects(service.run({ operation: "inspect", inputs: ["macro.docx"] }), /不能安全保真/)
  await assert.rejects(service.run({ operation: "inspect", inputs: ["locked.pdf"] }), /加密 PDF/)
  assert.deepEqual(await readFile(path.join(cwd, generated.primary)), original)
  assert.equal(await exists(path.join(cwd, "edited")), false)
})

test("Office tool archives original document and real previews as scoped binary artifacts", real, async t => {
  const { cwd, service } = await fixture(t)
  const store = new ArtifactStore({ root: await mkdtemp(path.join(root, "artifacts-")) })
  const actor = { accountId: "a", projectId: "p", sessionId: "s", runId: "r" }
  const artifactAccess = createTaskArtifactAccess({ store, resolveActor: async () => actor })
  const create = createOfficeTools().find(tool => tool.name === "office_create")
  const result = await create.execute({ format: "docx", outputDir: "archived", spec: {
    title: "Archived report", blocks: [{ type: "paragraph", text: "Complete binary artifact evidence" }]
  } }, { officeService: service, artifactAccess, toolCallId: "office-create" })
  assert.equal(result.status, "completed", result.output)
  const delivery = result.metadata.office
  assert.ok(delivery.outputs.length >= 3)
  assert.equal(result.metadata.artifactRefs.length, delivery.outputs.length)
  for (const output of delivery.outputs) {
    const ref = output.artifactRef
    assert.equal(trustedArtifactRef({ metadata: { artifactRef: ref } }), ref)
    assert.equal(ref.sha256, output.sha256)
    assert.equal(ref.size, (await readFile(path.join(cwd, output.path))).length)
    const metadata = await store.getMetadata({ actor, id: ref.id })
    assert.equal(metadata.source.kind, "document")
    assert.equal(metadata.mime, output.mime)
  }
})
