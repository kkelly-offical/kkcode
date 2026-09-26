# 持久账本与产物 SDK（实验接口）

[文档导航](README.md) · 适用源码：1.1.6；[发行状态](versions.md)。移除版本后缀不取消本接口的实验边界。

本模块是 **Node 可信宿主的存储基础设施**，执行协调器另在 `sdk/runs`。
它不启动模型、不创建工作树、不提供沙箱，也不自动把普通聊天回合迁移成委托任务。
完整运行流程的实施状态见 [1.0.5 账本](implementation-1.0.5.md)。

```js
import { openRunStore, createArtifactStore } from '@kkelly-offical/kkcode/sdk/storage'

const runs = await openRunStore({ directory: '/absolute/private/run-store' })
try {
  const run = await runs.createRun({
    ownerId: 'trusted-host',
    contract: {
      objective: '检查指定候选变更',
      requiredCriteria: [{ id: 'tests', description: '冻结的测试必须针对该候选通过' }]
    }
  })
  // 宿主在动作前调用 prepareAction，完成/不确定后调用 settleAction。
  // 真正执行工具、校验授权与产物真实性属于宿主，账本不会替宿主做这些事。
  console.log(run.id, run.revision)
} finally {
  await runs.close()
}
```

## 任务状态与恢复

每次更改携带 `runId / expectedRevision / ownerId / ownerEpoch`。
返回的新记录包含最新 revision；冲突应重新读取并核查，不能重放已经执行的工具。
接管必须显式确认原拥有者、原代次、观察版本和宿主批准，接管后 pending 动作变为
unknown。存储不会仅凭超时删除拥有者或猜测外部操作没有发生。

同一逻辑 action ID 的未决重复提交被拒绝；已完成动作可以查回回执，但不是新的
执行许可。数据库超时可能已经提交，必须重新打开并按 ID 查询结果。任意外部API的
exactly-once不由此模块保证。

完成态要求非空候选指纹、至少一项必需验收、当前候选/契约代次全部通过且有证据引用，
并且没有未决动作。账本只验证结构与版本；**证据引用是否存在、测试是否真的执行、
调用者是否有权给出验收结果，必须由可信宿主验证**。不能将这些写接口直接映射为
模型工具，或把用户/模型 JSON 的 `approved:true` 当成真实审批。

`readOnly:true` 仅提供查询型TypeScript接口，存储进程也拒绝写方法。它不初始化、
迁移、更改权限或改写任务数据；SQLite可能为并发读取创建WAL/SHM协调文件。这些
不是新任务，也不应在其他进程存活时手动删除。

## 产物与权限

```js
const artifacts = createArtifactStore({ root: '/absolute/private/artifacts' })
// actor必须由已认证宿主推导，不能复制未验证的RPC参数。
const actor = { accountId: 'account', projectId: 'project', sessionId: 'session', runId: 'run' }
const artifact = await artifacts.put({
  actor, content: '实际工具输出', mime: 'text/plain',
  source: { kind: 'tool', operationId: 'operation-id' }
})
const page = await artifacts.read({ actor, id: artifact.id })
const bytes = Buffer.from(page.data, 'base64')
```

分页按字节返回base64，不会损坏图片或在中英文UTF-8边界错误截断；需要连续文本时
使用流式解码器或先拼接字节。cursor绑定产物ID及内容指纹。`search`是有界的字面量
搜索，返回字节位置；不是语义索引，也不自动发送内容给模型。

默认单文件128 MiB、同账号项目任务1 GiB、设备10 GiB。上传串行预留额度，包含崩溃
残留文件；超限不能以继续写盘方式“尽力而为”。产物默认仍被任务使用，只有宿主
确认resolved、inactive、无引用且未固定后才可删除/到期回收。删除本地证据不能
撤销已经发送给外部服务的数据。

本批目录采用有界原子JSON索引（最大32 MiB），不是已完成的SQLite目录迁移。
崩溃留下的未索引内容保留并计入容量，等待本机明确修复；不静默删除可能唯一的证据。
文件权限保护不等于静态加密，也不能防御已经控制同一OS账号的代码。

## 已接入普通会话的文本归档

