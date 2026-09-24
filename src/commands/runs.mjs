import { Command, InvalidArgumentError } from 'commander'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { userRootDir } from '../storage/paths.mjs'
import { openRunStore, RUN_STATES } from '../sdk/storage.mjs'
import { addRunExecutionCommands } from './run-execution.mjs'
import { addRunGraphCommands } from './run-graph.mjs'
import { addRunMaintenanceCommands } from './run-maintenance.mjs'
import { diagnoseRun } from '../sdk/diagnostics.mjs'

const labels = Object.freeze({ running: '运行中', waiting_input: '等待输入', waiting_approval: '等待授权', paused: '已暂停', verification_failed: '验收未通过', outcome_unknown: '操作结果待核查', cancelled: '已取消', completed: '已验收完成' })
function limit(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500) throw new InvalidArgumentError('数量必须为 1–500 的整数。')
  return Number(value)
}
function cursor(value) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('事件游标必须为非负安全整数。')
  return Number(value)
}
// Human output must not render escape sequences stored in task text.
const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')

export function createRunsCommand() {
  const command = new Command('runs').description('受控委托任务、持久状态与恢复核查')
  command.option('--directory <path>', '本机账本目录，默认设备私密 run-store 目录')
  async function inspect(child, absent, operation) {
    const directory = path.resolve(child.optsWithGlobals().directory || path.join(userRootDir(), 'run-store'))
    try { await lstat(path.join(directory, 'runs.sqlite')) } catch (error) { if (error.code === 'ENOENT') return absent(); throw error }
    const store = await openRunStore({ directory, readOnly: true })
    try { return await operation(store) } finally { await store.close() }
  }
  command.command('list').description('列出任务状态，不更改任务或接管拥有者')
    .option('--limit <n>', '最多返回数量', limit, 100)
    .option('--state <state>', `按状态筛选：${RUN_STATES.join(', ')}`)
    .option('--json', '输出结构化 JSON')
    .action(async (options, child) => {
      if (options.state && !RUN_STATES.includes(options.state)) throw new InvalidArgumentError('未知的任务状态。')
      const render = rows => {
        if (options.json) console.log(JSON.stringify(rows, null, 2))
        else if (!rows.length) console.log('暂无持久任务记录；此命令不会启动任务。')
        else for (const row of rows) console.log(`${safe(row.id)}  ${labels[row.state] || safe(row.state)}  revision=${row.revision}  owner=${safe(row.ownerId)}`)
      }
      await inspect(child, () => render([]), async store => render(await store.listRuns({ limit: options.limit, ...(options.state ? { states: [options.state] } : {}) })))
    })
  command.command('show <id>').description('查看目标、当前候选、未决操作和验收记录')
    .option('--json', '输出结构化 JSON')
    .action(async (id, options, child) => {
      await inspect(child, () => { throw new Error('持久任务账本尚不存在。') }, async store => {
        const row = await store.getRun(id)
        if (options.json) { console.log(JSON.stringify(row, null, 2)); return }
        console.log(`任务：${safe(row.id)}\n状态：${labels[row.state] || safe(row.state)}\n目标：${safe(row.contract.objective)}\n候选：${row.candidateHash || '尚未封存'}\n版本：${row.revision} / 所有者代次 ${row.ownerEpoch}`)
        if (row.budget) console.log(`预算：$${row.budget.spentUsd} 已结算 + $${row.budget.reservedUsd} 在途 + $${row.budget.unknownUsd} 待核查 / $${row.budget.budgetUsd} 上限\n期限：${new Date(row.budget.deadlineAt).toISOString()}`)
        for (const item of row.actions.filter(action => ['prepared', 'unknown'].includes(action.state))) console.log(`待核查操作：${safe(item.id)} (${safe(item.kind)})，请检查实际结果，勿盲目重试。`)
        for (const criterion of row.contract.requiredCriteria) {
          const receipt = row.verifications.filter(item => item.criterionId === criterion.id && item.candidateHash === row.candidateHash && item.contractVersion === row.contractVersion && item.candidateGeneration === row.candidateGeneration).at(-1)
          console.log(`验收 ${safe(criterion.id)}：${receipt ? safe(receipt.status) : '尚无当前版本证据'} — ${safe(criterion.description)}`)
        }
      })
    })
  command.command('events <id>').description('读取任务事件，不执行事件中的动作')
    .option('--after <seq>', '从事件游标之后读取', cursor, 0)
    .option('--limit <n>', '最多返回数量', limit, 100)
    .action(async (id, options, child) => {
      await inspect(child, () => { throw new Error('持久任务账本尚不存在。') }, async store => console.log(JSON.stringify(await store.events({ runId: id, after: options.after, limit: options.limit }), null, 2)))
    })
  addRunExecutionCommands(command)
  command.command('diagnose <id>').description('只读解释候选、验收、预算和副作用阻断；不运行或重放')
    .action(async (id, _options, child) => inspect(child, () => { throw new Error('账本尚不存在。') }, async store => console.log(JSON.stringify(await diagnoseRun({ store, runId: id }), null, 2))))
  addRunGraphCommands(command)
  addRunMaintenanceCommands(command)
  return command
}
