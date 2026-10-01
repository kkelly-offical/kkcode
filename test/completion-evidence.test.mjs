import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyVerificationCommand, evaluateCompletionEvidence } from '../src/kernel/session/completion-evidence.mjs'
import { TaskValidator } from '../src/kernel/session/task-validator.mjs'

const edit = (file = 'src/index.mjs', extra = {}) => ({ name: 'edit', args: { path: file }, status: 'completed', ok: true, ...extra })
const shell = (command, extra = {}) => ({ name: 'bash', args: { command }, status: 'completed', ok: true, metadata: { exitCode: 0, started: true }, ...extra })
const report = toolEvents => evaluateCompletionEvidence({ todoState: [], toolEvents })

test('pure questions and cancelled todos remain nonblocking but explicitly not verified', () => {
  const result = evaluateCompletionEvidence({ todoState: { items: [{ status: 'cancelled' }] }, toolEvents: [{ name: 'read', status: 'completed', output: 'Tests passed!' }] })
  assert.equal(result.passed, true)
  assert.equal(result.state, 'not_verified')
  assert.equal(result.verdict, 'NO_BLOCKING_TODO')
  assert.match(result.message, /not proof that tests passed/)
})

test('Chinese completion messages explain observed and blocking states while retaining machine codes', () => {
  const options = {language: 'zh'}
  const pending = evaluateCompletionEvidence({...options, toolEvents: [edit()]})
  assert.match(pending.message, /修改后尚无有效检查/)
  assert.match(pending.message, /checks_required/)
  assert.equal(pending.failures.at(-1).kind, 'checks_required')
  const observed = evaluateCompletionEvidence({...options, toolEvents: [edit(), shell('npm test')]})
  assert.equal(observed.state, 'checks_observed')
  assert.match(observed.message, /不是完整语义验收/)
  assert.match(evaluateCompletionEvidence({...options, toolEvents: []}).message, /空待办不表示测试通过/)
})

for (const status of ['pending', 'blocked', 'in_progress']) test(`current ${status} todo blocks even after successful checks`, () => {
  const result = evaluateCompletionEvidence({ todoState: { items: [{ status, content: 'current plan' }] }, toolEvents: [shell('npm test')] })
  assert.equal(result.passed, false)
  assert.equal(result.state, 'work_remaining')
})

test('real edits require a later successful structured check, not old output or an echo', () => {
  for (const events of [[edit()], [shell('npm test'), edit()], [edit(), shell('echo passed')], [edit(), shell('echo "npm test passed"')], [edit(), shell('npm test', { metadata: {} })], [edit(), shell('npm test', { metadata: { exitCode: 0, started: false } })]]) {
    assert.equal(report(events).passed, false, JSON.stringify(events))
  }
  const good = report([edit(), shell('npm test')])
  assert.equal(good.passed, true)
  assert.equal(good.state, 'checks_observed')
  assert.match(good.message, /not full semantic acceptance/)
})

for (const command of ['npm test', 'npm run build', 'pnpm lint', 'yarn run typecheck', 'bun test', 'npm run test:unit', 'go test ./...', 'go vet ./...', 'go build ./...', 'cargo test', 'cargo check', 'cargo clippy', 'cargo build', 'python -m pytest -q', 'python3 -m compileall src', 'node --test test/example.test.mjs', 'node --check src/index.mjs', 'tsc --noEmit', './node_modules/.bin/tsc --noEmit', 'pytest -v tests/', 'npx --no-install playwright test', 'pnpm exec tsc --noEmit', 'cd packages/api && CI=1 npm test && npm run lint', 'env CI=1 npm test']) {
  test(`observes genuine successful check command: ${command}`, () => {
    assert.ok(classifyVerificationCommand(command))
    assert.equal(report([edit(), shell(command)]).state, 'checks_observed')
  })
}

