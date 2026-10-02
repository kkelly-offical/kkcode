import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cell = value => String(value ?? '—').replace(/[|\r\n`]/g, ' ')
export function renderReport(state, root) {
  const rows = (state.sequence || []).map(id => {
    const result = state.results?.find(item => item.id === id)
    const status = result?.state || (state.active === id ? 'running' : 'not_run')
    const checks = result?.checks || []
    const passed = checks.filter(item => item.state === 'passed').length
    const failed = checks.filter(item => item.state === 'failed').length
    return `| ${cell(id)} | ${cell(status)} | ${cell(result?.native?.nativeStatus || result?.native?.status)} | ${passed} / ${failed} | ${cell(result?.usage?.requests)} | ${cell(result?.usage?.tokens)} |`
  })
  return [
    '# KK Code 1.0.6 串行夜间测试', '',
    `状态：${cell(state.status)}；当前案例：${cell(state.active)}。`,
    `模型调用截止：${cell(state.deadline)}（UTC）。请求与案例最大并发均为 1，付费 0。`,
    state.reason ? `停止原因：${cell(state.reason)}` : '', '',
    '| 案例 | 自动结果 | 原生终态 | 检查通过 / 失败 | 请求数 | 计账 tokens |',
    '| --- | --- | --- | --- | --- | --- |', ...rows, '',
    '人工复核待明天进行。自动检查通过不等于整体交付通过；失败和未运行分别保留。',
    'tokens 包括重复输入，未知用量按预占上界保留，不退款或清零。', '',
    `原始日志、退出与清理回执：${root}/runs/<案例>/`,
    `实时账本：${root}/private/requests.jsonl`,
    `批次状态：${root}/private/status.json`,
    `关闭回执：${root}/private/closure-receipt.json`, '',
  ].filter(line => line !== null).join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] || '')
  if (!process.argv[2]) throw Error('Provide the frozen evaluation directory')
  const state = JSON.parse(fs.readFileSync(path.join(root, 'private/status.json'), 'utf8'))
  const ledger = path.join(root, 'private/requests.jsonl')
  const records = new Map()
  if (fs.existsSync(ledger)) {
    const raw = fs.readFileSync(ledger, 'utf8')
    if (raw && !raw.endsWith('\n')) throw Error('Ledger is incomplete; inspect rather than guess usage')
    for (const line of raw.split('\n').filter(Boolean)) {
      const row = JSON.parse(line)
      records.set(row.id, { ...records.get(row.id), ...row })
    }
  }
  const usage = { requests: records.size, chargedTokens: 0, pending: 0, unknown: 0 }
  for (const row of records.values()) {
    usage.chargedTokens += row.event === 'settled' ? row.usage.total_tokens : row.reservedTokens
    if (row.event === 'reserved') usage.pending++
    if (row.event === 'unknown') usage.unknown++
  }
  console.log(renderReport(state, root))
  console.log('实时用量：' + JSON.stringify(usage))
}
