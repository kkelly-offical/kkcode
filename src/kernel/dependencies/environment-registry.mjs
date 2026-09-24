// Internal host capability registry. No Docker, filesystem, project config or
// model JSON dependency. Only the audited environment factory registers opaque
// handles with closures that perform real verification at each use.
const registered = new WeakMap()
export function registerNpmEnvironment(handle, { prepare, mount }) {
  if (!handle || typeof handle !== 'object' || !Object.isFrozen(handle) || typeof prepare !== 'function' || typeof mount !== 'function' || registered.has(handle)) throw new Error('Invalid dependency environment capability registration')
  registered.set(handle, Object.freeze({ prepare, mount }))
}
function operations(environment) {
  const found = registered.get(environment)
  if (!found) throw Object.assign(new Error('依赖环境不是宿主创建的真实句柄。'), { code: 'DEPENDENCY_NOT_READY' })
  return found
}
export function prepareNpmWorkspace({ environment, cwd, image, signal }) { return operations(environment).prepare({ cwd, image, signal }) }
export function resolveNpmEnvironmentMount({ environment, cwd, image, signal }) { return operations(environment).mount({ cwd, image, signal }) }
