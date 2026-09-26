# 离线 Office、PDF 与 Markdown 工具

[文档导航](README.md) · 适用源码：1.1.6；[发行状态](versions.md)

Office 工具在用户明确配置的固定 Docker 镜像中运行。它不会安装宿主 Python／LibreOffice，不继承模型令牌、不访问网络。输入只读复制，输出经过回读、渲染与指纹核验后交付到**新目录**；已存在的文件和目录不会被覆盖。

这是明确能力子集，不是 Microsoft Office 的完整替代，也不把“成功保存文件”当作验收通过。

文件交付采用三个隔离阶段：固定搬运程序只读挂载原工作区并写入私有 job；文档解析器**只见私有 job，不挂载原工作区**；固定发布程序只读挂载 job，并将已验收文件独占写入原工作区的新目录。搬运程序在 Linux 容器内使用目录文件描述符逐级解析，每级拒绝符号链接，避免任务程序并发替换父目录时读写到工作区外；硬链接也不接受。它不是先 `realpath` 检查、再让宿主重新按可变路径读取。

该方案不依赖宿主 Linux 文件描述符，可以通过提供 Linux 容器的本机 Docker/Docker Desktop 使用。当前已经实际验收 Linux 宿主；Windows/macOS 的 Docker Desktop 真实环境仍需专项验收，不能据此宣称三平台都已验证。Docker 不可用时没有宿主执行回退。

## 支持范围

| 格式 | 可执行操作 | 实际验收 | 明确限制 |
| --- | --- | --- | --- |
| DOCX | 标题、段落、表格、提供的 PNG/JPEG；唯一文本 run 替换 | 重新打开、PDF 导出、逐页 PNG、预期文本核对 | 跨格式 run 的批量替换、修订、嵌入 OLE/ActiveX/SmartArt 不自动处理 |
| XLSX | 工作表、类型化数据、显式公式、条形/折线图、指定单元格更新 | LibreOffice 实际重算；回读公式缓存和错误值；PDF/PNG | 外部引用、宏、数据连接、透视表及未验收公式拒绝 |
| PPTX | 宽屏标题/正文、提供的图片、条形/折线图、唯一 run 替换 | 重新打开、对象边界检查、PDF/PNG、预期文本核对 | 自由复杂版式、SmartArt、OLE、多媒体不在该子集 |
| PDF | 新建、读取、合并、选页、现有 AcroForm 文本字段填充、文本便笺 | 页面数和字段/便笺回读、逐页渲染 | 不任意改写正文；拒绝加密、签名、脚本、XFA和自动外部动作 |
| Markdown | 新建、读取、唯一文本替换、基础 DOCX/PDF 导出 | UTF-8 回读；导出后渲染、文字核对 | 导出支持标题、段落、列表、代码文字与 HTTP(S) 链接；复杂 Markdown 保留为文字 |
| OCR | PDF/PNG/JPEG 的英文、简体中文识别 | Tesseract 真实识别、词级 TSV 和平均置信度 | 始终标记需复核；不把 OCR 当作原文或保证阅读顺序正确 |

`textVerified: true` 只在有预期文字且渲染文本匹配时返回。没有预期文字时是 `null`，不冒充已验证。`layout: rendered_for_review` 表示预览确实产生，不表示自动审美或复杂版式已经完全验收；需查看页面 PNG。普通 PDF 的内部跳页/初始缩放不是脚本，不因此误报。

