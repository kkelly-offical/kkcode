#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { createManifest, summarizeResults } from '../evaluation/v1/manifest.mjs'
import { runEvaluation, readResultFiles } from '../evaluation/v1/runner.mjs'
import { readEvaluationDiagnostic } from '../evaluation/v1/diagnostics.mjs'

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  live: { type: 'boolean', default: false }, case: { type: 'string', multiple: true }, split: { type: 'string', default: 'development' },
  image: { type: 'string' }, 'office-image': { type: 'string' }, output: { type: 'string' }, profile: { type: 'string' },
  'candidate-hash': { type: 'string' }, 'budget-usd': { type: 'string', default: '0' }, deadline: { type: 'string' },
  repetitions: { type: 'string', default: '1' }, 'keep-workspaces': { type: 'boolean', default: false }
} })
const command = positionals[0] || 'list'
try {
  if (command === 'list') console.log(JSON.stringify(createManifest(), null, 2))
  else if (command === 'diagnostic') console.log(JSON.stringify(await readEvaluationDiagnostic(positionals[1]), null, 2))
  else if (command === 'summarize') {
    if (!positionals[1]) throw new Error('Provide the result directory')
    console.log(JSON.stringify(summarizeResults(await readResultFiles(positionals[1])), null, 2))
  } else if (['selfcheck', 'run'].includes(command)) {
    if (command === 'run' && !values.live) throw new Error('Live execution requires explicit --live, --profile, --budget-usd and --deadline')
    if (command === 'selfcheck' && values.live) throw new Error('--live is not valid for selfcheck')
    const profile = values.profile ? JSON.parse(await readFile(values.profile, 'utf8')) : null
    const controller = new AbortController(), abort = () => controller.abort()
    process.once('SIGINT', abort)
    try {
      const result = await runEvaluation({ mode: command === 'run' ? 'live' : 'selfcheck', ids: values.case || [], split: values.split,
        repetitions: Number(values.repetitions), image: values.image, officeImage: values['office-image'], outputDirectory: values.output,
        candidateHash: values['candidate-hash'], profile, budgetUsd: Number(values['budget-usd']), deadlineAt: values.deadline ? Date.parse(values.deadline) : null,
        keepWorkspaces: values['keep-workspaces'], signal: controller.signal,
        onResult: item => console.error(`${item.caseId} #${item.repetition}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`) })
      const { perTask: _perTask, ...aggregate } = result.summary
      console.log(JSON.stringify({ output: result.output, summary: aggregate, privateEvidenceRoot: result.privateEvidenceRoot }, null, 2))
      if (result.results.some(item => ['failed', 'error'].includes(item.status))) process.exitCode = 1
    } finally { process.removeListener('SIGINT', abort) }
  } else throw new Error('Usage: node scripts/evaluate.mjs list | selfcheck | run --live | summarize <directory>')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
