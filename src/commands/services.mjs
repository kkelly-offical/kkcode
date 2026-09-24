import { Command } from 'commander'
import path from 'node:path'
import { readHostServices, readHostServicesFile, hostServicesHash, configureHostServices } from '../kernel/index.mjs'

export function createServicesCommand() {
  const command = new Command('services').description('配置账号私有的隔离 Office/LSP 服务，不读取项目服务配置')
  command.command('status').action(async () => {
    const configuration = await readHostServices()
    console.log(JSON.stringify({ configuration, hash: hostServicesHash(configuration), readiness: '配置记录；镜像与实际能力请用 office capabilities / lsp inspect 验收' }, null, 2))
  })
  command.command('configure').requiredOption('--file <path>', '明确选取的服务 JSON 文件，schemaVersion=1')
    .option('--confirm-hash <sha256>', '核查首次预览输出后确认精确配置')
    .action(async options => {
      const configuration = await readHostServicesFile(path.resolve(options.file)), hash = hostServicesHash(configuration)
      if (!options.confirmHash) { console.log(JSON.stringify({ confirmationRequired: true, configuration, hash, note: '未保存、未启动服务。确认镜像及程序后用同一 --file 加 --confirm-hash 执行；配置只对新内核生效。' }, null, 2)); return }
      console.log(JSON.stringify(await configureHostServices(configuration, options.confirmHash), null, 2))
    })
  return command
}