for (const command of ['npm test; true', 'npm test || true', 'npm test | cat', '(npm test)', 'npm test &', 'npm test &&', 'npm test && && true', 'npm test > proof.txt', 'npm test 2>/dev/null', 'npm test $(echo --help)', 'echo "npm test"', 'node script.mjs --test', 'node --eval="console.log(1)" --test', 'node --check', 'tsc --init', 'vitest list', 'go test -list .', 'go build -n', 'pytest --fixtures', 'pytest --co', 'pytest --setup-plan', 'pytest --setup-only', 'tsc --listFilesOnly', 'eslint --print-config src/index.mjs', 'npm test --if-present', 'npm test -- --passWithNoTests', 'pytest --collect-only', 'npm run lint:fix', 'npm run lint -- --fix=true', 'npx --yes tsc', 'PATH=/untrusted npm test']) {
  test(`does not treat ambiguous or non-check expression as verification: ${command}`, () => {
    assert.equal(classifyVerificationCommand(command), null)
    assert.equal(report([edit(), shell(command)]).passed, false)
  })
}

test('failed or masked checks remain unresolved after unrelated success and clear only with matching success', () => {
  for (const failed of [shell('npm test', { status: 'error', ok: false, metadata: { exitCode: 1 } }), shell('npm test || true'), shell('npm test; true')]) {
    assert.equal(report([edit(), failed, shell('npm run lint')]).passed, false)
    assert.equal(report([edit(), failed, shell('npm test')]).passed, true)
  }
  const failed = shell('npm test', { status: 'error', ok: false, metadata: { exitCode: 1 } })
  assert.equal(report([failed, edit(), shell('npm run lint')]).passed, false, 'a repair plus unrelated check does not prove the failed test was fixed')
  assert.equal(report([failed, edit(), shell('npm test')]).passed, true)
})

test('failed check identity retains arguments, directory and environment', () => {
  const failed = shell('npm test -- one.test.mjs', { status: 'error', ok: false, metadata: { exitCode: 1 } })
  assert.equal(report([edit(), failed, shell('npm test -- two.test.mjs')]).passed, false)
  assert.equal(report([edit(), shell('CI=0 npm test', { status: 'error', metadata: { exitCode: 1 } }), shell('CI=1 npm test')]).passed, false)
  assert.equal(report([edit(), shell('cd a && npm test', { status: 'error', metadata: { exitCode: 1 } }), shell('cd b && npm test')]).passed, false)
})

test('successful && sequence can resolve its individual failed checks but not a different failed chain', () => {
  const failed = command => shell(command, { status: 'error', ok: false, metadata: { exitCode: 1 } })
  assert.equal(report([edit(), failed('npm test'), shell('npm test && npm run lint')]).passed, true)
  assert.equal(report([edit(), failed('npm test && npm run lint'), shell('npm test')]).passed, false)
  assert.equal(report([edit(), failed('npm test && npm run lint'), shell('npm test && npm run lint')]).passed, true)
})

test('documentation-only edits may use git diff --check; code and unknown paths may not', () => {
  assert.equal(report([edit('README.md'), shell('git diff --check')]).passed, true)
  assert.equal(report([edit(), shell('git diff --check')]).passed, false)
  assert.equal(report([edit('README.md'), edit('src/index.mjs'), shell('git diff --check')]).passed, false)
})

test('unknown side effects and process lifecycle failures never become success through later green output', () => {
  for (const metadata of [{ outcomeUnknown: true }, { terminationIncomplete: true }]) {
    const result = report([edit('x.mjs', { metadata }), shell('npm test')])
    assert.equal(result.passed, false)
    assert.equal(result.state, 'outcome_unknown')
  }
  for (const metadata of [{ exitCode: 1 }, { exitCode: 0, timedOut: true }, { exitCode: 0, cancelled: true }, { exitCode: 0, captureIncomplete: true }]) {
    assert.equal(report([edit(), shell('npm test', { metadata })]).passed, false)
  }
})

