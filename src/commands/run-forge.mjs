import { createHash } from 'node:crypto'
import { open, lstat, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { userRootDir } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { openRunStore } from '../sdk/storage.mjs'
import { validateAction } from '../storage/run-store-contracts.mjs'
import { currentArtifactAccountId } from '../kernel/index.mjs'
import { parseForgeRemote, createForgeClient, createForgeDelivery, createRunForgeDelivery, createForgeReconciler } from '../sdk/forge.mjs'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reject = message => { throw new Error(message) }
const actions = { push: ['forge.push', 'pushCandidate'], draft: ['forge.draft.create', 'openDraft'], update: ['forge.draft.update', 'updateDraft'], comment: ['forge.comment', 'postComment'], ready: ['forge.ready', 'markReady'] }
const attemptFile = (id, actionId) => path.join(userRootDir(), 'run-hosts', 'forge-actions', `${digest([id, actionId])}.json`)
async function readBounded(filename, maximum) {
  const target = path.resolve(filename), before = await lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) reject('交付输入必须为大小受限的普通独立文件。')
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size > maximum) reject('交付文件在打开时发生变化。')
    const bytes = Buffer.alloc(maximum + 1); let size = 0
    while (size < bytes.length) { const next = await handle.read(bytes, size, bytes.length - size, size); if (!next.bytesRead) break; size += next.bytesRead }
    const after = await handle.stat()
    if (size > maximum || size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) reject('交付文件超过限制或在读取时变化。')
    return bytes.subarray(0, size)
  } finally { await handle.close() }
}
async function jsonFile(filename) {
  const body = await readBounded(filename, 1024 * 1024)
  return JSON.parse(body.toString('utf8'))
}
function tokenFrom(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '') || !process.env[name]) reject('请用 --token-env 指向本次宿主环境中已有的 Forge 令牌；令牌不会写入交付资料。')
  return process.env[name]
}
const print = value => console.log(JSON.stringify(value, null, 2))

