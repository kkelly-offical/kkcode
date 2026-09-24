const base = (number, title, prompt, setup, reference, oracle) => ({
  id: `D${String(number).padStart(2, '0')}`, category: 'documents', split: number <= 7 ? 'development' : 'sealed',
  title, driver: 'office-document', critical: false, prompt,
  fixtureFiles: { 'package.json': '{"private":true,"type":"module"}\n' },
  setupOperations: setup, referenceOperations: reference, oracle,
  requiredImages: ['office']
})
const pdf = (label, outputDir) => ({ operation: 'create', format: 'pdf', filename: 'source.pdf', outputDir,
  spec: { title: label, blocks: [{ type: 'paragraph', text: `Verified source ${label}` }] } })

export const documentCases = [
  base(1, '中文验收报告和表格', '创建 deliverable/report.docx：标题“项目验收报告”，一级标题“结论”，正文“所有原始文件保持不变。”，两列表格的行分别为[项目,状态]、[模型,通过]、[归档,通过]。保留所有输入，并生成真实预览。', [],
    [{ operation: 'create', format: 'docx', filename: 'report.docx', outputDir: 'deliverable', spec: { title: '项目验收报告', blocks: [
      { type: 'heading', level: 1, text: '结论' }, { type: 'paragraph', text: '所有原始文件保持不变。' },
      { type: 'table', rows: [['项目', '状态'], ['模型', '通过'], ['归档', '通过']] }] } }],
    { type: 'docx', path: 'deliverable/report.docx', text: ['项目验收报告', '结论', '所有原始文件保持不变。'], table: [['项目', '状态'], ['模型', '通过'], ['归档', '通过']] }),
  base(2, '工作簿真实公式重算', '创建 deliverable/budget.xlsx，Budget表A1:B4依次为[项目,金额]、[A,17]、[B,25]、[合计,=SUM(B2:B3)]。合计必须为真正公式并实际重算到42，不是字符串。保留输入。', [],
    [{ operation: 'create', format: 'xlsx', filename: 'budget.xlsx', outputDir: 'deliverable', spec: { sheets: [{ name: 'Budget', rows: [
      ['项目', '金额'], ['A', 17], ['B', 25], ['合计', { formula: '=SUM(B2:B3)' }] ] }] } }],
    { type: 'xlsx', path: 'deliverable/budget.xlsx', sheet: 'Budget', formulas: { B4: { expression: '=SUM(B2:B3)', value: 42 } }, cells: { A1: '项目', B2: 17, B3: 25 } }),
  base(3, '双页图表演示文稿', '创建 deliverable/review.pptx，两张幻灯片。第1张标题“Reliable Delivery”，正文“Originals preserved”“Offline validation”；第2张标题“Checks”，条形图类别DOCX/XLSX、Checks系列值3/4。真实渲染并保留输入。', [],
    [{ operation: 'create', format: 'pptx', filename: 'review.pptx', outputDir: 'deliverable', spec: { slides: [
      { title: 'Reliable Delivery', body: ['Originals preserved', 'Offline validation'] },
      { title: 'Checks', chart: { type: 'bar', categories: ['DOCX', 'XLSX'], series: [{ name: 'Checks', values: [3, 4] }] } }] } }],
    { type: 'pptx', path: 'deliverable/review.pptx', slideCount: 2, text: ['Reliable Delivery', 'Originals preserved', 'Offline validation', 'Checks'], chart: { categories: ['DOCX', 'XLSX'], values: [3, 4] } }),
  base(4, 'PDF 合并顺序与原件', '将 source-a/source.pdf 和 source-b/source.pdf 按此顺序合并为 deliverable/merged.pdf。保留原文件，不重写正文，输出应恰为两页。',
    [pdf('ALPHA', 'source-a'), pdf('BETA', 'source-b')],
    [{ operation: 'merge_pdf', inputs: ['source-a/source.pdf', 'source-b/source.pdf'], filename: 'merged.pdf', outputDir: 'deliverable' }],
    { type: 'pdf', path: 'deliverable/merged.pdf', pages: ['ALPHA', 'BETA'] }),
  base(5, 'PDF 选页重新排序', '将 source/source.pdf 的第3页和第1页按该顺序提取为 deliverable/selected.pdf，共2页。原件保持不变。',
    [pdf('ALPHA', 'source-a'), pdf('BETA', 'source-b'), pdf('GAMMA', 'source-c'),
      { operation: 'merge_pdf', inputs: ['source-a/source.pdf', 'source-b/source.pdf', 'source-c/source.pdf'], filename: 'source.pdf', outputDir: 'source' }],
    [{ operation: 'select_pdf_pages', inputs: ['source/source.pdf'], pages: [3, 1], filename: 'selected.pdf', outputDir: 'deliverable' }],
    { type: 'pdf', path: 'deliverable/selected.pdf', pages: ['GAMMA', 'ALPHA'] }),
  base(6, 'DOCX 局部修改保留原件', '把 source/original.docx 中唯一的“Old heading”改为“Revised heading”，其余内容不变，生成 deliverable/revised.docx；原件不覆盖。',
    [{ operation: 'create', format: 'docx', filename: 'original.docx', outputDir: 'source', spec: { title: 'Old heading', blocks: [{ type: 'paragraph', text: 'Preserve this paragraph exactly.' }] } }],
    [{ operation: 'edit', inputs: ['source/original.docx'], filename: 'revised.docx', outputDir: 'deliverable', changes: { replace: [{ find: 'Old heading', replace: 'Revised heading' }] } }],
    { type: 'docx', path: 'deliverable/revised.docx', text: ['Revised heading', 'Preserve this paragraph exactly.'], absent: ['Old heading'] }),
  base(7, 'PDF 中文便笺不是改正文', '在 source/source.pdf 第1页rect [40,40,100,90] 添加便笺“请复核此页数据”，保存到 deliverable/noted.pdf。不要改原正文或覆盖原件。',
    [pdf('ANNOTATION SOURCE', 'source')],
    [{ operation: 'annotate_pdf', inputs: ['source/source.pdf'], filename: 'noted.pdf', outputDir: 'deliverable', annotations: [{ page: 1, rect: [40, 40, 100, 90], text: '请复核此页数据' }] }],
    { type: 'pdf', path: 'deliverable/noted.pdf', pages: ['ANNOTATION SOURCE'], annotations: ['请复核此页数据'] }),
  base(8, '真实 OCR 与不确定性', '对 source/source.pdf 做英文OCR，输出 deliverable/recognized.md，保留原件和词级置信度证据。不得手工抄写已知文本冒充OCR。',
    [pdf('KKCODE NUMBER 24680', 'source')],
    [{ operation: 'ocr', inputs: ['source/source.pdf'], language: 'eng', outputDir: 'deliverable', filename: 'recognized.md' }],
    { type: 'ocr', path: 'deliverable/recognized.md', text: ['KKCODE', '24680'], requireTsv: true }),
  base(9, 'Markdown 导出保留可点击来源', '将 source/notes.md 导出PDF到 deliverable/document.pdf，保留标题Verified sources及指向https://docs.python.org/3/的可点击链接。保留原Markdown。',
    [{ operation: 'create', format: 'md', filename: 'notes.md', outputDir: 'source', spec: { text: '# Verified sources\n\nRead [Python documentation](https://docs.python.org/3/).\n' } }],
    [{ operation: 'render', inputs: ['source/notes.md'], outputDir: 'deliverable' }],
    { type: 'pdf', path: 'deliverable/document.pdf', pages: ['Verified sources'], links: ['https://docs.python.org/3/'] }),
  base(10, '工作簿更新与公式保持', '把 source/original.xlsx 的 Budget!A2 从3改为7，输出 deliverable/updated.xlsx；A1保持2，A3的SUM(A1:A2)公式保持且重新计算为9。原文件不覆盖。',
    [{ operation: 'create', format: 'xlsx', filename: 'original.xlsx', outputDir: 'source', spec: { sheets: [{ name: 'Budget', rows: [[2], [3], [{ formula: '=SUM(A1:A2)' }]] }] } }],
    [{ operation: 'edit', inputs: ['source/original.xlsx'], filename: 'updated.xlsx', outputDir: 'deliverable', changes: { cells: [{ sheet: 'Budget', cell: 'A2', value: 7 }] } }],
    { type: 'xlsx', path: 'deliverable/updated.xlsx', sheet: 'Budget', formulas: { A3: { expression: '=SUM(A1:A2)', value: 9 } }, cells: { A1: 2, A2: 7 } })
]
