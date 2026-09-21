/** Single release-policy source shared by local checks and the publishing job. */
export function releaseVersionPolicy(version) {
  const match = typeof version === 'string' && /^1\.0\.(0|[1-9]\d*)(?:-(preview|rc)\.(0|[1-9]\d*))?$/.exec(version)
  if (!match || match[0] !== version || !Number.isSafeInteger(Number(match[1])) || (match[3] !== undefined && !Number.isSafeInteger(Number(match[3])))) {
    throw new Error('User release policy requires 1.0.x, 1.0.x-preview.N or 1.0.x-rc.N; an explicit policy change is required for a minor/major bump.')
  }
  const channel = match[2] || 'stable'
  return { version, channel, distTag: { stable: 'latest', preview: 'preview', rc: 'next' }[channel], prerelease: channel !== 'stable' }
}

export function releaseWorkspacePaths(manifest) {
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages
  if (!Array.isArray(workspaces)) throw new Error('Release manifest must declare its workspace paths')
  const paths = workspaces.map(value => {
    if (typeof value !== 'string' || !value || /[\\:#%*?\[\]{}\x00-\x1f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Release workspace paths must be explicit relative directories without glob patterns')
    }
    return value
  })
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate release workspace path')
  return paths
}

export function validateReleaseManifests(manifest, lockfile, workspaceManifests) {
  const policy = releaseVersionPolicy(manifest.version), expected = policy.version
  const sameVersion = (actual, source) => {
    if (actual !== expected) throw new Error(`${source} version must be ${expected}; found ${String(actual)}`)
  }
  sameVersion(lockfile?.version, 'package-lock.json')
  sameVersion(lockfile?.packages?.['']?.version, 'package-lock.json root entry')
  if (manifest.name !== lockfile?.name || manifest.name !== lockfile?.packages?.['']?.name) throw new Error('Root package and lockfile names must match')
  const paths = releaseWorkspacePaths(manifest)
  const lockedPaths = releaseWorkspacePaths(lockfile.packages[''])
  if (JSON.stringify([...paths].sort()) !== JSON.stringify([...lockedPaths].sort())) throw new Error('Root package and lockfile workspace lists must match')
  for (const directory of paths) {
    const workspace = workspaceManifests?.[directory], locked = lockfile.packages?.[directory]
    if (workspace?.private !== true) throw new Error(`${directory}/package.json must remain private; publishing workspaces requires an explicit policy change`)
    sameVersion(workspace?.version, `${directory}/package.json`)
    sameVersion(locked?.version, `package-lock.json ${directory}`)
    if (!workspace?.name || workspace.name !== locked?.name) throw new Error(`${directory} package and lockfile names must match`)
  }
  return { ...policy, workspaces: paths }
}

/** Non-tag manual runs verify artifacts but never authorize a publication. */
export function resolveReleaseMetadata({ version, refType, refName }) {
  const policy = releaseVersionPolicy(version)
  if (refType !== 'tag') return { publish: false, release_version: version, dist_tag: '', prerelease: false }
  if (refName !== `v${version}`) throw new Error('Release tag must exactly match the validated package version with a v prefix')
  return { publish: true, release_version: version, dist_tag: policy.distTag, prerelease: policy.prerelease }
}