/** Real host CLI only; these confirmation hashes are not a model-facing tool. */
export function addRunForgeCommands(parent, { hostFor, metaFile }) {
  const command = parent.command('forge').description('固定已验收候选的 GitHub PR／GitLab MR 交付；不会自动合并或发布')
  const common = child => child.requiredOption('--token-env <name>', '宿主令牌环境变量名（不要填写令牌本身）').option('--confirm <sha256>', '确认当前任务版本和本次精确交付操作').option('--trust', '允许源项目模型配置（交付命令不会运行模型）')
  async function load(id, child) {
    const meta = await jsonFile(metaFile(id))
    if (meta.schema !== 'kk.run-host.v1' || meta.runId !== id || !meta.actor || !meta.acceptance) reject('任务宿主资料不完整，请先核查。')
    const directory = path.resolve(child.optsWithGlobals().directory || path.join(userRootDir(), 'run-store'))
    const reader = await openRunStore({ directory, readOnly: true })
    try {
      const run = await reader.getRun(id)
      if (meta.actor.accountId !== await currentArtifactAccountId() || run.binding?.accountId !== meta.actor.accountId || run.binding?.projectId !== meta.actor.projectId || path.resolve(run.binding.cwd) !== path.resolve(meta.workspace)) reject('交付任务不属于当前账号、项目或工作区。')
      return { meta, directory, run }
    } finally { await reader.close() }
  }
  function confirm(options, run, plan) {
    const confirmation = digest({ runId: run.id, revision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, candidateHash: run.candidateHash, plan })
    if (options.confirm !== confirmation) { print({ executed: false, confirmation, instruction: plan.action === 'inspect'
      ? '核对准确 API 来源、私网范围、交付契约、编号和令牌变量名，再追加 --confirm 此摘要。确认后会向该来源发送认证令牌；本次仅只读查询，不写账本。'
      : '核对仓库、分支、候选和文本后，原命令追加 --confirm 此摘要。未知结果请保留同一 action-id 进行核查，不要换 ID 重发。', plan }); return null }
    return confirmation
  }
  function observed(run) { return { revision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, candidateHash: run.candidateHash } }
  common(command.command('prepare <id>').description('确认后封存 Git 候选并保存交付绑定；不会推送')
    .requiredOption('--repository <url>', '明确批准的仓库 HTTPS／Git SSH URL')
    .option('--kind <kind>', '自托管仓库必填 github 或 gitlab').option('--api-base <url>', '同源 Forge API 地址')
    .requiredOption('--source-branch <branch>', '任务分支（不能等于目标分支）').requiredOption('--target-branch <branch>', '目标分支')
    .requiredOption('--target-sha <sha>', '已核对的目标分支完整 SHA；变化后需重新验收')
    .option('--candidate-sha <sha>', '恢复已有候选 SHA；省略时生成独立候选，不改变 HEAD／暂存区')
    .option('--checks <file>', '必需 CI 检查 JSON 数组；未配置不能标记 ready')
    .option('--approvals <n>', '必需人工审查数量', '1').option('--allow-private', '宿主明确允许私有 Forge 地址（不允许云元数据）'))
    .action(async (id, options, child) => {
      const { meta, run, directory } = await load(id, child)
      const repository = parseForgeRemote(options.repository, { kind: options.kind, apiBase: options.apiBase })
      const settings = { repository, sourceBranch: options.sourceBranch, targetBranch: options.targetBranch, targetSha: options.targetSha,
        candidateSha: options.candidateSha || null, requiredChecks: options.checks ? await jsonFile(options.checks) : [], requiredApprovals: Number(options.approvals), allowPrivate: options.allowPrivate === true }
      const confirmation = confirm(options, run, { action: 'prepare', ...settings })
      if (!confirmation) return
      const token = tokenFrom(options.tokenEnv)
      const host = await hostFor({ ...meta, confirmation, observed: observed(run) }, options, directory, new Set(['run.takeover']))
      let service
      try {
        await host.coordinator.attach({ runId: id, expectedRevision: run.revision })
        service = await createRunForgeDelivery({ ...settings, coordinator: host.coordinator, runId: id, token, authorizeDelivery: async () => false })
        const forge = { ...settings, candidateSha: service.binding.candidateSha, binding: service.binding, contract: service.delivery.contract }
        await writePrivateFile(metaFile(id), JSON.stringify({ ...meta, forge }))
        print({ prepared: true, pushed: false, binding: service.binding, instruction: '接下来可执行 runs forge push，再 draft；每个外部写命令单独确认并提供稳定 action-id。' })
      } finally { await service?.close(); await host.close() }
    })
  common(command.command('inspect <id>').description('先确认令牌发送目标，再只读检查固定 PR／MR；不接管或写账本')
    .requiredOption('--number <n>', 'PR／MR 编号'))
    .action(async (id, options, child) => {
      const { meta, run } = await load(id, child)
      if (!meta.forge?.contract) reject('请先 prepare 交付绑定。')
      const repository = parseForgeRemote(meta.forge.repository?.remote, { kind: meta.forge.repository?.kind, apiBase: meta.forge.repository?.apiBase })
      if (repository.id !== meta.forge.repository.id) reject('交付仓库元数据身份不一致，请先核查。')
      const contract = meta.forge.contract, requestNumber = Number(options.number)
      const allowPrivate = meta.forge.allowPrivate ?? false
      if (contract.runId !== run.id || contract.repositoryId !== repository.id || !Number.isSafeInteger(requestNumber) || requestNumber < 1 || typeof allowPrivate !== 'boolean') reject('只读交付检查的任务、编号或网络配置无效。')
      // Saved host metadata is not authority to disclose a credential. Even a
      // GET authenticates to a destination, so disclose the exact normalized
      // scope before reading the token or making any remote request.
      const confirmation = confirm(options, run, { action: 'inspect', repository, apiOrigin: new URL(repository.apiBase).origin,
        allowPrivate, contract, number: requestNumber, tokenEnvironment: options.tokenEnv,
        credentialNotice: '确认后会向上列 API 来源发送指定环境变量中的认证令牌；这是只读网络请求，不会推送、修改 PR／MR 或写入任务账本。' })
      if (!confirmation) return
      const client = createForgeClient({ repository, token: tokenFrom(options.tokenEnv), allowPrivate })
      const delivery = createForgeDelivery({ client, contract, authorize: async () => false,
        actions: { prepare: async () => { throw new Error('read only') }, settle: async () => { throw new Error('read only') } } })
      print({ ...await delivery.inspect({ number: requestNumber }), localLedgerBindingCurrent: run.candidateHash === meta.forge.binding.candidateHash && run.candidateGeneration === meta.forge.binding.candidateGeneration,
        localCandidateRevalidated: false })
    })
  common(command.command('reconcile <id>').description('仅核查原持久动作并收束回执；即使本地已修改或任务已取消，也绝不重发')
    .requiredOption('--action-id <id>', '原始外部意图 ID'))
    .action(async (id, options, child) => {
      const { meta, run, directory } = await load(id, child)
      const saved = await jsonFile(attemptFile(id, options.actionId))
      if (saved.schema !== 'kk.forge-attempt.v1' || saved.runId !== id || saved.payload?.actionId !== options.actionId || !actions[saved.operation]) reject('原始交付动作资料不匹配，未进行核查。')
      const confirmation = confirm(options, run, { action: 'read-only-reconcile', original: saved })
      if (!confirmation) return
      const client = createForgeClient({ repository: saved.repository, token: tokenFrom(options.tokenEnv), allowPrivate: saved.allowPrivate })
      if (run.actions.some(action => action.id === options.actionId && !['unknown', 'prepared'].includes(action.state))) {
        // Resolved records are immutable. Observe without pausing/taking over a
        // running task or reviving an already finished one.
        const resolved = { lookup: async supplied => {
          const intent = validateAction(supplied), previous = run.actions.find(action => action.id === intent.id)
          if (!previous) return null
          if (['kind', 'target', 'parameterHash', 'effect', 'retryPolicy'].some(key => previous[key] !== intent[key]) || JSON.stringify(previous.context) !== JSON.stringify(intent.context)) reject('原始动作参数不匹配。')
          return { fresh: false, state: previous.state, receipt: previous.receipt }
        }, settle: async () => reject('终态只读核查不能改写不可变回执。') }
        print(await createForgeReconciler({ client, contract: saved.contract, actions: resolved }).reconcile({ operation: saved.operation, request: saved.payload }))
        return
      }
      const host = await hostFor({ ...meta, confirmation, observed: observed(run) }, options, directory, new Set(['run.takeover']))
      try {
        await host.coordinator.attach({ runId: id, expectedRevision: run.revision })
        const reconciler = createForgeReconciler({ client, contract: saved.contract, actions: host.coordinator.actionAdapter(id) })
        print(await reconciler.reconcile({ operation: saved.operation, request: saved.payload }))
      } finally { await host.close() }
    })
  for (const [action, [kind, method]] of Object.entries(actions)) {
    common(command.command(`${action} <id>`).description({ push: '推送固定候选到任务分支，不覆盖目标分支', draft: '创建草稿 PR／MR', update: '更新草稿标题和说明', comment: '提交参数绑定的审查评论', ready: '重新检查 CI／审查后标记可审阅，不执行合并' }[action])
      .requiredOption('--action-id <id>', '稳定外部意图 ID；结果未知时必须重复使用')
      .option('--number <n>', '已有 PR／MR 编号').option('--title <text>', '草稿标题').option('--body-file <path>', '说明／评论正文文件（最多 60,000 字符）'))
      .action(async (id, options, child) => {
        const { meta, run, directory } = await load(id, child)
        if (!meta.forge?.binding) reject('请先 prepare 交付绑定；没有自动猜测仓库或候选。')
        const payload = { actionId: options.actionId, ...(options.number ? { number: Number(options.number) } : {}), ...(options.title ? { title: options.title } : {}),
          ...(['draft', 'update', 'comment'].includes(action) ? { body: options.bodyFile ? (await readBounded(options.bodyFile, 240000)).toString('utf8') : '' } : {}) }
        if (payload.body?.length > 60000) reject('交付文本超过 60,000 字符。')
        const credential = process.env[options.tokenEnv]
        if (credential && [payload.body || '', payload.title || ''].some(text => text.includes(credential))) reject('交付文本不得包含宿主 Forge 令牌。')
        const plan = { action, binding: meta.forge.binding, payload }
        const confirmation = confirm(options, run, plan)
        if (!confirmation) return
        const token = tokenFrom(options.tokenEnv)
        const host = await hostFor({ ...meta, confirmation, observed: observed(run) }, options, directory, new Set(['run.takeover', 'run.delivery', 'run.action']))
        let service
        try {
          const attached = await host.coordinator.attach({ runId: id, expectedRevision: run.revision })
          if (attached.state === 'paused') await host.coordinator.resumeDelivery({ runId: id })
          service = await createRunForgeDelivery({ ...meta.forge, coordinator: host.coordinator, runId: id, token, reconcileActionId: options.actionId,
            authorizeDelivery: async (intent, context) => intent.id === options.actionId && intent.kind === kind && context.runId === id &&
              context.repositoryId === meta.forge.binding.repositoryId && context.commitSha === meta.forge.binding.candidateSha && context.targetSha === meta.forge.binding.targetSha })
          if (service.binding.candidateHash !== meta.forge.binding.candidateHash || service.binding.candidateGeneration !== meta.forge.binding.candidateGeneration || service.binding.contractVersion !== meta.forge.binding.contractVersion) reject('原交付绑定已过期，请重新验收并 prepare。')
          const savedPath = attemptFile(id, options.actionId)
          const original = { schema: 'kk.forge-attempt.v1', runId: id, operation: action, payload, repository: meta.forge.repository, allowPrivate: meta.forge.allowPrivate, contract: service.delivery.contract }
          // Save only bounded, reviewed operation data, never credentials. Do
          // not replace an old attempt with different parameters under one ID.
          let previous
          try { previous = await jsonFile(savedPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
          if (previous && JSON.stringify(previous) !== JSON.stringify(original)) reject('操作 ID 已绑定其他原始参数，未覆盖恢复资料。')
          if (!previous) { await mkdir(path.dirname(savedPath), { recursive: true, mode: 0o700 }); await writePrivateFile(savedPath, JSON.stringify(original)) }
          print(await service.delivery[method](payload))
        } finally { await service?.close(); await host.close() }
      })
  }
}
