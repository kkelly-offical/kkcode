import { Command } from 'commander'
import path from 'node:path'
import { userRootDir } from '../storage/paths.mjs'
import { inspectNpmEnvironment, prepareNpmEnvironment, restoreNpmEnvironment, verifyNpmEnvironment } from '../sdk/environments.mjs'

const output = value => console.log(JSON.stringify(value, null, 2))
const fail = message => { throw new Error(message) }
const storage = options => path.resolve(options.storageRoot || path.join(userRootDir(), 'dependency-environments'))
function planOptions(command) {
  return command.requiredOption('--image <digest>', '本机已有、宿主批准的不可变 Node/npm 镜像')
    .requiredOption('--registry <origin...>', '逐个批准的 HTTPS 注册表 origin，不读取 .npmrc 或登录凭据')
    .option('--cwd <path>', '带 package.json 与 npm v2/v3 lock 的项目', process.cwd())
    .option('--allow-private', '明确允许已批准 origin 的私网地址；HTTP 仅本机验收')
}
const inspect = options => inspectNpmEnvironment({ cwd: path.resolve(options.cwd), image: options.image, registryOrigins: options.registry, allowPrivate: Boolean(options.allowPrivate) })

export function createEnvironmentsCommand() {
  const command = new Command('environments').description('检查和准备宿主批准的离线只读 npm 依赖；不在原项目安装')
  planOptions(command.command('inspect').description('只读检查固定镜像与依赖清单，不下载包或运行安装脚本'))
    .action(async options => output({ prepared: false, plan: await inspect(options), note: '确认清单后使用 prepare --confirm-hash <plan.id>。安装脚本需第二次精确授权。' }))
  planOptions(command.command('prepare').description('按精确清单授权下载并断网安装；原工作区保持不变'))
    .option('--storage-root <path>', '项目外的账号私有环境库')
    .option('--confirm-hash <sha256>', '批准当前 inspect 返回的 plan.id')
    .option('--confirm-scripts <sha256>', '独立批准上一轮返回的 scriptsHash；不授予网络访问')
    .action(async options => {
      const plan = await inspect(options)
      if (!options.confirmHash) { output({ prepared: false, plan, note: '未下载。核对后加 --confirm-hash <plan.id>。' }); return }
      if (options.confirmHash !== plan.id) fail('依赖清单／镜像／来源已变化，未下载或安装。请重新 inspect 并确认当前 plan.id。')
      let scriptApproval = null
      const environment = await prepareNpmEnvironment({ plan, storageRoot: storage(options), authorize: approved => approved.id === options.confirmHash,
        authorizeScripts: approved => { scriptApproval = approved; return options.confirmScripts === approved.scriptsHash } })
      output({ environment, storageRoot: storage(options), scriptApproval,
        ...(scriptApproval ? { limitsNotice: '安装脚本断网执行，并受时间、CPU、内存、进程数及单文件大小限制；当前没有运行中的硬总磁盘／inode配额，最终总量检查不能代替硬配额。不能接受该风险时不要批准脚本。' } : {}),
        note: environment.status === 'ready'
        ? '已准备并验证只读环境；尚未启动任务。runs start 可用 --environment 指定此目录。'
        : '安装脚本尚未获批，环境不能挂载。核对 scriptApproval 后重复 prepare，并同时确认 plan.id 和 --confirm-scripts scriptsHash；会新建环境，不修改旧产物。' })
    })
  command.command('verify <directory>').description('验证私有签名、实际依赖树和当前项目清单，不执行模型')
    .requiredOption('--image <digest>', '任务将使用的不可变镜像')
    .option('--cwd <path>', '目标项目目录', process.cwd())
    .option('--storage-root <path>', '原环境所属账号私有环境库')
    .action(async (directory, options) => {
      const environment = await restoreNpmEnvironment({ directory: path.resolve(directory), storageRoot: storage(options) })
      output(await verifyNpmEnvironment({ environment, cwd: path.resolve(options.cwd), image: options.image }))
    })
  return command
}

/** Private host metadata is only a reference. Its content never substitutes for
 * the SDK's real HMAC/tree/manifests check, and it cannot grant script execution. */
export async function restoreRunEnvironment(reference, { cwd, image }) {
  if (reference === null || reference === undefined) return null
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) ||
      Object.keys(reference).some(key => !['directory', 'storageRoot', 'id', 'planId', 'treeHash'].includes(key)) ||
      !['directory', 'storageRoot', 'id', 'planId', 'treeHash'].every(key => typeof reference[key] === 'string' && reference[key])) fail('任务依赖环境引用损坏，未退回在线安装。')
  const environment = await restoreNpmEnvironment({ directory: reference.directory, storageRoot: reference.storageRoot })
  if (environment.id !== reference.id || environment.planId !== reference.planId || environment.treeHash !== reference.treeHash) fail('任务依赖环境与已批准引用不一致。请核查，不能自动替换。')
  await verifyNpmEnvironment({ environment, cwd, image })
  return environment
}

export async function inspectRunEnvironment(options, cwd) {
  if (!options.environment) {
    if (options.environmentStore) fail('--environment-store 必须与 --environment 一起使用。')
    return null
  }
  const storageRoot = storage({ storageRoot: options.environmentStore })
  const environment = await restoreNpmEnvironment({ directory: path.resolve(options.environment), storageRoot })
  await verifyNpmEnvironment({ environment, cwd, image: options.image })
  return { directory: environment.directory, storageRoot, id: environment.id, planId: environment.planId, treeHash: environment.treeHash }
}
