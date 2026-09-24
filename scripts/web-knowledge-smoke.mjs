import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createDeviceServer } from '../src/device/server.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { appendMessage, flushNow, createConversationArtifactAccess, createMemoryController, openRunStore, ArtifactStore, currentArtifactAccountId } from '../src/kernel/index.mjs'
import { budgetProfileId } from '../src/storage/run-budget-profile.mjs'
import { localFreePolicyId } from '../src/storage/local-free-policy.mjs'

const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kk-web-knowledge-')))
const previousRoot = process.env.KKCODE_HOME, workspace = path.join(temporary, 'workspace')
await mkdir(workspace); process.env.KKCODE_HOME = path.join(temporary, 'state')
await mkdir(process.env.KKCODE_HOME)
await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ skills: { auto_seed: false }, mcp: { auto_discover: false } }))
await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'knowledge-fixture', scripts: { test: 'node --test' } }))
const service = await new DeviceService({ cwd: workspace, roots: [workspace] }).initialize()
const created = await service.dispatch('sessions.create', { cwd: workspace, title: 'Evidence fixture' }, { id: 'local', client: 'fixture' })
const text = `完整日志开始\n${'安全的中文输出🙂\n'.repeat(3000)}END_MARKER <script>window.UNSAFE=true</script>`
const archived = await createConversationArtifactAccess({ cwd: workspace, sessionId: created.id, turnId: 'fixture' }).put(text, 'fixture-output')
await appendMessage(created.id, 'assistant', 'Evidence fixture conversation.', { artifactRefs: [archived] }); await flushNow()
const store = await openRunStore(), accountId = await currentArtifactAccountId(), runId = 'web-task-fixture'
let task = await store.createRun({ id: runId, ownerId: 'fixture', initialState: 'waiting_input', contract: { objective: '修复仓库并独立验收', requiredCriteria: [{ id: 'tests', description: '真实测试通过' }] }, binding: { sessionId: created.id, cwd: workspace, accountId, projectId: 'web-fixture' } })
await store.configureRunBudget({ runId, expectedRevision: task.revision, ownerId: task.ownerId, ownerEpoch: task.ownerEpoch, budgetUsd: 0, deadlineAt: Date.now() + 600000, approval: { approved: true, actorId: 'fixture', reason: 'No inference UI fixture' } })
task = await store.getRun(runId)
const taskEvidence = 'TASK_EVIDENCE_WITHOUT_PRIVATE_GRANTS'
await new ArtifactStore().put({ actor: { sessionId: created.id, runId, accountId, projectId: 'web-fixture' }, content: taskEvidence, source: { kind: 'tool' } })
const server = await createDeviceServer({ service, port: 0 }), info = await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true }), failures = []
page.on('pageerror', error => failures.push(error.message))
const held = new Set()
async function holdResponse(method, condition = () => true) {
  let arrive, release, complete
  const arrived = new Promise(resolve => { arrive = resolve }), gate = new Promise(resolve => { release = resolve }), finished = new Promise(resolve => { complete = resolve })
  const handler = async route => {
    const request = route.request().postDataJSON()
    if (request?.method !== method || !condition(request.params || {})) { await route.fallback(); return }
    const response = await route.fetch(); arrive(); await gate
    try { await route.fulfill({ response }) } finally { complete() }
  }
  await page.route('**/api/v1/rpc', handler)
  const unblock = async () => { release(); held.delete(release); await finished; await page.unroute('**/api/v1/rpc', handler) }
  held.add(release); return { arrived, unblock }
}
try {
  await page.goto(info.url)
  await page.getByRole('button', { name: 'Evidence fixture', exact: true }).click()
  await page.getByRole('button', { name: '个人与设备设置' }).click()
  await page.getByRole('button', { name: '会话产物与完整日志' }).click()
  await expect(page.getByRole('button', { name: '查看内容', exact: true })).toBeVisible()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载并校验' }).click()
  assert.equal((await readFile(await (await downloaded).path())).toString('utf8'), text)
  await page.getByRole('button', { name: '查看内容', exact: true }).click()
  await expect(page.locator('.command-output')).toContainText('完整日志开始')
  const slowPage = await holdResponse('artifacts.read', params => Boolean(params.cursor))
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await slowPage.arrived
  await expect(page.getByRole('button', { name: '返回产物列表', exact: true })).toBeDisabled()
  await expect(page.getByLabel('在完整内容中搜索')).toBeDisabled()
  await slowPage.unblock()
  await expect(page.getByRole('button', { name: '返回产物列表', exact: true })).toBeEnabled()
  await page.getByLabel('在完整内容中搜索').fill('END_MARKER')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByText(/本段匹配字节位置：\d+/)).toBeVisible()
  assert.equal(await page.evaluate(() => globalThis.UNSAFE), undefined)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '个人与设备设置' }).click()
  await page.getByRole('button', { name: '记忆管理', exact: true }).click()
  const slowScope = await holdResponse('memory.list', params => params.scope === 'personal')
  await page.getByRole('button', { name: '个人偏好', exact: true }).click()
  await slowScope.arrived
  await expect(page.getByLabel('新增待确认的记忆')).toBeDisabled()
  await expect(page.getByRole('button', { name: '项目记忆', exact: true })).toBeDisabled()
  await slowScope.unblock()
  const preference = '我偏好先看测试结果，再看实现说明。'
  await page.getByLabel('新增待确认的记忆').fill(preference)
  const slowSave = await holdResponse('memory.propose')
  await page.getByRole('button', { name: '提出记忆' }).click()
  await slowSave.arrived
  await expect(page.getByLabel('新增待确认的记忆')).toBeDisabled()
  await expect(page.getByRole('button', { name: '项目记忆', exact: true })).toBeDisabled()
  const slowSavedList = await holdResponse('memory.list', params => params.scope === 'personal')
  await slowSave.unblock()
  await slowSavedList.arrived
  await expect(page.getByLabel('新增待确认的记忆')).toBeDisabled()
  await expect(page.getByText(/待确认 · v1/)).toHaveCount(0)
  await slowSavedList.unblock()
  await expect(page.getByText(/待确认 · v1/)).toBeVisible()
  assert.equal((await service.dispatch('memory.list', { scope: 'personal', includeCandidates: false }, { id: 'local', client: 'fixture' })).entries.length, 0)
  assert.equal((await createMemoryController({ cwd: workspace }).formatForPrompt()).includes(preference), false, 'unconfirmed personal preference must not enter a model prompt')
  await page.getByRole('button', { name: '确认启用', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText(preference)
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByText(/待确认 · v1/)).toBeVisible()
  await page.getByRole('button', { name: '确认启用', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByText(/已启用 · v2/)).toBeVisible()
  await page.getByRole('button', { name: '更正', exact: true }).click()
  await page.getByLabel('更正这条记忆（更正后需重新确认）').fill('我偏好简短的中文汇报。')
  await page.getByRole('button', { name: '保存更正' }).click()
  await expect(page.getByText(/待确认 · v3/)).toBeVisible()
  await page.getByRole('button', { name: '忘记', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByText('当前范围没有记忆。')).toBeVisible()
  await page.getByRole('button', { name: '项目记忆', exact: true }).click()
  await page.getByRole('button', { name: '核验项目事实' }).click()
  await expect(page.getByText(/已验证项目事实/).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '个人与设备设置' }).click()
  await page.getByRole('button', { name: '任务与验收', exact: true }).click()
  await page.getByRole('button', { name: /修复仓库并独立验收/ }).click()
  await expect(page.getByText('验收 0/1 · 失败 0 · 未知 1', { exact: true })).toBeVisible()
  await expect(page.getByText(/额度为零，不会发送新的模型请求/)).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/web-task-sheet-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.getByRole('button', { name: '查看运行记录', exact: true }).click()
  await expect(page.getByText(/任务已建立/)).toBeVisible()
  const taskDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载并校验', exact: true }).click()
  assert.equal((await readFile(await (await taskDownload).path())).toString('utf8'), taskEvidence)
  await page.getByRole('button', { name: '暂停任务', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '继续保留任务', exact: true }).click()
  assert.equal((await store.getRun(runId)).state, 'waiting_input')
  await page.getByRole('button', { name: '暂停任务', exact: true }).click()
  task = await store.transitionRun({ runId, expectedRevision: task.revision, ownerId: task.ownerId, ownerEpoch: task.ownerEpoch, state: 'waiting_approval' })
  await page.getByRole('alertdialog').getByRole('button', { name: '确认暂停', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('任务状态已经变化')
  assert.equal((await store.getRun(runId)).state, 'waiting_approval', 'stale confirmation never stops a changed task')
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await expect(page.getByText('等待审批', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '暂停任务', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认暂停', exact: true }).click()
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible()
  assert.equal((await store.getRun(runId)).state, 'paused')
  await page.getByRole('button', { name: '取消任务', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认取消', exact: true }).click()
  await expect(page.getByText('已取消', { exact: true })).toBeVisible()
  assert.equal((await store.getRun(runId)).state, 'cancelled')
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0)
  const freeId = 'web-local-free-fixture'
  let free = await store.createRun({ id: freeId, ownerId: 'fixture', initialState: 'waiting_input', contract: { objective: '本机免费额度展示', requiredCriteria: [{ id: 'tests', description: '独立检查' }] }, binding: { sessionId: created.id, cwd: workspace, accountId, projectId: 'web-fixture' } })
  const profile = { version: 1, provider: 'fixture', model: 'fixture', protocol: 'openai', scopeHash: 'e'.repeat(64), contextLimit: 1000, maxTokens: 100,
    compaction: false, rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: 'manual' }
  const policy = { version: 1, provider: profile.provider, model: profile.model, protocol: profile.protocol, scopeHash: profile.scopeHash,
    baseUrl: 'http://127.0.0.1:19877/v1', maxRequests: 5, maxTokens: 10000, listener: { pid: 1, uid: 1000, fd: 70, inode: '123', startTimeTicks: '456', executable: '/PRIVATE-LOCAL-LISTENER' } }
  const guardFree = () => ({ runId: freeId, expectedRevision: free.revision, ownerId: free.ownerId, ownerEpoch: free.ownerEpoch })
  await store.configureRunBudget({ ...guardFree(), budgetUsd: 0, deadlineAt: Date.now() + 600000,
    profiles: [{ ...profile, id: budgetProfileId(profile) }], localFreePolicy: { ...policy, id: localFreePolicyId(policy) },
    approval: { approved: true, actorId: 'fixture', reason: 'Display-only synthetic host ledger, no inference' } })
  free = await store.getRun(freeId)
  await store.reserveModelBudget({ ...guardFree(), requestId: 'free-display', amountUsd: 0, provider: profile.provider, model: profile.model, profileId: budgetProfileId(profile), tokenAllowance: 150 })
  free = await store.getRun(freeId)
  await store.settleModelBudget({ ...guardFree(), requestId: 'free-display', status: 'unknown', amountUsd: null })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '个人与设备设置' }).click()
  await page.getByRole('button', { name: '任务与验收', exact: true }).click()
  await page.getByRole('button', { name: /本机免费额度展示/ }).click()
  await expect(page.getByText(/本地免费 · 请求名额 1\/5 · 累计预留 token 150\/10,000/)).toBeVisible()
  await expect(page.getByText(/累计预留是核准的保守上界，不是实际 token 用量/)).toBeVisible()
  await expect(page.getByText(/部分调用结果待核查；即使美元费用为零/)).toBeVisible()
  await expect(page.getByText(/额度为零，不会发送新的模型请求/)).toHaveCount(0)
  assert.ok(!(await page.locator('body').textContent()).includes('/PRIVATE-LOCAL-LISTENER'))
  assert.deepEqual(failures, [])
  console.log('Web real device knowledge/task flow passed: verified artifact downloads, memory lifecycle, real SQLite run projection/events, stale owner confirmation denial, pause/cancel without implied rollback')
} finally {
  for (const release of held) release()
  await browser.close(); await server.close(); await store.close()
  if (previousRoot === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousRoot
  await rm(temporary, { recursive: true, force: true })
}
