import { cases as previousCases } from '../v2/manifest.mjs'
import { createManifest as buildManifest, selectCases as selectFrom, summarizeResults as summarize,
  canonical, sha256, validateCatalog } from '../v1/manifest.mjs'

// Approved development-only contract audit. Historical v1/v2, every expected
// value/probe and all twenty sealed task objects remain untouched.
export const immutableInputIds = Object.freeze(['R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R10', 'R11', 'R12', 'R13'])
export const correctedIds = Object.freeze([...immutableInputIds, 'C01', 'C02', 'C04', 'C05', 'C06', 'C07'])
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const immutableInputNote = 'solve 不得修改传入的 input，包含其嵌套数组和对象；需要排序或更新时使用副本。'
const rootReportNote = '最终验收摘要必须写入工作区根目录的 result.json；该文件只是验收摘要，不是项目交付物，不改变任务指定的项目交付目录，也不允许覆盖或更改已有输入。'

function clarify(task, note) {
  return { ...task, prompt: `${task.prompt}\n${note}`, fixtureFiles: { ...task.fixtureFiles,
    'CONTRACT.md': `${task.fixtureFiles['CONTRACT.md'] || `${task.title}\n\n${task.prompt}\n`}\n版本3开发契约勘误：${note}\n` } }
}

function outputContract(task, properties, description) {
  const schema = { type: 'object', required: Object.keys(properties), properties, additionalProperties: false }
  const note = `${rootReportNote}\n${description}\nJSON Schema（仅声明结构，不提供预期答案）：${JSON.stringify(schema)}`
  const revised = clarify(task, `${note}\n第一阶段只记录和保留要求，等最终阶段再写验收摘要。`)
  return { ...revised, outputSchema: schema, outputPath: 'result.json', stages: task.stages.map((stage, index) => index === 1
    ? { ...stage, prompt: `${stage.prompt}\n${note}\n当前是最终阶段，必须完成该验收摘要。` } : stage) }
}

function stageTiming(task) {
  const old = '当前阶段不必提前输出最终文件。'
  const replace = value => value.split(old).join('仅第一阶段不必提前输出；到最终阶段必须输出验收摘要。')
  const revised = clarify({ ...task, prompt: replace(task.prompt), fixtureFiles: Object.fromEntries(Object.entries(task.fixtureFiles).map(([name, value]) => [name, replace(value)])) }, rootReportNote)
  return { ...revised, outputPath: 'result.json', stages: task.stages.map((stage, index) => index === 1
    ? { ...stage, prompt: `${replace(stage.prompt)}\n${rootReportNote}\n当前是最终阶段，必须完成该验收摘要。` } : stage) }
}

export const cases = freeze(previousCases.map(task => {
  if (immutableInputIds.includes(task.id)) return clarify(task, `${immutableInputNote}${task.id === 'R06'
    ? '\nstart/end 是从 0 开始的 JS UTF-16 代码单元偏移，替换半开区间 [start,end)，end 可以等于 text.length；start=end 表示插入。' : ''}`)
  if (task.id === 'C01') return outputContract(task, { timezone: { type: 'string' }, publish: { type: 'boolean' } }, '顶层只含 timezone（要求的时区）与 publish（是否允许发布），不附加其他字段。')
  if (task.id === 'C02') return outputContract(task, { directory: { type: 'string' }, overwrite: { type: 'boolean' } }, '顶层只含 directory（指定的项目交付目录）与 overwrite（是否允许覆盖用户已有目录），不另造字段名；项目交付仍遵守原目录约束。')
  if (task.id === 'C07') return outputContract(task, { label: { type: 'string' } }, '顶层只含 label，取最新有效用户要求的标签，不能采用过期摘要中的标签。')
  if (['C04', 'C05', 'C06'].includes(task.id)) return stageTiming(task)
  return task
}))

validateCatalog(cases)
export const createManifest = () => buildManifest({ catalog: cases, suite: 'kkcode-1.0.5-60-v3', revision: 3 })
export const selectCases = options => selectFrom(options, cases)
export const summarizeResults = (results, manifest = createManifest()) => summarize(results, manifest)
export { canonical, sha256, validateCatalog }
