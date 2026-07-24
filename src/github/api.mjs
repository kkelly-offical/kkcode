import { buildRequestHeaders } from "../http/identity.mjs"

const API_BASE = "https://api.github.com"
const PAGE_SIZE = 100
const MAX_API_PAGES = 100
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/

export function validateGitHubRepository(owner, repo) {
  const normalizedOwner = String(owner || "")
  const normalizedRepo = String(repo || "")
  if (!GITHUB_OWNER_RE.test(normalizedOwner)) {
    throw new Error(`invalid GitHub repository owner: ${normalizedOwner}`)
  }
  if (!GITHUB_REPO_RE.test(normalizedRepo) || normalizedRepo === "." || normalizedRepo === "..") {
    throw new Error(`invalid GitHub repository name: ${normalizedRepo}`)
  }
  return { owner: normalizedOwner, repo: normalizedRepo }
}

function repositoryPath(owner, repo) {
  const validated = validateGitHubRepository(owner, repo)
  return `/repos/${encodeURIComponent(validated.owner)}/${encodeURIComponent(validated.repo)}`
}

function issueNumber(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`invalid GitHub issue or pull request number: ${value}`)
  }
  return number
}

function headers(token, accept = "application/vnd.github+json", contentType = "") {
  return buildRequestHeaders({
    target: "github",
    accept,
    contentType,
    authorization: `Bearer ${token}`,
    customHeaders: { "X-GitHub-Api-Version": "2022-11-28" }
  })
}

async function ghRequest(token, path, {
  params = {},
  method = "GET",
  body = null,
  accept = "application/vnd.github+json",
  responseType = "json"
} = {}) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.href, {
    method,
    headers: headers(token, accept, body === null ? "" : "application/json"),
    body: body === null ? undefined : JSON.stringify(body)
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`GitHub API ${res.status}: ${path} — ${body.slice(0, 200)}`)
  }
  if (responseType === "text") return res.text()
  if (res.status === 204) return null
  return res.json()
}

async function ghFetch(token, path, params = {}) {
  return ghRequest(token, path, { params })
}

export async function listUserRepos(token, { page = 1, perPage = 20, sort = "pushed" } = {}) {
  const repos = await ghFetch(token, "/user/repos", {
    sort,
    per_page: perPage,
    page,
    affiliation: "owner,collaborator,organization_member"
  })
  return repos.map((r) => ({
    full_name: r.full_name,
    name: r.name,
    owner: r.owner.login,
    description: r.description || "",
    default_branch: r.default_branch,
    stars: r.stargazers_count,
    pushed_at: r.pushed_at,
    private: r.private
  }))
}

export async function searchRepos(token, query, login) {
  const q = login ? `${query} user:${login}` : query
  const data = await ghFetch(token, "/search/repositories", { q, per_page: 20, sort: "updated" })
  return (data.items || []).map((r) => ({
    full_name: r.full_name,
    name: r.name,
    owner: r.owner.login,
    description: r.description || "",
    default_branch: r.default_branch,
    stars: r.stargazers_count,
    pushed_at: r.pushed_at,
    private: r.private
  }))
}

export async function listBranches(token, owner, repo) {
  const branches = await ghFetch(token, `${repositoryPath(owner, repo)}/branches`, { per_page: 100 })
  return branches.map((b) => ({
    name: b.name,
    protected: b.protected
  }))
}

export async function getRepo(token, owner, repo) {
  const r = await ghFetch(token, repositoryPath(owner, repo))
  return {
    full_name: r.full_name,
    name: r.name,
    owner: r.owner.login,
    description: r.description || "",
    default_branch: r.default_branch,
    stars: r.stargazers_count,
    pushed_at: r.pushed_at,
    private: r.private
  }
}

export async function getPullRequest(token, owner, repo, number) {
  return ghRequest(token, `${repositoryPath(owner, repo)}/pulls/${issueNumber(number)}`)
}

export async function getPullRequestDiff(token, owner, repo, number) {
  return ghRequest(token, `${repositoryPath(owner, repo)}/pulls/${issueNumber(number)}`, {
    accept: "application/vnd.github.v3.diff",
    responseType: "text"
  })
}

