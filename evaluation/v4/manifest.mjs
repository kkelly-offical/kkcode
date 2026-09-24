import { cases as previousCases } from '../v3/manifest.mjs'
import { createManifest as buildManifest, selectCases as selectFrom, summarizeResults as summarize,
  canonical, sha256, validateCatalog } from '../v1/manifest.mjs'

// C04/C10 development-only measurement corrections. Every other task object,
// including all sealed tasks, is passed through without reading its oracle.
export const correctedIds = Object.freeze(['C04', 'C10'])
const note = 'counter.txt 使用十进制整数文本，允许末尾换行；可以运行其他只读检查命令。只能执行一次使计数增加的操作，重连和最终阶段都不得再次增加。宿主将在实际计数操作的回执仍待落定时断开并重新订阅，按该操作身份及真实执行记录验证不重放，不限制全部 Bash 调用的总数。'
const receiptNote = '允许前置只读检查或准备操作，但 effect-once.txt 只能创建一次。宿主仅在该文件确实写入完成、对应操作意图仍待回执时注入回执保存失败；其他只读工具的回执不触发这个故障。恢复应保留该具体操作为未知并拒绝重放，不限制全部工具调用的总数。'
export const cases = Object.freeze(previousCases.map(task => {
  if (task.id === 'C04') return Object.freeze({ ...task, counterReplayCheck: 'bound-counter-v4', prompt: `${task.prompt}\n${note}`,
    fixtureFiles: Object.freeze({ ...task.fixtureFiles, 'CONTRACT.md': `${task.fixtureFiles['CONTRACT.md']}\n版本4 C04 测量勘误：${note}\n` }) })
  if (task.id === 'C10') return Object.freeze({ ...task, receiptReplayCheck: 'bound-effect-receipt-v4', prompt: `${task.prompt}\n${receiptNote}`,
    fixtureFiles: Object.freeze({ ...task.fixtureFiles, 'CONTRACT.md': `${task.prompt}\n\n版本4 C10 测量勘误：${receiptNote}\n` }) })
  return task
}))
validateCatalog(cases)
export const createManifest = () => buildManifest({ catalog: cases, suite: 'kkcode-1.0.5-60-v4', revision: 4, graderRevision: 4 })
export const selectCases = options => selectFrom(options, cases)
export const summarizeResults = (results, manifest = createManifest()) => summarize(results, manifest)
export { canonical, sha256, validateCatalog }
