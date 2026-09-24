import { guardedFetch } from '../../net/url-guard.mjs'
import { buildRequestHeaders } from '../../http/identity.mjs'
import { ForgeError, fail, branch, sha, number, parseForgeRemote, snapshotForgeData } from './repository.mjs'

const PAGE = 100
const MAX_PAGES = 20
const plain = value => typeof value === 'string' ? value : ''

/** Host-selected endpoint and token only. Never construct this from model tool arguments.
 * @param {{repository?: import('../../sdk/forge.mjs').ForgeRepository, token?: string, allowPrivate?: boolean, timeoutMs?: number}} [options] */
export function createForgeClient({ repository, token, allowPrivate = false, timeoutMs = 30_000 } = {}) {
  repository = snapshotForgeData(repository)
  const checked = parseForgeRemote(repository?.remote, { kind: repository?.kind, apiBase: repository?.apiBase })
  if (checked.id !== repository.id) fail('FORGE_SCOPE', '仓库身份已改变。')
  if (typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token)) fail('FORGE_AUTH', '需要由宿主提供有效的 Forge 令牌。')
  if (typeof allowPrivate !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) fail('FORGE_INVALID', 'Forge 网络配置无效。')
  const base = new URL(`${checked.apiBase}/`)
  if (base.protocol !== 'https:' && !(allowPrivate && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname))) fail('FORGE_INVALID', '生产 Forge API 必须使用 HTTPS；仅显式允许本机 HTTP 验收。')
  const github = checked.kind === 'github'
  const repoPath = github ? `/repos/${checked.project.split('/').map(encodeURIComponent).join('/')}` : `/projects/${encodeURIComponent(checked.project)}`
  const requestPath = github ? 'pulls' : 'merge_requests'
  const clean = value => plain(value).split(token).join('[REDACTED]')

  function safeWriteText(...values) {
    for (const value of values) {
      if (typeof value !== 'string' || value.includes(token)) fail('FORGE_SECRET', '禁止将宿主 Forge 令牌写入远端内容。')
      // GitLab notes/descriptions execute slash quick actions server-side. A
      // comment grant must never become permission to /merge or change policy.
      if (!github && /^\s*\/[a-z][\w-]*(?:\s|$)/im.test(value)) fail('FORGE_QUICK_ACTION', 'GitLab 评论／说明不允许执行斜线快捷动作；请改为普通说明文字。')
    }
  }

  /** @param {string} suffix @param {{method?: string, body?: any, params?: Record<string,unknown>, signal?: AbortSignal, graph?: boolean}} [options] */
  async function request(suffix, { method = 'GET', body, params = {}, signal, graph = false } = {}) {
    const endpoint = graph ? (base.pathname === '/' ? '/graphql' : '/api/graphql') : `${base.pathname.replace(/\/$/, '')}${suffix}`
    const url = new URL(endpoint, base.origin)
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
    const headers = buildRequestHeaders({
      target: checked.kind, accept: 'application/json', contentType: body ? 'application/json' : '',
      authorization: github ? `Bearer ${token}` : '',
      customHeaders: github ? { 'X-GitHub-Api-Version': '2026-03-10' } : { 'PRIVATE-TOKEN': token }
    })
    try {
      const { response } = await guardedFetch(url.href, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      }, { allowPrivate, maxRedirects: 0, maxWireBytes: 4 * 1024 * 1024, maxDecodedBytes: 4 * 1024 * 1024 })
      if (!response.ok) throw new ForgeError('FORGE_HTTP', `Forge 请求失败（HTTP ${response.status}）；请检查权限、限流和服务状态。`, response.status)
      const data = response.status === 204 ? null : await response.json()
      if (graph && (data?.errors?.length || !data?.data)) fail('FORGE_PROTOCOL', 'Forge GraphQL 未返回完整结果；不能确认远端状态。')
      return graph ? data.data : data
    } catch (error) {
      if (error instanceof ForgeError) throw error
      throw new ForgeError('FORGE_CONNECTION', 'Forge 连接或响应读取失败；外部写入可能已发生，必须先核查，不能直接重试。')
    }
  }

  async function pages(suffix, params = {}, field = null, signal, expectedSha = null) {
    const items = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await request(suffix, { params: { ...params, per_page: PAGE, page }, signal })
      if (expectedSha && data?.sha !== expectedSha) fail('FORGE_STALE', '远端状态响应不属于当前候选提交。')
      const batch = field ? data?.[field] : data
      if (!Array.isArray(batch)) fail('FORGE_PROTOCOL', 'Forge 列表响应不完整。')
      items.push(...batch)
      if (batch.length < PAGE) return items
    }
    fail('FORGE_INCOMPLETE', '远端数据超过安全分页上限，不能将部分结果当成完整验收。')
  }

  function normalizeRequest(data) {
    const ownProject = github
      ? data?.base?.repo?.full_name?.toLowerCase() === checked.project.toLowerCase() && data?.head?.repo?.full_name?.toLowerCase() === checked.project.toLowerCase()
      : data?.source_project_id === data?.target_project_id && data?.source_project_id != null
    if (!ownProject) fail('FORGE_SCOPE', '跨仓库 PR／MR 不属于当前固定交付范围。')
    return {
      number: number(github ? data.number : data.iid), nodeId: github ? plain(data.node_id) : null,
      sourceBranch: branch(github ? data.head.ref : data.source_branch), targetBranch: branch(github ? data.base.ref : data.target_branch),
      headSha: sha(github ? data.head.sha : data.sha), state: github ? data.state : data.state === 'opened' ? 'open' : data.state,
      draft: github ? data.draft === true : data.draft === true || /^Draft:\s*/i.test(data.title),
      title: clean(data.title), body: clean(github ? data.body : data.description),
      url: `${checked.webUrl}/${github ? 'pull' : '-/merge_requests'}/${github ? data.number : data.iid}`,
      mergeable: github ? data.mergeable : data.detailed_merge_status === 'mergeable',
      mergeState: github ? plain(data.mergeable_state) : plain(data.detailed_merge_status),
      discussionsResolved: github || typeof data.blocking_discussions_resolved !== 'boolean' ? null : data.blocking_discussions_resolved
    }
  }

  /** @param {number} id @param {{signal?: AbortSignal}} [options] */
  async function getRequest(id, { signal } = {}) { return normalizeRequest(await request(`${repoPath}/${requestPath}/${number(id)}`, { signal })) }
  /** @param {string} name @param {{signal?: AbortSignal, allowMissing?: boolean}} [options] */
  async function getBranch(name, { signal, allowMissing = false } = {}) {
    try {
      const data = await request(`${repoPath}/${github ? 'branches' : 'repository/branches'}/${encodeURIComponent(branch(name))}`, { signal })
      return sha(github ? data?.commit?.sha : data?.commit?.id)
    } catch (error) { if (allowMissing && error.httpStatus === 404) return null; throw error }
  }
  /** @param {{sourceBranch?: string, targetBranch?: string, signal?: AbortSignal}} [options] */
  async function listRequests({ sourceBranch, targetBranch, signal } = {}) {
    const params = github ? { state: 'all', head: `${checked.project.split('/')[0]}:${branch(sourceBranch)}`, base: branch(targetBranch) }
      : { state: 'all', source_branch: branch(sourceBranch), target_branch: branch(targetBranch) }
    const entries = await pages(`${repoPath}/${requestPath}`, params, null, signal)
    // GET each matching candidate: list projection may omit current SHA/policy.
    return Promise.all(entries.map(data => getRequest(github ? data.number : data.iid, { signal })))
  }
  /** @param {number} id @param {{signal?: AbortSignal}} [options] */
  async function listComments(id, { signal } = {}) {
    const suffix = github ? `${repoPath}/issues/${number(id)}/comments` : `${repoPath}/merge_requests/${number(id)}/notes`
    const normalize = data => ({
      id: number(data.id), body: clean(data.body), author: clean(github ? data.user?.login : data.author?.username),
      source: 'remote_untrusted', url: `${checked.webUrl}/${github ? 'pull' : '-/merge_requests'}/${id}${github ? '#issuecomment-' : '#note_'}${data.id}`
    })
    const comments = (await pages(suffix, {}, null, signal)).map(normalize)
    if (github) comments.push(...(await pages(`${repoPath}/pulls/${number(id)}/comments`, {}, null, signal)).map(data => ({
      ...normalize(data), url: `${checked.webUrl}/pull/${id}#discussion_r${data.id}`, commitSha: plain(data.commit_id), path: clean(data.path)
    })))
    return comments
  }
  /** @param {string} candidateSha @param {{signal?: AbortSignal}} [options] */
  async function listChecks(candidateSha, { signal } = {}) {
    sha(candidateSha)
    if (github) {
      const [checks, statuses] = await Promise.all([
        pages(`${repoPath}/commits/${candidateSha}/check-runs`, { filter: 'latest' }, 'check_runs', signal),
        pages(`${repoPath}/commits/${candidateSha}/status`, {}, 'statuses', signal, candidateSha)
      ])
      return [...checks.map(check => ({ id: number(check.id), name: clean(check.name), kind: 'check_run', appId: check.app?.id ?? null,
        sha: plain(check.head_sha), status: check.status === 'completed' ? clean(check.conclusion) : 'pending' })),
      ...statuses.map(status => ({ id: number(status.id), name: clean(status.context), kind: 'status', appId: null,
        // Status objects are scoped by the exact SHA endpoint (no per-item SHA in GitHub's response).
        sha: candidateSha, status: clean(status.state) }))]
    }
    const pipelines = await pages(`${repoPath}/pipelines`, { sha: candidateSha, order_by: 'id', sort: 'desc' }, null, signal)
    const current = pipelines.filter(pipeline => pipeline.sha === candidateSha).sort((a, b) => b.id - a.id)[0]
    if (!current) return []
    const jobs = await pages(`${repoPath}/pipelines/${number(current.id)}/jobs`, { include_retried: false }, null, signal)
    return jobs.map(job => ({ id: number(job.id), name: clean(job.name), kind: 'job', appId: null,
      sha: plain(job.commit?.id), status: clean(job.status), pipelineStatus: clean(current.status), pipelineId: current.id }))
  }
  /** @param {number} id @param {{signal?: AbortSignal}} [options] */
  async function reviewState(id, { signal } = {}) {
    if (!github) {
      const [data, discussions] = await Promise.all([
        request(`${repoPath}/merge_requests/${number(id)}/approvals`, { signal }),
        pages(`${repoPath}/merge_requests/${number(id)}/discussions`, {}, null, signal)
      ])
      if (!Array.isArray(data?.approved_by) || !Number.isInteger(data?.approvals_left)) fail('FORGE_INCOMPLETE', 'GitLab 未提供完整审批状态。')
      if (discussions.some(item => !Array.isArray(item.notes))) fail('FORGE_INCOMPLETE', 'GitLab 审查讨论数据不完整。')
      return { approved: data.approved_by.length, decision: data.approvals_left === 0 ? 'APPROVED' : 'REVIEW_REQUIRED',
        unresolved: discussions.flatMap(item => item.notes).filter(note => note.resolvable === true && note.resolved !== true).length }
    }
    let after = null, unresolved = 0, last
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await request('', { method: 'POST', graph: true, signal, body: {
        query: 'query KKDeliveryReview($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewDecision mergeStateStatus reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}',
        variables: { owner: checked.project.split('/')[0], name: checked.project.split('/')[1], number: number(id), after }
      } })
      const info = data.repository?.pullRequest
      if (!info?.reviewThreads?.pageInfo || !Array.isArray(info.reviewThreads.nodes)) fail('FORGE_INCOMPLETE', 'GitHub 未提供完整审查线程状态。')
      if (last && last.headRefOid !== info.headRefOid) fail('FORGE_STALE', '读取审查时远端候选发生变化。')
      last = info
      unresolved += info.reviewThreads.nodes.filter(thread => thread.isResolved !== true).length
      if (!info.reviewThreads.pageInfo.hasNextPage) {
        const reviews = await pages(`${repoPath}/pulls/${number(id)}/reviews`, {}, null, signal)
        const latest = new Map()
        for (const review of reviews.sort((a, b) => a.id - b.id)) {
          if (review.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review)
        }
        return { approved: [...latest.values()].filter(review => review.state === 'APPROVED' && review.commit_id === info.headRefOid).length,
          decision: info.reviewDecision || 'NOT_REQUIRED', unresolved, headSha: sha(info.headRefOid), mergeState: info.mergeStateStatus }
      }
      after = info.reviewThreads.pageInfo.endCursor
      if (!after) fail('FORGE_INCOMPLETE', 'GitHub 审查分页信息缺失。')
    }
    fail('FORGE_INCOMPLETE', '审查线程超过完整核验上限。')
  }

  // These host-only primitives are consumed by ForgeDelivery, not registered tools.
  async function createDraft({ sourceBranch, targetBranch, title, body, signal }) {
    safeWriteText(title, body)
    const data = await request(`${repoPath}/${requestPath}`, { method: 'POST', signal, body: github
      ? { head: branch(sourceBranch), base: branch(targetBranch), title, body, draft: true, maintainer_can_modify: false }
      : { source_branch: branch(sourceBranch), target_branch: branch(targetBranch), title: `Draft: ${title.replace(/^Draft:\s*/i, '')}`, description: body, allow_collaboration: false, remove_source_branch: false } })
    return getRequest(github ? data.number : data.iid, { signal })
  }
  async function updateDraft(id, { title, body, signal }) {
    safeWriteText(title, body)
    await request(`${repoPath}/${requestPath}/${number(id)}`, { method: github ? 'PATCH' : 'PUT', signal, body: github
      ? { title, body } : { title: `Draft: ${title.replace(/^Draft:\s*/i, '')}`, description: body } })
    return getRequest(id, { signal })
  }
  async function postComment(id, { body, signal }) {
    safeWriteText(body)
    return request(github ? `${repoPath}/issues/${number(id)}/comments` : `${repoPath}/merge_requests/${number(id)}/notes`, { method: 'POST', body: { body }, signal })
  }
  /** @param {number} id @param {{signal?: AbortSignal}} [options] */
  async function markReady(id, { signal } = {}) {
    const current = await getRequest(id, { signal })
    if (github) await request('', { method: 'POST', graph: true, signal, body: {
      query: 'mutation KKDeliveryReady($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}', variables: { id: current.nodeId }
    } })
    else await request(`${repoPath}/merge_requests/${number(id)}`, { method: 'PUT', signal, body: { title: current.title.replace(/^Draft:\s*/i, '') } })
    return getRequest(id, { signal })
  }
  return Object.freeze({ repository: checked, validateText: safeWriteText, getBranch, getRequest, listRequests, listComments, listChecks, reviewState, createDraft, updateDraft, postComment, markReady })
}