test('failed edits can be repaired but successful checks alone do not turn them into completed edits', () => {
  const failed = edit('x.mjs', { status: 'error', ok: false })
  assert.equal(report([failed, shell('npm test')]).passed, false)
  assert.equal(report([failed, edit('x.mjs'), shell('npm test')]).passed, true)
})

test('public evidence is bounded and does not copy arbitrary outputs, arguments or secret environment values', () => {
  const result = report([edit(), ...Array.from({ length: 30 }, () => shell('CI=private-fixture-value npm test', { output: 'secret-result-body'.repeat(10000) }))])
  assert.equal(result.checks.length, 20)
  assert.ok(JSON.stringify(result).length < 8000)
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-value|secret-result-body/)
})

test('TaskValidator evidence path consumes the same guard without launching project commands', async () => {
  const validator = new TaskValidator({ cwd: process.cwd(), configState: {} })
  for (const name of ['checkJavaScriptSyntax', 'checkTypeScript', 'runTests', 'checkBuild', 'checkLint']) validator[name] = () => { throw new Error('implicit command forbidden') }
  assert.equal((await validator.validate({ todoState: [], toolEvents: [edit()], level: 'evidence' })).passed, false)
  assert.equal((await validator.validate({ todoState: [], toolEvents: [edit(), shell('node --test')], level: 'evidence' })).state, 'checks_observed')
  assert.equal(evaluateCompletionEvidence({ requireChecks: true }).passed, false)
})

test('per-tool environment cannot spoof npm test through PATH or runtime preload routing', () => {
  for (const env of [{ PATH: '/private/fake-bin' }, { NODE_OPTIONS: '--import private-loader.mjs' }, { LD_PRELOAD: 'private-library' }, { npm_config_ignore_scripts: 'true' }]) {
    assert.equal(classifyVerificationCommand('npm test', { env }), null)
    const attempted = shell('npm test', { args: { command: 'npm test', env } })
    assert.equal(report([edit(), attempted]).passed, false)
    assert.equal(report([edit(), attempted, shell('npm test')]).passed, true, 'a fresh ordinary foreground check can verify the prior environment-dependent work')
  }
})

test('safe per-tool environments are hashed into check identity without exposing values', () => {
  const env = { CI: 'sensitive-fixture-value', NODE_ENV: 'test' }
  const classified = classifyVerificationCommand('npm test', { env })
  assert.ok(classified)
  assert.equal(classified.id, classifyVerificationCommand('npm test', { env: { NODE_ENV: 'test', CI: 'sensitive-fixture-value' } }).id)
  assert.notEqual(classified.id, classifyVerificationCommand('npm test', { env: { ...env, CI: 'different-value' } }).id)
  assert.equal(classifyVerificationCommand('CI=1 npm test').id, classifyVerificationCommand('npm test', { env: { CI: '1' } }).id)
  assert.doesNotMatch(JSON.stringify(classified), /sensitive-fixture-value/)
  const failed = shell('npm test', { args: { command: 'npm test', env }, status: 'error', metadata: { exitCode: 1 } })
  assert.equal(report([edit(), failed, shell('npm test')]).passed, false)
  assert.equal(report([edit(), failed, shell('npm test', { args: { command: 'npm test', env } })]).passed, true)
})

test('shell glob expansion cannot smuggle unobserved check arguments', () => {
  for (const command of ['npm test *', 'npm test ?', 'npm test [ab]', 'node --test test/*.mjs']) assert.equal(classifyVerificationCommand(command), null)
  assert.ok(classifyVerificationCommand("npm test -- 'literal*pattern'"))
})

test('background environment uncertainty requires a fresh foreground check without inventing a failed check identity', () => {
  const background = shell('npm test', { metadata: { exitCode: 0, started: true, verificationEnvUnknown: true } })
  assert.equal(report([background]).passed, false)
  assert.equal(report([background, shell('npm test')]).passed, true)
})
