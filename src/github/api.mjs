const API_BASE = "https://api.github.com"

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  }
}

async function ghFetch(token, path, params = {}) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.href, { headers: headers(token) })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`GitHub API ${res.status}: ${path} — ${body.slice(0, 200)}`)
  }
  return res.json()
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
  const branches = await ghFetch(token, `/repos/${owner}/${repo}/branches`, { per_page: 100 })
  return branches.map((b) => ({
    name: b.name,
    protected: b.protected
  }))
}

export async function getRepo(token, owner, repo) {
  const r = await ghFetch(token, `/repos/${owner}/${repo}`)
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
