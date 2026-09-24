import path from 'node:path'
import { lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { userRootDir } from '../storage/paths.mjs'
import { openRunStore, createArtifactStore, inspectLegacySessions, importLegacySessions, resolveMigrationBackupDirectory } from '../sdk/storage.mjs'
import { currentArtifactAccountId } from '../kernel/index.mjs'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const directoryFor = command => path.resolve(command.optsWithGlobals().directory || path.join(userRootDir(), 'run-store'))
const print = value => console.log(JSON.stringify(value, null, 2))
async function existingStore(command, write, operation) {
  const directory = directoryFor(command)
  try { await lstat(path.join(directory, 'runs.sqlite')) } catch (error) { if (error.code === 'ENOENT') throw new Error('账本尚不存在；备份/恢复命令不会创建空账本来代替丢失数据。'); throw error }
  const store = await openRunStore({ directory, readOnly: !write })
  try { return await operation(store) } finally { await store.close() }
}
export function addRunMaintenanceCommands(command) {
  const backups = command.command('backup').description('一致性备份、校验和恢复到全新目录，不覆盖活动账本')
  backups.command('create').action(async (_options, child) => existingStore(child, true, async store => print(await store.createBackup())))
  backups.command('list').action(async (_options, child) => existingStore(child, false, async store => print(await store.listBackups())))
  backups.command('verify <id>').action(async (id, _options, child) => existingStore(child, false, async store => print(await store.verifyBackup({ id }))))
  backups.command('restore <id>').requiredOption('--to <absolute-directory>', '新的私密空目录；不会覆盖现有数据')
    .option('--confirm <sha256>', '确认备份指纹与恢复目的地')
    .action(async (id, options, child) => {
      if (!path.isAbsolute(options.to)) throw new Error('恢复目的地必须是明确的绝对路径。')
      await existingStore(child, Boolean(options.confirm), async store => {
        const backup = await store.verifyBackup({ id }), destination = path.resolve(options.to)
        const confirmation = digest({ id, sha256: backup.sha256, destination })
        if (options.confirm !== confirmation) { print({ confirmationRequired: true, confirmation, backup, destination, note: '尚未恢复；确认后仅创建新目录，不切换正在运行的设备或删除原数据。' }); return }
        print(await store.restoreBackup({ id, directory: destination }))
      })
    })
  command.command('migrate').description('将旧会话快照备份并导入为暂停证据；不恢复已丢弃内容或自动执行')
    .requiredOption('--source <path>', '旧 sessions.json 或第二版分片 sessions 目录')
    .requiredOption('--backup <path>', '原会话目录之外的独立私密备份目录')
    .option('--confirm <sha256>', '确认当前账号、来源快照和备份路径')
    .action(async (options, child) => {
      const snapshot = await inspectLegacySessions(path.resolve(options.source)), backupDirectory = await resolveMigrationBackupDirectory(snapshot.source, path.resolve(options.backup))
      const directory = directoryFor(child), accountId = await currentArtifactAccountId()
      const confirmation = digest({ migrationId: snapshot.migrationId, backupDirectory, directory, accountId })
      if (options.confirm !== confirmation) { print({ confirmationRequired: true, confirmation, snapshot, backupDirectory, directory, note: '没有导入任务。原件保留，只归档来源尚存内容；所有导入任务暂停且没有执行授权。' }); return }
      const store = await openRunStore({ directory })
      try {
        print(await importLegacySessions({ source: snapshot.source, expectedMigrationId: snapshot.migrationId, backupDirectory, expectedBackupDirectory: backupDirectory, store, artifacts: createArtifactStore(),
          actor: { accountId, projectId: `migration_${digest(snapshot.source)}` }, ownerId: 'local_cli_migration' }))
      } finally { await store.close() }
    })
}
