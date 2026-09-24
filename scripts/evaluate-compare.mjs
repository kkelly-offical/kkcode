#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { compareEvaluationReceipts, readEvaluationComparisonBundle } from '../evaluation/v1/compare.mjs'

try {
  const { values } = parseArgs({ options: { left: { type: 'string' }, right: { type: 'string' }, 'left-context': { type: 'string' }, 'right-context': { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
  if (values.help) process.stdout.write('只读评测回执A/B比较（不启动模型）\nnode scripts/evaluate-compare.mjs --left <private-results-A> --right <private-results-B> [--left-context <private-json>] [--right-context <private-json>]\n退出码：0 可比观察；2 不可比/不完整；1 输入损坏或不安全。未比较原始prompt、token正文或sealed oracle。\n')
  else {
    if (!values.left || !values.right) throw Object.assign(new Error(), { code: 'COMPARE_ARGUMENTS_REQUIRED' })
    const left = await readEvaluationComparisonBundle(values.left, { contextFile: values['left-context'] }), right = await readEvaluationComparisonBundle(values.right, { contextFile: values['right-context'] })
    const report = compareEvaluationReceipts(left, right)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.recordedConfigurationComparable) process.exitCode = 2
  }
} catch (error) {
  const code = /^COMPARE_[A-Z_]+$/.test(error?.code || '') ? error.code : 'COMPARE_INPUT_UNAVAILABLE'
  process.stdout.write(`${JSON.stringify({ schema: 'kk.evaluation.comparison.v1', recordedConfigurationComparable: false, experimentVerified: false, fullABGateSatisfied: false, code, message: '输入无法安全核验；未产生优劣结论，未回显私密路径或原始错误。' })}\n`)
  process.exitCode = 1
}
