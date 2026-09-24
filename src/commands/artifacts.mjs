import { Command } from 'commander'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { ArtifactStore } from '../kernel/index.mjs'
import { userRootDir } from '../storage/paths.mjs'

/** Local terminal maintenance only. Deliberately not routed through device RPC,
 * a web principal named "local", a model tool, or an organization gateway. */
export function createArtifactsCommand() {
  const command = new Command('artifacts').description('本机产物完整性检查与可恢复隔离（不执行任务、不自动删除）')
    .option('--directory <path>', '本机私密产物目录，默认 KK Code 私密 artifacts 目录')
  const storeFor = child => new ArtifactStore({ root: path.resolve(child.optsWithGlobals().directory || path.join(userRootDir(), 'artifacts')) })
  command.command('inspect').description('检查索引、内容和孤立文件；输出可用于显式修复的快照令牌')
    .action(async (_options, child) => {
      const root = path.resolve(child.optsWithGlobals().directory || path.join(userRootDir(), 'artifacts'))
      try { await lstat(root) } catch (error) { if (error.code === 'ENOENT') { console.log(JSON.stringify({ present: false, healthy: true, issues: [] })); return }; throw error }
      console.log(JSON.stringify(await storeFor(child).inspectStorage(), null, 2))
    })
  command.command('quarantine').description('按检查令牌隔离指定孤立文件；保留恢复记录，不删除且仍计入容量')
    .requiredOption('--check-token <token>', '刚刚 inspect 返回的 checkToken')
    .requiredOption('--issue <ids...>', 'inspect 返回的 repairable 问题 ID')
    .option('--confirm', '明确确认隔离；不推定原操作结果')
    .action(async (options, child) => {
      console.log(JSON.stringify(await storeFor(child).quarantineOrphans({ checkToken: options.checkToken, issueIds: options.issue, confirmed: options.confirm === true }), null, 2))
    })
  command.command('restore <recoveryId>').description('从隔离区恢复指定文件，不覆盖现有目标')
    .option('--confirm', '明确确认恢复')
    .action(async (recoveryId, options, child) => {
      console.log(JSON.stringify(await storeFor(child).restoreQuarantined({ recoveryId, confirmed: options.confirm === true }), null, 2))
    })
  return command
}
