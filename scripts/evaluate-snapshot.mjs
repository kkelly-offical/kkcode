#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { freezeEvaluationRuntime } from '../evaluation/v1/snapshot.mjs'

const { values } = parseArgs({ options: { source: { type: 'string' }, parent: { type: 'string' }, base: { type: 'string', default: 'HEAD' } } })
try {
  const result = await freezeEvaluationRuntime({ source: values.source, parent: values.parent, baseRevision: values.base })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({ error: error.message, ...(error.snapshotDirectory ? { preservedSnapshot: error.snapshotDirectory } : {}) }))
  process.exitCode = 1
}