export async function compareCommits(token, owner, repo, base, head) {
  return ghRequest(
    token,
    `${repositoryPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  )
}

export async function listCommitCheckRuns(token, owner, repo, ref) {
  const output = []
  for (let page = 1; page <= MAX_API_PAGES; page++) {
    const data = await ghRequest(token, `${repositoryPath(owner, repo)}/commits/${encodeURIComponent(ref)}/check-runs`, {
      params: { per_page: PAGE_SIZE, page }
    })
    const batch = data?.check_runs || []
    output.push(...batch.map((check) => ({
      id: check.id,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      html_url: check.html_url,
      source: "check_run"
    })))
    const totalCount = Number(data?.total_count)
    if (batch.length < PAGE_SIZE || (Number.isFinite(totalCount) && output.length >= totalCount)) return output
  }
  throw new Error(`GitHub check runs exceeded ${MAX_API_PAGES * PAGE_SIZE} entries`)
}

export async function listCommitStatuses(token, owner, repo, ref) {
  const output = []
  for (let page = 1; page <= MAX_API_PAGES; page++) {
    const data = await ghRequest(token, `${repositoryPath(owner, repo)}/commits/${encodeURIComponent(ref)}/status`, {
      params: { per_page: PAGE_SIZE, page }
    })
    const batch = data?.statuses || []
    output.push(...batch.map((status) => ({
      id: status.id,
      name: status.context,
      status: status.state === "pending" ? "in_progress" : "completed",
      conclusion: status.state === "success"
        ? "success"
        : status.state === "pending" ? null : status.state,
      html_url: status.target_url,
      source: "commit_status"
    })))
    const totalCount = Number(data?.total_count)
    if (batch.length < PAGE_SIZE || (Number.isFinite(totalCount) && output.length >= totalCount)) return output
  }
  throw new Error(`GitHub commit statuses exceeded ${MAX_API_PAGES * PAGE_SIZE} entries`)
}

export async function listIssueComments(token, owner, repo, number) {
  const repository = repositoryPath(owner, repo)
  const issue = issueNumber(number)
  const comments = []
  for (let page = 1; page <= MAX_API_PAGES; page++) {
    const batch = await ghRequest(token, `${repository}/issues/${issue}/comments`, {
      params: { per_page: PAGE_SIZE, page }
    })
    comments.push(...batch)
    if (batch.length < PAGE_SIZE) return comments
  }
  throw new Error(`GitHub issue comments exceeded ${MAX_API_PAGES * PAGE_SIZE} entries`)
}

function hasExactMarker(body, marker) {
  return String(body || "")
    .split(/\r?\n/)
    .some((line) => line.trim() === marker)
}

export async function upsertPullRequestReviewComment(
  token,
  owner,
  repo,
  number,
  body,
  { authorLogin = "" } = {}
) {
  const validated = validateGitHubRepository(owner, repo)
  const issue = issueNumber(number)
  owner = validated.owner
  repo = validated.repo
  const marker = `<!-- kkcode-review:${owner}/${repo}#${issue} -->`
  const login = String(authorLogin || "").trim().toLowerCase()
  if (!login) throw new Error("GitHub login is required for safe review comment publishing")
  if (!hasExactMarker(body, marker)) {
    throw new Error("review comment body is missing its scoped KK Code marker")
  }
  const comments = await listIssueComments(token, owner, repo, number)
  const existing = comments.find((comment) =>
    String(comment.user?.login || "").toLowerCase() === login &&
    hasExactMarker(comment.body, marker)
  )
  if (existing) {
    if (String(existing.body || "") === String(body || "")) {
      return { action: "unchanged", comment: existing }
    }
    const comment = await ghRequest(
      token,
      `${repositoryPath(owner, repo)}/issues/comments/${issueNumber(existing.id)}`,
      {
        method: "PATCH",
        body: { body }
      }
    )
    return { action: "updated", comment }
  }
  const comment = await ghRequest(token, `${repositoryPath(owner, repo)}/issues/${issue}/comments`, {
    method: "POST",
    body: { body }
  })
  return { action: "created", comment }
}