本批普通工具循环已在显示截断前归档大文本，并向模型提供 `artifact_read` /
`artifact_search`。Bash 在 trim 和显示截断之前归档；原有进程捕获上限（1 MiB）、
超时、取消和沙箱语义不变。超过捕获上限或超时只保存已捕获部分，回执明确标记
“部分文本”，不声称已保存完整进程输出。其他工具若在返回前自行截断，无法由此
恢复被工具丢弃的原文。

普通会话使用宿主推导的账号/网关/组织、规范化项目路径和会话范围，跨回合可读；
普通聊天不会自动创建 RunRecord；显式委托由协调器绑定自己的任务范围。
绑定身份变更后旧内容不自动转给新账号。
工具参数只能指定不透明产物ID和分页/搜索参数，不能指定账号、根目录或文件路径。
正常工具权限、Skills限制和Agent工具白名单仍有效，归档引用不会授予执行权限。

模型通过游标按需读取；`artifact_read` 的UTF-8模式方便阅读，但任意字节边界可能
显示替代字符，base64模式保留精确原字节。压缩确定性保留宿主写入的引用索引，
不依赖摘要模型记住ID，也不把用户文本中的伪造ID当成可信引用。
`artifact_search` / `artifacts.search` 的每个匹配项包含 `readCursor`：将它作为
`artifact_read` / `artifacts.read` 的 `cursor`，即可直接读取匹配处正文，无需从
第一页逐页翻到日志末尾。搜索结果的顶层 `nextCursor` 只用于继续搜索。
这些游标仍绑定原产物ID和内容哈希，每次读取都重新验证账号、项目、会话与任务
范围；游标本身不授予访问权。模型工具会按输出预算限制匹配数量。

归档失败不会重试原工具或把已发生的操作说成失败未执行。活跃会话内容不会自动
到期删除。`artifacts.*` 与 `runs.artifacts.*` 已提供会话/任务范围远程访问，
Web/Android设置中可查看和按需下载，下载校验SHA-256，不自动运行HTML/SVG。
浏览器及Office产物经受控二进制归档进入相同权限体系。
低层SDK的保留/回收方法只能由可信宿主明确调用；普通用户不能用RPC指定另一个actor。

## CLI 巡检

```sh
kkcode runs list --json
kkcode runs show RUN_ID
kkcode runs events RUN_ID --after 0 --limit 100
```

可用 `kkcode runs --directory /absolute/private/run-store list` 指定本机账本。
不存在的账本不会因list被创建；这些命令不会启动、接管、完成或重试任务。
它们本身只巡检；确认执行使用 `runs start/resume`，任务范围与验收先于执行，
未知副作用不能靠重复resume消除。Web/Android只开放已授权任务的查看及所有者停止，
不是一个绕过本机确认的任意执行API。

## 备份、升级和历史导入

当前开发账本schema为2。schema1写打开前在写锁内建立一致性SQLite快照并核验
SHA-256，之后事务升级。只读打开不迁移；未来schema拒绝读写。旧进程的写协议/
递增代次触发器拒绝不兼容写入，不能让已经打开的旧writer继续静默修改新库。
已有零字节、空SQLite或损坏内容不能当成“新用户”重置。

```sh
kkcode runs backup create
kkcode runs backup list
kkcode runs backup verify BACKUP_ID
kkcode runs backup restore BACKUP_ID --to /absolute/new-private-directory
# 检查预览，再加 --confirm SHA256；不覆盖或自动切换活动账本。
kkcode runs migrate --source /absolute/old-sessions --backup /absolute/private-backups
# 检查来源快照、当前账号及路径后，加 --confirm SHA256 执行。
```

恢复先验证备份哈希、SQLite完整性/外键与schema，只写新的私密空目录，不覆盖已有
文件，不替用户切换生产服务。真实满盘用专用容器tmpfs验收，不填宿主磁盘。

旧会话导入先保存逐字节私密备份，再归档并创建暂停记录；稳定迁移ID可幂等重试。
来源在确认后改变则拒绝旧确认。旧压缩已经丢弃的原文无法重造，回执明确为
`source_snapshot_only`。导入没有新的合同授权，不能自动恢复历史工具调用。

维护API：`inspectStorage()` 只检查；`quarantineOrphans()` 要求本次检查token和显式
确认，将孤件可恢复隔离而非删除；`restoreQuarantined()` 恢复隔离原件。损坏的索引
不通过猜测内容来重建账号权限。隔离文件仍计入容量，不能以隔离操作逃过设备配额。
