#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { createManifest, summarizeResults } from '../evaluation/v1/manifest.mjs'
import { runEvaluation, readResultFiles } from '../evaluation/v1/runner.mjs'
import { readEvaluationDiagnostic } from '../evaluation/v1/diagnostics.mjs'
import { readEvaluationLocalFreeBinding } from '../evaluation/v1/local-free-authorization.mjs'

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  live: { type: 'boolean', default: false }, case: { type: 'string', multiple: true }, split: { type: 'string', default: 'development' },
  image: { type: 'string' }, 'office-image': { type: 'string' }, output: { type: 'string' }, profile: { type: 'string' },
  'candidate-hash': { type: 'string' }, 'budget-usd': { type: 'string', default: '0' }, deadline: { type: 'string' },
  'local-free': { type: 'boolean', default: false }, 'request-limit': { type: 'string' }, 'token-limit': { type: 'string' },
  'local-free-binding': { type: 'string' },
  'suite-version': { type: 'string', default: 'v1' },
  repetitions: { type: 'string', default: '1' }, 'keep-workspaces': { type: 'boolean', default: false }
} })
const command = positionals[0] || 'list'
try {
  if (!['v1', 'v2'].includes(values['suite-version'])) throw new Error('Unknown evaluation suite version')
  const suite = values['suite-version'] === 'v2' ? await import('../evaluation/v2/manifest.mjs') : { createManifest, summarizeResults }
  if (command === 'list') console.log(JSON.stringify(suite.createManifest(), null, 2))
  else if (command === 'diagnostic') console.log(JSON.stringify(await readEvaluationDiagnostic(positionals[1]), null, 2))
  else if (command === 'summarize') {
    if (!positionals[1]) throw new Error('Provide the result directory')
    console.log(JSON.stringify(suite.summarizeResults(await readResultFiles(positionals[1])), null, 2))
  } else if (['selfcheck', 'run'].includes(command)) {
    if (command === 'run' && !values.live) throw new Error('Live execution requires explicit --live, --profile, --deadline and either paid budget or bounded --local-free authorization')
    if (command === 'selfcheck' && values.live) throw new Error('--live is not valid for selfcheck')
    if (!values['local-free'] && (values['request-limit'] !== undefined || values['token-limit'] !== undefined || values['local-free-binding'] !== undefined)) throw new Error('Request/token suite limits and prior service bindings require explicit --local-free')
    const profile = values.profile ? JSON.parse(await readFile(values.profile, 'utf8')) : null
    const expectedLocalFreePolicy = values['local-free-binding'] ? await readEvaluationLocalFreeBinding(values['local-free-binding']) : null
    const controller = new AbortController(), abort = () => controller.abort()
    process.once('SIGINT', abort)
    try {
      const result = await runEvaluation({ mode: command === 'run' ? 'live' : 'selfcheck', ids: values.case || [], split: values.split,
        suiteVersion: values['suite-version'],
        repetitions: Number(values.repetitions), image: values.image, officeImage: values['office-image'], outputDirectory: values.output,
        candidateHash: values['candidate-hash'], profile, budgetUsd: Number(values['budget-usd']), deadlineAt: values.deadline ? Date.parse(values.deadline) : null,
        localFreeLimits: values['local-free'] ? { requestLimit: Number(values['request-limit']), tokenLimit: Number(values['token-limit']) } : null,
        expectedLocalFreePolicy,
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
