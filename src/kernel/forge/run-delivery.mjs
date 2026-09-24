import { createGhostCommit } from '../../util/git.mjs'
import { runControlledGit } from '../../util/controlled-git.mjs'
import { captureAcceptanceCandidate } from '../session/acceptance-manifest.mjs'
import { createGitPushTransport } from './git-transport.mjs'
import { createForgeClient } from './client.mjs'
import { createForgeDelivery } from './delivery.mjs'
import { parseForgeRemote, deliveryContract, deepFreeze, fail, sha, snapshotForgeData } from './repository.mjs'

const sameFile = (a, b) => a.kind === b.kind && a.hash === b.hash && (a.kind !== 'file' || a.size === b.size && a.executable === b.executable)
function assertMapping(files, entries) {
  const committed = new Map(entries.map(file => [file.path, file]))
  for (const expected of files) {
    const actual = committed.get(expected.path)
    if (expected.kind === 'missing') { if (actual) fail('FORGE_CANDIDATE_MAPPING', '候选提交仍包含验收工作区中已删除的文件。'); continue }
    if (!actual || !sameFile(expected, actual)) fail('FORGE_CANDIDATE_MAPPING', '候选提交内容／权限与已验收工作区不一致；没有授予推送权限。')
    committed.delete(expected.path)
  }
  if (committed.size) fail('FORGE_CANDIDATE_MAPPING', '候选提交包含验收范围之外的额外文件。')
}

/** Real RunStore-backed delivery. Caller supplies live host coordinator and
 * grants; a model's SHA/approval JSON is never verification evidence.
 * candidateSha is optional on first preparation, but should be persisted by the
 * host and reused to reconcile the exact same delivery after a restart.
 * @param {Record<string, any>} options */
export async function createRunForgeDelivery({ coordinator, runId, repository, token, sourceBranch, targetBranch, targetSha,
  candidateSha = null, requiredChecks = [], requiredApprovals = 1, allowPrivate = false, authorizeDelivery, reconcileActionId = null }) {
  ;({ runId, repository, sourceBranch, targetBranch, targetSha, candidateSha, requiredChecks, requiredApprovals, allowPrivate, reconcileActionId } =
    snapshotForgeData({ runId, repository, sourceBranch, targetBranch, targetSha, candidateSha, requiredChecks, requiredApprovals, allowPrivate, reconcileActionId }))
  if (typeof coordinator?.verifiedCandidate !== 'function' || typeof coordinator?.actionAdapter !== 'function' || typeof authorizeDelivery !== 'function') fail('FORGE_HOST_REQUIRED', '交付需要真实任务协调器和本次操作的宿主确认。')
  const first = await coordinator.verifiedCandidate({ runId, reconcileActionId })
  const root = first.run.binding.cwd
  const repositoryIdentity = parseForgeRemote(repository.remote, { kind: repository.kind, apiBase: repository.apiBase })
  const approved = first.run.contract.allowedExternalActions.filter(action => action.startsWith('forge.'))
  if (!approved.length) fail('FORGE_NOT_AUTHORIZED', '任务契约没有批准任何 Forge 外部交付操作。')
  const candidate = await captureAcceptanceCandidate(root, { includeFiles: true })
  if (candidate.treeFingerprint !== first.run.candidateHash) fail('FORGE_CANDIDATE_CHANGED', '准备交付时工作区已经变化，需重新验收。')
  if (!candidateSha) {
    const snapshot = await createGhostCommit(root, `KK Code verified candidate for ${runId}`, [], { controlled: true })
    if (!snapshot.ok) fail('FORGE_GIT_SOURCE', '无法生成候选 Git 快照；未推送或更改工作区分支。')
    candidateSha = snapshot.ghostCommit.commitHash
  }
  sha(candidateSha)
  const parents = await runControlledGit(['rev-parse', '--verify', '--end-of-options', `${candidateSha}^`], { cwd: root, maxBuffer: 4096 })
  if (!parents.ok || parents.stdout.trim() !== candidate.head) fail('FORGE_CANDIDATE_MAPPING', '候选提交必须直接基于本次已验收工作区的固定 HEAD。')
  const contract = deliveryContract({ runId, repositoryId: repositoryIdentity.id, sourceBranch, targetBranch, targetSha, candidateSha,
    requiredChecks, requiredApprovals, allowedExternalActions: approved }, repositoryIdentity)
  const transport = await createGitPushTransport({ cwd: root, repository: repositoryIdentity, candidateSha, sourceBranch, targetBranch, targetSha, token, allowPrivate })
  try {
    const committedFiles = await transport.files()
    assertMapping(candidate.files, committedFiles)
    const binding = deepFreeze({ schema: 'kk.run-forge-binding.v1', runId, repositoryId: repositoryIdentity.id,
      candidateHash: first.run.candidateHash, candidateGeneration: first.run.candidateGeneration, contractVersion: first.run.contractVersion,
      candidateSha, tree: transport.tree, baseRevision: candidate.head, sourceBranch, targetBranch, targetSha })
    const verify = async actionId => {
      const current = await coordinator.verifiedCandidate({ runId, ...(actionId ? { reconcileActionId: actionId, preparedActionId: actionId } : {}) })
      if (current.run.contractVersion !== binding.contractVersion || current.run.candidateGeneration !== binding.candidateGeneration || current.run.candidateHash !== binding.candidateHash || current.candidate.head !== binding.baseRevision) fail('FORGE_CANDIDATE_CHANGED', '交付绑定的任务合同或已验收候选已经变化。')
      return current
    }
    await verify(reconcileActionId)
    const actions = coordinator.actionAdapter(runId)
    const client = createForgeClient({ repository: repositoryIdentity, token, allowPrivate })
    const delivery = createForgeDelivery({ client, contract, actions, push: transport.push,
      authorize: async (intent, context) => {
        await verify(intent.id)
        if (await authorizeDelivery(intent, context) !== true) return false
        await verify(intent.id)
        const authorized = await actions.authorize(intent, context)
        await verify(intent.id)
        return authorized === true
      } })
    return Object.freeze({ delivery, binding,
      async verifyReceipt({ run, receipt }) {
        if (run.id !== binding.runId || receipt?.runId !== binding.runId || receipt.repositoryId !== binding.repositoryId || receipt.candidateSha !== binding.candidateSha || receipt.targetSha !== binding.targetSha) return false
        await verify()
        return true
      },
      close: () => transport.close() })
  } catch (error) { await transport.close(); throw error }
}
