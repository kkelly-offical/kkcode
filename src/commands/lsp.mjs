import { Command, InvalidArgumentError } from 'commander'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createLanguageService } from '../sdk/lsp.mjs'

function nonnegative(value) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('位置必须为从零开始的非负整数。')
  return Number(value)
}

/** Explicit local invocation is the host grant. No auto-read of project LSP config. */
export function createLspCommand() {
  const command = new Command('lsp').description('按需只读语言诊断与符号查询（不安装语言服务器，不编辑文件）')
  command.command('inspect <file>')
    .requiredOption('--config <file>', '用户明确选择的宿主服务器 JSON 配置，不自动加载项目配置')
    .option('--operation <name>', 'diagnostics、symbols、definition 或 references', 'diagnostics')
    .option('--cwd <directory>', '工作目录', process.cwd())
    .option('--line <n>', '从零开始的行号', nonnegative)
    .option('--character <n>', 'UTF-16 字符偏移', nonnegative)
    .option('--image <digest>', '严格模式下本机已有的固定 Docker 镜像摘要')
    .option('--host', '显式使用非隔离宿主服务器，需要 --allow-host-server')
    .option('--allow-host-server', '确认该配置可以在宿主运行服务器代码；只读 LSP 不等于 OS 沙箱')
    .action(async (file, options) => {
      if (options.host && !options.allowHostServer) throw new InvalidArgumentError('宿主模式必须明确提供 --allow-host-server；否则请使用固定隔离镜像。')
      const raw = await readFile(path.resolve(options.config), 'utf8')
      if (Buffer.byteLength(raw) > 64 * 1024) throw new InvalidArgumentError('语言服务配置过大。')
      let configured
      try { configured = JSON.parse(raw) } catch { throw new InvalidArgumentError('语言服务配置不是有效 JSON。') }
      if (!configured || Object.keys(configured).some(key => key !== 'servers')) throw new InvalidArgumentError('配置只允许包含 servers 字段，不能注入环境变量或执行模式。')
      const controller = new AbortController()
      const abort = () => controller.abort()
      process.once('SIGINT', abort)
      let service
      try {
        service = await createLanguageService({ cwd: path.resolve(options.cwd), servers: configured.servers,
          mode: options.host ? 'host' : 'strict', image: options.image, authorizeStart: () => true })
        console.log(JSON.stringify(await service.inspect({ operation: options.operation, path: file, line: options.line, character: options.character, signal: controller.signal }), null, 2))
      } finally { service?.close(); process.removeListener('SIGINT', abort) }
    })
  return command
}
