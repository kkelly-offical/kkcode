import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseForgeRemote, createForgeClient, createForgeDelivery, createForgeReconciler } from '../src/kernel/forge/index.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'

const BASE = 'a'.repeat(40), CANDIDATE = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const TOKEN = 'synthetic-forge-token-not-a-real-credential'
const allowed = ['forge.push', 'forge.draft.create', 'forge.draft.update', 'forge.comment', 'forge.ready']

test('read-only reconciliation checks the exact original intent before any authenticated observation', async t => {
  const f = await fixture(t)
  for (const lookup of [async () => null, async () => { throw Object.assign(new Error('intent mismatch'), { code: 'ACTION_ID_CONFLICT' }) }]) {
    const reconciler = createForgeReconciler({ client: f.client, contract: f.contract,
      actions: { lookup, settle: async () => assert.fail('unmatched intent cannot settle') } })
    await assert.rejects(reconciler.reconcile({ operation: 'push', request: { actionId: 'unmatched-original' } }), error => ['FORGE_INTENT_MISSING', 'ACTION_ID_CONFLICT'].includes(error.code))
    assert.equal(f.state.requests.length, 0, 'no read request or credential leaves before exact original action lookup')
  }
})

async function fixture(t, kind = 'github') {
  const state = { kind, target: BASE, source: CANDIDATE, draft: true, request: null, comments: [], mutations: [], requests: [],
    checkSha: CANDIDATE, statusSha: CANDIDATE, ci: 'success', approvals: 1, unresolved: false, failWrite: false, lostReply: false,
    mergeState: null, redirect: false, tokenEcho: false }
  const project = kind === 'github' ? 'owner/repo' : 'team/subgroup/repo'
  function requestData() {
    if (kind === 'github') return { number: 1, node_id: 'PR_one', title: state.request.title, body: state.request.body,
      state: 'open', draft: state.draft, mergeable: true, mergeable_state: state.mergeState || (state.draft ? 'draft' : 'clean'),
      head: { ref: 'kk/task-1', sha: state.source, repo: { full_name: project } },
      base: { ref: 'main', sha: state.target, repo: { full_name: project } } }
    return { iid: 1, source_project_id: 10, target_project_id: 10, title: state.request.title, description: state.request.body,
      state: 'opened', draft: state.draft, sha: state.source, source_branch: 'kk/task-1', target_branch: 'main',
      detailed_merge_status: state.mergeState || (state.draft ? 'draft_status' : 'mergeable'), blocking_discussions_resolved: !state.unresolved }
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    const urlPath = decodeURIComponent(url.pathname)
    const bodyText = await Array.fromAsync(req).then(chunks => Buffer.concat(chunks).toString())
    const body = bodyText ? JSON.parse(bodyText) : null
    state.requests.push({ method: req.method, path: urlPath, body, headers: req.headers })
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (state.redirect) { res.writeHead(302, { location: 'http://127.0.0.1:9/never-follow' }); res.end(); return }
    if (state.tokenEcho) { send({ error: TOKEN }, 500); return }
    const graph = urlPath === '/api/graphql'
    const mutation = req.method !== 'GET' && (!graph || body.query.startsWith('mutation'))
    if (mutation) {
      state.mutations.push({ method: req.method, path: urlPath, body })
      if (state.failWrite) { send({ error: 'upstream uncertain' }, 502); return }
    }
    if (graph) {
      if (body.query.startsWith('mutation')) {
        state.draft = false
        if (state.lostReply) { req.socket.destroy(); return }
        send({ data: { markPullRequestReadyForReview: { pullRequest: { id: 'PR_one', isDraft: false } } } }); return
      }
      send({ data: { repository: { pullRequest: { headRefOid: state.source, reviewDecision: state.approvals ? 'APPROVED' : 'REVIEW_REQUIRED',
        mergeStateStatus: state.mergeState?.toUpperCase() || (state.draft ? 'DRAFT' : 'CLEAN'), reviewThreads: {
          nodes: [{ isResolved: !state.unresolved }], pageInfo: { hasNextPage: false, endCursor: null }
        } } } } }); return
    }
    const prefix = kind === 'github' ? `/api/v3/repos/${project}` : `/api/v4/projects/${project}`
    if (!urlPath.startsWith(prefix)) { send({ error: 'missing route' }, 404); return }
    const endpoint = urlPath.slice(prefix.length)
    const branchPrefix = kind === 'github' ? '/branches/' : '/repository/branches/'
    if (endpoint.startsWith(branchPrefix)) {
      const name = endpoint.slice(branchPrefix.length)
      const value = name === 'main' ? state.target : state.source
      if (!value) send({}, 404)
      else send({ commit: kind === 'github' ? { sha: value } : { id: value } })
      return
    }
    if (endpoint.endsWith('/check-runs')) { send({ check_runs: [{ id: 4, name: 'ci', app: { id: 42 }, head_sha: state.checkSha, status: 'completed', conclusion: state.ci }] }); return }
    if (endpoint.endsWith('/status')) { send({ sha: state.statusSha, statuses: [] }); return }
    if (endpoint.endsWith('/reviews')) { send(state.approvals ? [{ id: 7, state: 'APPROVED', commit_id: state.source, user: { login: 'reviewer' } }] : []); return }
    if (endpoint === '/pipelines') { send([{ id: 2, sha: state.source, status: state.ci }]); return }
    if (endpoint === '/pipelines/2/jobs') { send([{ id: 8, name: 'ci', commit: { id: state.checkSha }, status: state.ci }]); return }
    if (endpoint.endsWith('/approvals')) { send({ approved_by: state.approvals ? [{ user: { username: 'reviewer' } }] : [], approvals_left: state.approvals ? 0 : 1 }); return }
    if (endpoint.endsWith('/discussions')) { send([{ notes: [{ resolvable: true, resolved: !state.unresolved }] }]); return }
    if (endpoint === '/pulls/1/comments') { send([]); return }
    if (endpoint === '/issues/1/comments' || endpoint === '/merge_requests/1/notes') {
      if (req.method === 'POST') {
        const note = { id: state.comments.length + 1, body: body.body, user: { login: 'bot' }, author: { username: 'bot' } }
        state.comments.push(note)
        if (state.lostReply) { req.socket.destroy(); return }
        send(note, 201)
      } else send(state.comments)
      return
    }
    if (endpoint === '/pulls' || endpoint === '/merge_requests') {
      if (req.method === 'POST') {
        state.request = { title: body.title, body: kind === 'github' ? body.body : body.description }
        state.draft = kind === 'github' ? body.draft : body.title.startsWith('Draft: ')
        if (state.lostReply) { req.socket.destroy(); return }
        send(requestData(), 201)
      } else send(state.request ? [requestData()] : [])
      return
    }
    if (endpoint === '/pulls/1' || endpoint === '/merge_requests/1') {
      if (!state.request) { send({}, 404); return }
      if (req.method !== 'GET') {
        if (body.title !== undefined) state.request.title = body.title
        if (body.body !== undefined || body.description !== undefined) state.request.body = kind === 'github' ? body.body : body.description
        if (kind === 'gitlab') state.draft = body.title.startsWith('Draft: ')
        if (state.lostReply) { req.socket.destroy(); return }
      }
      send(requestData()); return
    }
    send({ error: 'unimplemented fixture route' }, 404)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const repository = parseForgeRemote(`${origin}/${project}.git`, { kind })
  const client = createForgeClient({ repository, token: TOKEN, allowPrivate: true, timeoutMs: 1000 })
  const contract = { runId: 'run-1', repositoryId: repository.id, sourceBranch: 'kk/task-1', targetBranch: 'main', targetSha: BASE,
    candidateSha: CANDIDATE, requiredChecks: [{ kind: kind === 'github' ? 'check_run' : 'job', name: 'ci', ...(kind === 'github' ? { appId: 42 } : {}) }], requiredApprovals: 1, allowedExternalActions: allowed }
  const entries = new Map()
  const actions = {
    async prepare(intent) {
      const existing = entries.get(intent.id)
      if (existing) {
        if (existing.intent.parameterHash !== intent.parameterHash) throw Object.assign(new Error('changed action parameters'), { code: 'ACTION_CONFLICT' })
        return { fresh: false, state: existing.state, receipt: existing.receipt }
      }
      entries.set(intent.id, { intent, state: 'prepared' })
      return { fresh: true, state: 'prepared' }
    },
    async settle({ id, state, receipt }) { Object.assign(entries.get(id), { state, receipt }) }
  }
  const delivery = createForgeDelivery({ client, contract, actions, authorize: async () => true,
    push: async request => { assert.equal(request.force, false); assert.equal(request.refspec, `${CANDIDATE}:refs/heads/kk/task-1`); state.source = request.candidateSha } })
  return { state, client, contract, repository, actions, entries, delivery }
}

test('repository identity rejects embedded credentials and cross-origin token routing', () => {
  assert.equal(parseForgeRemote('git@github.com:owner/repo.git').project, 'owner/repo')
  assert.equal(parseForgeRemote('https://gitlab.com/team/sub/repo.git').kind, 'gitlab')
  assert.equal(parseForgeRemote('https://git.example.test/team/repo.git', { kind: 'gitlab' }).apiBase, 'https://git.example.test/api/v4')
  assert.equal(parseForgeRemote('https://git.example.test/gitlab/team/repo.git', { kind: 'gitlab', apiBase: 'https://git.example.test/gitlab/api/v4' }).project, 'team/repo')
  for (const remote of ['https://user:secret@gitlab.com/a/b', 'https://token@gitlab.com/a/b', 'file:///tmp/repo', 'https://github.com/a/b?token=secret']) {
    assert.throws(() => parseForgeRemote(remote), { code: 'FORGE_INVALID' })
  }
  assert.throws(() => parseForgeRemote('https://gitlab.com/team/repo', { apiBase: 'https://evil.example/api/v4' }), { code: 'FORGE_INVALID' })
})

for (const kind of ['github', 'gitlab']) {
  test(`${kind}: governed push, draft, update, review comment, checks and ready lifecycle over real HTTP`, async t => {
    const f = await fixture(t, kind)
    f.state.source = null
    assert.equal((await f.delivery.pushCandidate({ actionId: 'push-1' })).status, 'succeeded')
    const draft = await f.delivery.openDraft({ actionId: 'draft-1', title: 'Deliver verified change', body: 'Tests passed locally.' })
    assert.equal(draft.status, 'succeeded')
    assert.equal(draft.result.draft, true)
    assert.equal((await f.delivery.updateDraft({ actionId: 'update-1', number: 1, title: 'Updated report', body: 'More verification evidence.' })).status, 'succeeded')
    const comment = await f.delivery.postComment({ actionId: 'comment-1', number: 1, body: 'Review request addressed.' })
    assert.equal(comment.status, 'succeeded')
    const before = await f.delivery.inspect({ number: 1 })
    assert.equal(before.status, 'ready_for_review')
    assert.equal(before.comments[0].source, 'remote_untrusted')
    assert.equal(before.canMergeAutomatically, false)
    assert.equal((await f.delivery.markReady({ actionId: 'ready-1', number: 1 })).status, 'succeeded')
    assert.equal((await f.delivery.inspect({ number: 1 })).status, 'mergeable')
    assert.ok(f.state.requests.every(req => kind === 'github' ? req.headers.authorization === `Bearer ${TOKEN}` : req.headers['private-token'] === TOKEN))
    assert.ok(f.state.requests.every(req => /^KK-Code\//.test(req.headers['user-agent'])))
    assert.ok(f.state.mutations.every(req => !/\/merge$|\/protection/.test(req.path)))
    assert.equal(JSON.stringify([...f.entries.values()]).includes(TOKEN), false)
  })

  test(`${kind}: lost write reply reconciles by exact marker without duplicate create/comment`, async t => {
    const f = await fixture(t, kind)
    f.state.lostReply = true
    const draft = await f.delivery.openDraft({ actionId: 'draft-lost', title: 'Lost reply', body: 'Exact report' })
    assert.equal(draft.status, 'succeeded')
    const count = f.state.mutations.length
    const again = await f.delivery.openDraft({ actionId: 'draft-lost', title: 'Lost reply', body: 'Exact report' })
    assert.equal(again.status, 'succeeded')
    assert.equal(f.state.mutations.length, count)
    assert.equal((await f.delivery.postComment({ actionId: 'comment-lost', number: 1, body: 'Addressed.' })).status, 'succeeded')
    await f.delivery.postComment({ actionId: 'comment-lost', number: 1, body: 'Addressed.' })
    assert.equal(f.state.comments.length, 1)
    await assert.rejects(f.delivery.postComment({ actionId: 'comment-lost', number: 1, body: 'Changed parameters' }), { code: 'ACTION_CONFLICT' })
  })

  test(`${kind}: unknown write remains unknown and is never automatically replayed`, async t => {
    const f = await fixture(t, kind)
    f.state.failWrite = true
    assert.equal((await f.delivery.openDraft({ actionId: 'uncertain', title: 'Uncertain' })).status, 'unknown')
    f.state.failWrite = false
    assert.equal((await f.delivery.openDraft({ actionId: 'uncertain', title: 'Uncertain' })).status, 'unknown')
    assert.equal(f.state.mutations.length, 1)
    assert.equal(f.state.request, null)
  })

  test(`${kind}: stale candidate/target, CI failures and incomplete review block ready`, async t => {
    const f = await fixture(t, kind)
    await f.delivery.openDraft({ actionId: 'create', title: 'Check guards' })
    const mutations = f.state.mutations.length
    f.state.checkSha = OTHER
    assert.equal((await f.delivery.inspect({ number: 1 })).status, 'blocked')
    await assert.rejects(f.delivery.markReady({ actionId: 'stale-ci', number: 1 }), { code: 'FORGE_VERIFICATION_REQUIRED' })
    f.state.checkSha = CANDIDATE; f.state.ci = 'failed'
    assert.equal((await f.delivery.inspect({ number: 1 })).status, 'blocked')
    f.state.ci = 'success'; f.state.approvals = 0
    assert.equal((await f.delivery.inspect({ number: 1 })).status, 'blocked')
    f.state.approvals = 1; f.state.unresolved = true
    assert.equal((await f.delivery.inspect({ number: 1 })).status, 'blocked')
    f.state.unresolved = false; f.state.source = OTHER
    await assert.rejects(f.delivery.inspect({ number: 1 }), { code: 'FORGE_CANDIDATE_CHANGED' })
    f.state.source = CANDIDATE; f.state.target = OTHER
    await assert.rejects(f.delivery.openDraft({ actionId: 'moved-target', title: 'No write' }), { code: 'FORGE_TARGET_MOVED' })
    assert.equal(f.state.mutations.length, mutations)
  })
}

test('contract and parameter-bound host grant both required; revocation after prepare prevents write', async t => {
  const f = await fixture(t)
  const denied = createForgeDelivery({ client: f.client, contract: { ...f.contract, allowedExternalActions: [] }, actions: f.actions, authorize: async () => true })
  await assert.rejects(denied.openDraft({ actionId: 'denied', title: 'No' }), { code: 'FORGE_NOT_AUTHORIZED' })
  let calls = 0
  const revoke = createForgeDelivery({ client: f.client, contract: f.contract, actions: f.actions, authorize: async intent => {
    assert.equal(intent.parameterHash.length, 64)
    return ++calls === 1
  } })
  await assert.rejects(revoke.openDraft({ actionId: 'revoked', title: 'No' }), { code: 'FORGE_GRANT_REQUIRED' })
  assert.equal(f.entries.get('revoked').state, 'not_applied')
  assert.equal(f.state.mutations.length, 0)
})

test('contract, checks, titles and comments remain the authorized snapshots across awaits', async t => {
  const f = await fixture(t), contract = structuredClone(f.contract)
  let release, ready
  const paused = new Promise(resolve => { ready = resolve }), gate = new Promise(resolve => { release = resolve })
  let confirmations = 0
  const delivery = createForgeDelivery({ client: f.client, contract, actions: f.actions, authorize: async (_intent, context) => {
    assert.ok(Object.isFrozen(context.payload))
    if (++confirmations === 1) { ready(); await gate }
    return true
  } })
  const original = { actionId: 'snapshot-draft', title: 'Approved title', body: 'Approved body' }
  const pending = delivery.openDraft(original)
  await paused
  original.title = 'Mutated title'; original.body = 'Mutated body'
  contract.requiredChecks.length = 0; contract.sourceBranch = 'main'; contract.targetSha = OTHER; contract.allowedExternalActions = []
  assert.equal(Object.isFrozen(original), false); assert.equal(Object.isFrozen(contract), false)
  release()
  assert.equal((await pending).status, 'succeeded')
  assert.equal(f.state.request.title, 'Approved title'); assert.match(f.state.request.body, /^Approved body\n/)
  assert.equal(delivery.contract.requiredChecks.length, 1)
  const comment = { actionId: 'snapshot-comment', number: 1, body: 'Approved comment' }
  const sending = delivery.postComment(comment)
  comment.number = 999; comment.body = 'Mutated comment'
  assert.equal((await sending).status, 'succeeded')
  assert.match(f.state.comments.at(-1).body, /^Approved comment\n/)
})

test('GitLab quick actions cannot turn a comment grant into merge permission', async t => {
  const f = await fixture(t, 'gitlab')
  await f.delivery.openDraft({ actionId: 'create', title: 'Safe draft' })
  const count = f.state.mutations.length
  await assert.rejects(f.delivery.postComment({ actionId: 'quick-action', number: 1, body: 'Helpful note\n/merge' }), { code: 'FORGE_QUICK_ACTION' })
  assert.equal(f.state.mutations.length, count)
  assert.equal(f.entries.has('quick-action'), false)
})

test('remote errors never echo the host token and authenticated requests never follow redirects', async t => {
  const f = await fixture(t)
  f.state.tokenEcho = true
  await assert.rejects(f.client.getBranch('main'), error => error.code === 'FORGE_HTTP' && !JSON.stringify(error).includes(TOKEN) && !error.message.includes(TOKEN))
  f.state.tokenEcho = false; f.state.redirect = true
  await assert.rejects(f.client.getBranch('main'), { code: 'FORGE_CONNECTION' })
  assert.ok(f.state.requests.every(req => !req.path.includes('never-follow')))
})

test('persistent prepared Forge action reconciles after store restart instead of replaying', async t => {
  const f = await fixture(t)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-forge-durable-'))
  let store = await openRunStore({ directory })
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const task = await store.createRun({ id: 'forge-run', ownerId: 'host', contract: { objective: 'Publish only an authorized draft', requiredCriteria: [], allowedExternalActions: allowed } })
  const guard = run => ({ runId: run.id, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, expectedRevision: run.revision })
  const actions = {
    async prepare(intent) {
      const run = await store.getRun(task.id), existing = run.actions.find(action => action.id === intent.id)
      if (existing) {
        assert.equal(existing.parameterHash, intent.parameterHash)
        return { fresh: false, state: existing.state, receipt: existing.receipt }
      }
      const next = await store.prepareAction({ ...guard(run), action: intent })
      const entry = next.actions.find(action => action.id === intent.id)
      return { fresh: !existing, state: entry.state, receipt: entry.receipt }
    },
    async settle({ id, state, receipt }) { return store.settleAction({ ...guard(await store.getRun(task.id)), actionId: id, state, receipt }) }
  }
  const delivery = createForgeDelivery({ client: f.client, contract: f.contract, actions, authorize: async () => true })
  f.state.failWrite = true
  assert.equal((await delivery.openDraft({ actionId: 'persisted', title: 'Resume safely' })).status, 'unknown')
  await store.close(); store = await openRunStore({ directory })
  f.state.failWrite = false
  assert.equal((await delivery.openDraft({ actionId: 'persisted', title: 'Resume safely' })).status, 'unknown')
  assert.equal(f.state.mutations.length, 1)
  assert.equal((await store.getRun(task.id)).state, 'outcome_unknown')
})
