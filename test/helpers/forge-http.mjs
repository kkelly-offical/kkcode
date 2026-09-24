import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseForgeRemote } from '../../src/kernel/forge/repository.mjs'
import { gitNullDevice } from '../../src/util/controlled-git.mjs'
const exec = promisify(execFile)
export const TOKEN = 'synthetic-local-git-token'
export async function createGitHttpFixture(t, { kind = 'github', initialFiles = {} } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kk-forge-http-')), cwd = path.join(base, 'source'), repositories = path.join(base, 'repos'), remote = path.join(repositories, 'org', 'repo.git')
  await mkdir(cwd); await mkdir(path.dirname(remote), { recursive: true })
  const git = (args, where = cwd) => exec('git', args, { cwd: where, env: { ...process.env, GIT_CONFIG_GLOBAL: gitNullDevice(), GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 1024 * 1024 })
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid'])
  await writeFile(path.join(cwd, 'app.txt'), 'baseline\n')
  for (const [name, content] of Object.entries(initialFiles)) await writeFile(path.join(cwd, name), content)
  await git(['add', '.']); await git(['commit', '-m', 'base'])
  const targetSha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  await git(['init', '--bare', remote]); await git(['config', 'http.receivepack', 'true'], remote)
  await git(['push', remote, 'HEAD:refs/heads/main'])
  await writeFile(path.join(cwd, 'app.txt'), 'sealed candidate\n'); await git(['add', '.']); await git(['commit', '-m', 'candidate'])
  const candidateSha = (await git(['rev-parse', 'HEAD'])).stdout.trim(), requests = []
  let redirect = false, pull = null, hideAfterUpdate = false, hidden = false
  const effects = []
  const currentSha = async ref => (await git(['rev-parse', '--verify', `refs/heads/${ref}`], remote)).stdout.trim()
  const pullData = async () => kind === 'github'
    ? { number: 1, node_id: 'PR_fixture', state: 'open', draft: true, title: pull.title, body: pull.body, mergeable: true, mergeable_state: 'draft',
      base: { ref: 'main', sha: await currentSha('main'), repo: { full_name: 'org/repo' } }, head: { ref: 'kk/verified', sha: await currentSha('kk/verified'), repo: { full_name: 'org/repo' } } }
    : { iid: 1, state: 'opened', draft: true, title: pull.title, description: pull.description, sha: await currentSha('kk/verified'),
      source_project_id: 1, target_project_id: 1, source_branch: 'kk/verified', target_branch: 'main', detailed_merge_status: 'draft_status', blocking_discussions_resolved: true }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture'), route = decodeURIComponent(url.pathname)
    if (route.startsWith('/api/')) {
      const body = await Array.fromAsync(request).then(chunks => Buffer.concat(chunks).toString())
      const data = body ? JSON.parse(body) : null
      const send = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
      if ((kind === 'github' ? request.headers.authorization !== `Bearer ${TOKEN}` : request.headers['private-token'] !== TOKEN)) return send({}, 401)
      // Complete, deliberately non-passing read observations for the CLI
      // inspect flow. Empty CI/review lists must not be interpreted as ready.
      if (kind === 'github' && route === '/api/graphql') return send({ data: { repository: { pullRequest: {
        headRefOid: await currentSha('kk/verified'), reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'DRAFT',
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
      } } } })
      if (kind === 'github' && /\/commits\/[^/]+\/check-runs$/.test(route)) return send({ check_runs: [] })
      const status = /\/commits\/([a-f0-9]+)\/status$/.exec(route)
      if (kind === 'github' && status) return send({ sha: status[1], statuses: [] })
      if (kind === 'github' && /\/(?:pulls\/1\/reviews|pulls\/1\/comments|issues\/1\/comments)$/.test(route)) return send([])
      const branch = /\/(?:repository\/)?branches\/(.+)$/.exec(route)
      if (branch) {
        try { const commit = await currentSha(branch[1]); return send({ commit: kind === 'github' ? { sha: commit } : { id: commit } }) }
        catch { return send({}, 404) }
      }
      if (/\/(pulls|merge_requests)$/.test(route)) {
        if (request.method === 'GET') return send(pull ? [await pullData()] : [])
        effects.push({ operation: 'draft', body: data }); pull = data; return send(await pullData(), 201)
      }
      if (/\/(pulls|merge_requests)\/1$/.test(route)) {
        if (!pull) return send({}, 404)
        if (hidden) return send({}, 503)
        if (request.method !== 'GET') { effects.push({ operation: 'update', body: data }); pull = { ...pull, ...data }; if (hideAfterUpdate) { hidden = true; return send({}, 503) } }
        return send(await pullData())
      }
      return send({}, 404)
    }
    requests.push({ path: request.url, auth: request.headers.authorization === `Basic ${Buffer.from(`${kind === 'github' ? 'x-access-token' : 'oauth2'}:${TOKEN}`).toString('base64')}`, agent: request.headers['user-agent'] })
    if (redirect) { response.writeHead(302, { location: 'http://127.0.0.1:9/unapproved' }); response.end(); return }
    if (!requests.at(-1).auth) { response.writeHead(401); response.end(); return }
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: repositories, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method,
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] || '', REMOTE_USER: 'fixture',
      ...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
    request.pipe(child.stdin); child.stdin.on('error', () => {}); child.stderr.resume()
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', () => { response.writeHead(500); response.end() })
    child.on('close', () => {
      const output = Buffer.concat(chunks), separator = output.indexOf('\r\n\r\n')
      if (separator < 0) { response.writeHead(500); response.end(); return }
      let status = 200
      const headers = {}
      for (const line of output.subarray(0, separator).toString().split('\r\n')) {
        const index = line.indexOf(':'); if (index < 0) continue
        if (line.slice(0, index).toLowerCase() === 'status') status = Number(line.slice(index + 1).trim().split(' ')[0])
        else headers[line.slice(0, index)] = line.slice(index + 1).trim()
      }
      response.writeHead(status, headers); response.end(output.subarray(separator + 4))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(base, { recursive: true, force: true }) })
  const repository = parseForgeRemote(`http://127.0.0.1:${server.address().port}/org/repo.git`, { kind })
  return { base, cwd, remote, git, repository, targetSha, candidateSha, requests, effects, redirect() { redirect = true },
    hideAfterUpdate() { hideAfterUpdate = true }, reveal() { hidden = false; hideAfterUpdate = false } }
}
