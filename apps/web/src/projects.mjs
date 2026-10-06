// A project is an exact working directory on a device, not a basename or prefix.
export function projectPathKey(value) {
  const path = typeof value === 'string' ? value : ''
  if (!path) return ''
  const windows = /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path)
  if (windows) return path.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US')
  return path === '/' ? path : path.replace(/\/+$/, '')
}

export function projectName(path) {
  return String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path || '未指定目录'
}

export function sessionProjects(sessions, currentPath = '', deviceId = '') {
  const projects = new Map()
  for (const path of [currentPath, ...sessions.map(item => item.cwd)]) {
    const key = projectPathKey(path)
    if (key && !projects.has(key)) projects.set(key, { key, id: JSON.stringify([deviceId, key]), path, name: projectName(path), count: 0, running: 0 })
  }
  for (const session of sessions) {
    const project = projects.get(projectPathKey(session.cwd))
    if (!project || session.archived) continue
    project.count++
    if (/^running(?:-|$)/.test(session.status || '')) project.running++
  }
  return [...projects.values()].sort((a, b) => Number(b.key === projectPathKey(currentPath)) - Number(a.key === projectPathKey(currentPath)) || a.name.localeCompare(b.name))
}

export function projectSessions(sessions, path) {
  if (!path) return sessions
  const key = projectPathKey(path)
  return sessions.filter(session => projectPathKey(session.cwd) === key)
}