HTTP(S) 文档来源链接不仅检查文字和 DOCX 关系，还回读 PDF 的实际 URI 注解。若固定渲染器漏掉注解，会用 PDFium 实际字符范围边框为可唯一定位的标签补齐链接，包含没有空格的中文标签；`hyperlinksVerified/repairedLinkAnnotations` 记录该过程。标签对应多个地址、定位歧义、越界或只导出部分同址链接时拒绝交付，不猜坐标，也不把纯文字冒充可点击链接。[python-docx 超链接结构](https://python-docx.readthedocs.io/en/latest/dev/analysis/features/text/hyperlink.html)、[PDFium 字符范围 API](https://pypdfium2.readthedocs.io/en/stable/python_api.html#pypdfium2.PdfTextPage.count_rects)、[LibreOffice PDF 链接说明](https://help.libreoffice.org/latest/en-GB/text/shared/01/ref_pdf_export_links.html)。

默认上限：单个输入 128 MiB、输入/输出总量各 256 MiB、输入最多 30 个、完整文档验收 40 页、每张工作表 20,000 单元格。超限返回明确错误，不用截断内容冒充完整结果。

## 准备镜像

在仓库根目录执行：

```sh
docker build -f containers/office/Dockerfile -t kkcode-office:1.0.5 .
docker image inspect kkcode-office:1.0.5 --format '{{.Id}}'
```

将第二条命令返回的完整 `sha256:…` 配置给 CLI／宿主服务。运行时拒绝 `latest` 等浮动标签，也不会隐式拉取镜像。当前开发验收只构建本机镜像，不表示已发布公共镜像。

Dockerfile 固定基础镜像摘要和主要系统组件版本；Python 依赖及其传递依赖使用精确版本＋wheel SHA-256。镜像内 `/opt/kkcode-office/os-packages.lock`、`python-packages.lock` 记录实际构建清单。系统传递包来自 Debian 签名软件源，实际发布以验收后的不可变镜像 ID 为准，不宣称跨时间重新构建必然字节一致。更换任何镜像摘要必须重新验收。

底层组件为 python-docx、openpyxl、python-pptx、pypdf、PDFium/pypdfium2、LibreOffice、Poppler、Tesseract、Pillow；依赖不是启动 CLI 就常驻的服务。许可证和版权文件保留在镜像的系统包及 Python 包目录中。

## CLI

```sh
kkcode office capabilities --image sha256:实际摘要 --cwd ./project
kkcode office run --image sha256:实际摘要 --cwd ./project --request ./report-request.json
```

`--request` 是用户明确选择的 JSON 文件，不自动扫描项目配置或下载程序。取消会停止隔离进程；失败不覆盖原件。若交付到新目录时中断，错误会提示检查该输出目录，不自动删除可能已有用户修改的内容。

DOCX 示例：

```json
{
  "operation": "create",
  "format": "docx",
  "filename": "report.docx",
  "outputDir": "deliveries/report-v1",
  "spec": {
    "title": "项目验收报告",
    "blocks": [
      {"type": "heading", "level": 1, "text": "结果"},
      {"type": "paragraph", "text": "本次交付已完成约定检查。"},
      {"type": "paragraph", "text": "参考：[Python 文档](https://docs.python.org/3/)。"},
      {"type": "table", "rows": [["检查", "结果"], ["构建", "通过"]]}
    ]
  }
}
```

XLSX 示例：

```json
{
  "operation": "create", "format": "xlsx", "filename": "budget.xlsx",
  "outputDir": "deliveries/budget-v1",
  "spec": {"sheets": [{"name": "Budget", "rows": [
    ["金额", "说明"], [2, "第一项"], [3, "第二项"],
    [{"formula": "=SUM(A2:A3)"}, "合计"]
  ]}]}
}
```

普通字符串即使以 `=` 开头也作为数据保存；只有显式 `{ "formula": "…" }` 才计算。公式子集覆盖常用求和、均值、条件、四舍五入、文本和查找函数；拒绝外部文件、DDE、WEBSERVICE 等。openpyxl 本身不计算公式，因此这里必须调用 LibreOffice 并检查缓存值。[openpyxl 公式说明](https://openpyxl.readthedocs.io/en/stable/simple_formulae.html)

编辑与 PDF 操作示例：

```json
{"operation":"edit","inputs":["source.docx"],"outputDir":"deliveries/edited","filename":"source-v2.docx","changes":{"replace":[{"find":"旧标题","replace":"新标题"}]}}
```

```json
{"operation":"fill_pdf","inputs":["form.pdf"],"outputDir":"deliveries/form-filled","fields":{"name":"KK Code"}}
```

```json
{"operation":"annotate_pdf","inputs":["report.pdf"],"outputDir":"deliveries/notes","annotations":[{"page":1,"rect":[40,40,100,90],"text":"需要复核"}]}
```

PDF 页码从 1 开始，便笺矩形为 PDF points `[左下x,左下y,右上x,右上y]`。便笺在阅读器中点击展开，不伪装成对原正文的修改。同名表单字段的 PDF 合并会拒绝，以免静默丢失字段。[pypdf 表单说明](https://pypdf.readthedocs.io/en/stable/user/forms.html)

## SDK 与模型工具

```js
import { createOfficeService } from '@kkelly-offical/kkcode/sdk/office'

const office = await createOfficeService({ cwd: '/project', image: 'sha256:实际摘要' })
try {
  const result = await office.run({ operation: 'inspect', inputs: ['report.docx'] })
  // result.content 为完整读取结果；生成操作返回 outputs、validation、输入来源指纹。
} finally {
  await office.dispose()
}
```

宿主持有经过品牌校验的 `OfficeService`，模型不能通过 JSON 自行选择镜像、注入环境变量、Python 或 Shell。`createOfficeTools()` 提供 capabilities／inspect／create／edit／render／pdf／ocr 七个适配器；必须由真实 `ctx.officeService` 提供能力。模型应先读取能力说明与限制，提交结构化请求，再依据返回的验证证据汇报。

输入与输出包含 SHA-256；生成操作返回 MIME、相对路径和验证结果。会话工具在操作前检查受控产物存储权限，从私有 job 的只读隔离进程导出二进制流，校验完整 SHA-256 后登记为 `document` 产物，返回 `outputs[].artifactRef` 和 `metadata.artifactRefs`，可供下载与跨端显示；宿主不会重新按工作区路径读取产物。单次归档的全部输出（含预览）最多 128 MiB，并受账户/存储配额约束。SDK 可用宿主持有的 `onOutput({output,content,signal})` 回调消费同样的受控字节流；CLI 默认交付本地新目录。归档失败时保留已交付目录并明确提示，不声称全部已同步。

工具不会把镜像构建成功、文件存在或 LibreOffice 的单个退出码视为完成。

## 验收与故障诊断

```sh
KKCODE_OFFICE_TEST_IMAGE=sha256:实际摘要 node --test test/office-service.test.mjs test/office-transfer.test.mjs
```

该套件用真实文件、真实隔离镜像验证中文 DOCX、公式重算、带图表 PPTX、PDF 渲染/合并/选页/表单/便笺、Markdown 导出、OCR 与多产物受控归档，并检查宏/加密拒绝、硬链接拒绝、原件不变以及真实宿主并发替换父目录的输入/输出 canary。未配置镜像时这些集成案例明确跳过，不会伪装成已做跨平台渲染验收。

出现 `office_unsupported` 时查看不支持对象清单，不要先删除文档内容以通过检查；出现 `office_validation` 时保留原件、检查渲染或计算结果；`office_conflict` 要选择新的输出目录。任何解析器异常都发生在隔离容器内，没有宿主执行回退。

实现依据：[python-docx](https://python-docx.readthedocs.io/en/stable/)、[python-pptx](https://python-pptx.readthedocs.io/en/latest/)、[LibreOffice 命令参数](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)。
