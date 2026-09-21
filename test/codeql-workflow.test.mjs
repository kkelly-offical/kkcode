import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'

const text = await readFile(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8')
const workflow = YAML.parse(text)
const job = workflow.jobs.analyze
const steps = job.steps
const initialization = steps.find(step => step.uses === 'github/codeql-action/init@v4')
const analysis = steps.find(step => step.uses === 'github/codeql-action/analyze@v4')
const build = steps.find(step => step.name === 'Build Android for CodeQL extraction')

test('CodeQL keeps all three languages and builds Kotlin explicitly', () => {
  assert.deepEqual(job.strategy.matrix.include, [
    { language: 'actions', 'build-mode': 'none' },
    { language: 'javascript-typescript', 'build-mode': 'none' },
    { language: 'java-kotlin', 'build-mode': 'manual' }
  ])
  assert.equal(job.strategy['fail-fast'], false)
  assert.equal(initialization.with.languages, '${{ matrix.language }}')
  assert.equal(initialization.with['build-mode'], '${{ matrix.build-mode }}')
  assert.equal(analysis.with.category, '/language:${{ matrix.language }}')
})

test('CodeQL retains default queries and the remote threat model without exclusions', () => {
  assert.deepEqual(YAML.parse(initialization.with.config), { 'disable-default-queries': false, 'threat-models': ['remote'] })
  assert.equal(initialization.with.queries, undefined)
  assert.equal(initialization.with.packs, undefined)
  assert.doesNotMatch(text, /paths-ignore|query-filters|skip-queries|continue-on-error/)
  assert.equal(analysis.with.upload, 'always')
})

test('CodeQL scans main pushes, pull requests, a weekly schedule and manual dispatches', () => {
  assert.deepEqual(workflow.on.push.branches, ['main'])
  assert.deepEqual(workflow.on.pull_request.branches, ['main'])
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'))
  assert.equal(workflow.on.schedule.length, 1)
  assert.match(workflow.on.schedule[0].cron, /^\d+ \d+ \* \* [0-6]$/)
  assert.equal(workflow.on.push.paths, undefined)
  assert.equal(workflow.on.pull_request_target, undefined)
})

test('CodeQL uses verified upstream action versions and only the required write permission', () => {
  assert.deepEqual(steps.filter(step => step.uses).map(step => step.uses), [
    'actions/checkout@v7.0.1',
    'actions/setup-java@v6.0.1',
    'gradle/actions/setup-gradle@v6.3.0',
    'github/codeql-action/init@v4',
    'github/codeql-action/analyze@v4'
  ])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(job.permissions, { contents: 'read', 'security-events': 'write' })
  assert.equal(steps[0].with['persist-credentials'], false)
  assert.doesNotMatch(text, /secrets\.|id-token:|contents: write|KKCODE_ANDROID|keytool|assembleRelease|publish|gh release/)
})

test('CodeQL pins the Android toolchain before tracing and matches project compileSdk', async () => {
  const gradleSource = await readFile(new URL('../android/app/build.gradle.kts', import.meta.url), 'utf8')
  const compileSdk = gradleSource.match(/\bcompileSdk\s*=\s*(\d+)/)?.[1]
  assert.ok(compileSdk)
  const java = steps.find(step => step.name === 'Set up Java 17')
  const gradle = steps.find(step => step.name === 'Set up pinned Gradle')
  const sdk = steps.find(step => step.name === 'Install Android SDK packages')
  assert.deepEqual(java.with, { distribution: 'temurin', 'java-version': '17' })
  assert.equal(gradle.with['gradle-version'], '8.14.3')
  assert.equal(gradle.with['cache-provider'], 'basic')
  assert.equal(gradle.with['cache-disabled'], true)
  assert.ok(sdk.run.includes(`platforms;android-${compileSdk}`))
  assert.match(sdk.run, /build-tools;35\.0\.0/)
  for (const setup of [java, gradle, sdk]) {
    assert.equal(setup.if, "matrix.language == 'java-kotlin'")
    assert.ok(steps.indexOf(setup) < steps.indexOf(initialization))
  }
})

test('CodeQL forces a real debug compilation without release credentials between init and analysis', () => {
  assert.equal(build.if, "matrix.language == 'java-kotlin'")
  assert.equal(build['working-directory'], 'android')
  assert.ok(steps.indexOf(initialization) < steps.indexOf(build))
  assert.ok(steps.indexOf(build) < steps.indexOf(analysis))
  for (const option of ['--no-daemon', '--no-build-cache', '--rerun-tasks', '-Pkotlin.incremental=false', ':app:assembleDebug', ':app:compileDebugUnitTestKotlin', ':app:assembleDebugAndroidTest']) assert.ok(build.run.includes(option), option)
  assert.equal(steps.some(step => step.uses?.includes('codeql-action/autobuild')), false)
  assert.ok(job['timeout-minutes'] >= 30)
})
