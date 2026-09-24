import { cases as historicalCases, createManifest as buildManifest, selectCases as selectFrom, summarizeResults as summarize,
  canonical, sha256, validateCatalog } from '../v1/manifest.mjs'

// Only these five development specifications were approved for an erratum.
// Reuse every other frozen task object, especially all sealed tasks, unchanged.
export const correctedIds = Object.freeze(['R05', 'R09', 'C04', 'C05', 'C06'])
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

function clarify(task, note) {
  return { ...task, prompt: `${task.prompt}\n${note}`, fixtureFiles: { ...task.fixtureFiles,
    'CONTRACT.md': `${task.fixtureFiles['CONTRACT.md'] || `${task.title}\n\n${task.prompt}\n`}\n版本2开发勘误：${note}\n` } }
}
function outputContract(task, schema, descriptions) {
  const note = `最终阶段 result.json 的输出契约：${descriptions}\nJSON Schema（只规定结构，答案仍须从任务与实际证据获得）：${JSON.stringify(schema)}。当前阶段不必提前输出最终文件。`
  const revised = clarify(task, note)
  revised.outputSchema = schema
  revised.stages = task.stages.map((stage, index) => index === 1 ? { ...stage, prompt: `${stage.prompt}\n${note}` } : stage)
  return revised
}

export const cases = freeze(historicalCases.map(task => {
  if (task.id === 'R05') return clarify(task, '重试计数 i 从 0 开始，只在接受一个可重试状态后递增；第一次等待 min(capMs, baseMs)，第二次等待 min(capMs, baseMs * 2)。')
  if (task.id === 'R09') return clarify(task, '必须逐级迁移：v1 先执行 name→title 得到 v2，再执行 v2→v3 的 archived 缺省补齐；v2 输入只执行后一阶段；v3 保持原样。不能让 v1 直接跳过 v2→v3 规则。')
  if (task.id === 'C04') return { ...outputContract(task, { type: 'object', required: ['count'], properties: { count: { type: 'integer' } }, additionalProperties: true },
    '必须有整数 count，表示 counter.txt 的当前值；允许附加来源或证据元数据，额外字段不替代实际计数、反重复执行和原件保护检查。'), resultMatch: 'required-fields' }
  if (task.id === 'C05') return { ...outputContract(task, { type: 'object', required: ['equatorKm'], properties: { equatorKm: { type: 'integer' } }, additionalProperties: false },
    '顶层只含 equatorKm 字段，值为事实中的赤道长度（整数公里），不要另造字段名。'), protocolReplayCheck: 'bound-invocations-v2' }
  if (task.id === 'C06') return outputContract(task, { type: 'object', required: ['id', 'network', 'preserve'], properties: {
    id: { type: 'string' }, network: { type: 'boolean' }, preserve: { type: 'string' } }, additionalProperties: false },
  '顶层只含 id（要求的编号）、network（是否允许联网）、preserve（必须保留的原件文件名），不用其他键替代这三个字段。')
  return task
}))

validateCatalog(cases)
export const createManifest = () => buildManifest({ catalog: cases, suite: 'kkcode-1.0.5-60-v2', revision: 2 })
export const selectCases = options => selectFrom(options, cases)
export const summarizeResults = (results, manifest = createManifest()) => summarize(results, manifest)
export { canonical, sha256, validateCatalog }
