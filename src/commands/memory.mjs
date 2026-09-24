import { Command, InvalidArgumentError } from 'commander'
import { createInterface } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createMemoryController } from '../sdk/memory.mjs'

const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
const scopes = value => { if (!['project', 'personal'].includes(value)) throw new InvalidArgumentError('范围必须为 project 或 personal。'); return value }
const version = value => { const number = Number(value); if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw new InvalidArgumentError('版本必须为正整数，请先 memory show。'); return number }

export async function confirmMemoryInTerminal(request) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return { approved: false }
  const phrase = request.entry ? `${request.entry.id}@${request.entry.version}` : `IMPORT ${request.source}`
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    process.stderr.write(`\n记忆操作：${safe(request.action)} / ${safe(request.scope)}\n`)
    if (request.entry) process.stderr.write(`${safe(request.entry.text)}\n`)
    if (request.message) process.stderr.write(`${safe(request.message)}\n`)
    const answer = await terminal.question(`确认请输入 ${phrase}；其他输入取消：`)
    return { approved: answer.trim() === phrase, confirmedBy: 'local-terminal-user', approvalId: `memory-cli-${randomUUID()}` }
  } catch { return { approved: false } }
  finally { terminal.close() }
}

/** Optional callback injection is for a trusted host/test, never CLI JSON. */
export function createMemoryCommand({ confirmMemory = confirmMemoryInTerminal } = {}) {
  const command = new Command('memory').description('管理有来源、按项目与账号隔离的记忆')
    .option('--cwd <path>', '项目工作目录')
    .option('--scope <scope>', 'project 或 personal', scopes, 'project')
    .option('--json', '输出结构化 JSON')
  const controller = child => createMemoryController({ cwd: path.resolve(child.optsWithGlobals().cwd || process.cwd()), confirmMemory })
  const options = child => child.optsWithGlobals()
  function render(value, child) {
    if (options(child).json) { console.log(JSON.stringify(value, null, 2)); return }
    if (value.entries) {
      if (!value.entries.length) console.log('当前范围暂无记忆。')
      else for (const entry of value.entries) console.log(`${safe(entry.id)} v${entry.version} [${safe(entry.status)}] ${safe(entry.text)}`)
      if (value.activated === 0) console.log('导入仅创建候选；逐条确认后才会注入对话。')
    } else if (value.id && value.text) console.log(`${safe(value.id)} v${value.version} [${safe(value.status)}]\n${safe(value.text)}\n来源：${JSON.stringify(value.evidence)}`)
    else console.log(JSON.stringify(value, null, 2))
  }
  command.command('list').description('查看当前范围内候选、有效、禁用及过期记忆').action(async (_opts, child) => render(await controller(child).list({ scope: options(child).scope }), child))
  command.command('show <id>').description('查看记忆版本与来源').action(async (id, _opts, child) => render(await controller(child).get({ scope: options(child).scope, id }), child))
  command.command('propose <text>').description('创建候选，不自动激活').option('--category <category>', 'project-fact / workflow / preference', 'workflow')
    .action(async (text, opts, child) => render(await controller(child).propose({ scope: options(child).scope, text, category: opts.category }), child))
  command.command('correct <id> <text>').description('纠正后创建待确认的新版本').requiredOption('--version <n>', '当前版本号', version)
    .action(async (id, text, opts, child) => render(await controller(child).correct({ scope: options(child).scope, id, expectedVersion: opts.version, text }), child))
  for (const action of ['confirm', 'enable', 'disable', 'forget']) {
    command.command(`${action} <id>`).description({ confirm: '经真实终端确认后激活', enable: '经真实终端确认后重新启用', disable: '停止注入但保留记录', forget: '确认遗忘正文及其版本记录' }[action])
      .requiredOption('--version <n>', '当前版本号', version)
      .action(async (id, opts, child) => {
        const memory = controller(child), params = { scope: options(child).scope, id, expectedVersion: opts.version }
        if (action === 'confirm') return render(await memory.confirm(params), child)
        if (action === 'forget') {
          const entry = await memory.get(params)
          if (entry.version !== params.expectedVersion) throw new Error('记忆已更新，请刷新后重试。')
          if ((await confirmMemory({ action: 'memory.forget', scope: params.scope, entry, message: '遗忘后不自动恢复；旧原始文件和用户自行备份不会被删除。' }))?.approved !== true) throw new Error('用户未确认，记忆未删除。')
          return render(await memory.forget(params), child)
        }
        render(await memory.setEnabled({ ...params, enabled: action === 'enable' }), child)
      })
  }
  command.command('observe').description('核验当前 package.json 的限定结构事实，不运行模型或脚本').action(async (_opts, child) => {
    if (options(child).scope !== 'project') throw new Error('自动项目观察不能创建个人偏好。')
    render(await controller(child).observeProject(), child)
  })
  command.command('legacy').description('查看保留的旧记忆来源，不读取正文').action(async (_opts, child) => render(await controller(child).legacySources(), child))
  command.command('import <source>').description('真实终端确认后导入 auto-memory / instincts / project-memory 为候选').action(async (source, _opts, child) => {
    if (options(child).scope !== 'project') throw new Error('旧项目笔记只能先导入项目候选。')
    render(await controller(child).importLegacy({ source }), child)
  })
  return command
}
