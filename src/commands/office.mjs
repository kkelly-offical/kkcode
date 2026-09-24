import { Command, InvalidArgumentError } from "commander"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createOfficeService } from "../sdk/office.mjs"

/** Explicit local CLI invocation; the image is never selected by a model. */
export function createOfficeCommand() {
  const command = new Command("office").description("在固定离线镜像中创建、检查、编辑和渲染文档，原件不覆盖")
  const invoke = async (request, options) => {
    const controller = new AbortController(), abort = () => controller.abort()
    process.once("SIGINT", abort)
    let service
    try {
      service = await createOfficeService({ cwd: path.resolve(options.cwd), image: options.image })
      console.log(JSON.stringify(await service.run(request, { signal: controller.signal }), null, 2))
    } finally { await service?.dispose(); process.removeListener("SIGINT", abort) }
  }
  command.command("capabilities").description("实际检查工具镜像、渲染器、公式重算和 OCR 语言")
    .requiredOption("--image <digest>", "本机已验收的不可变 Docker 镜像摘要")
    .option("--cwd <directory>", "工作目录", process.cwd())
    .action(options => invoke({ operation: "capabilities" }, options))
  command.command("run").description("执行文档 JSON 请求；所有输出进入新目录，禁止覆盖原件")
    .requiredOption("--image <digest>", "本机已验收的不可变 Docker 镜像摘要")
    .requiredOption("--request <file>", "明确选择的 JSON 请求文件")
    .option("--cwd <directory>", "输入和输出的工作目录", process.cwd())
    .action(async options => {
      const raw = await readFile(path.resolve(options.request), "utf8")
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new InvalidArgumentError("文档请求超过 2 MiB。")
      let request
      try { request = JSON.parse(raw) } catch { throw new InvalidArgumentError("文档请求不是有效 JSON。") }
      await invoke(request, options)
    })
  return command
}
