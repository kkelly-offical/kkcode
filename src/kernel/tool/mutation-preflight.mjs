import {resolveWorkspacePath} from './workspace-fs.mjs'
import {assertAtomicWriteTarget} from './edit-transaction.mjs'
import {runtimeCwd} from '../core/runtime-context.mjs'

const NAMES = new Set(['write', 'edit', 'patch', 'multiedit', 'notebookedit'])
const builtins = new WeakSet()

// Registration is by trusted implementation identity, never model/plugin JSON
// metadata or an extension's chosen name. The registry alone calls this for
// its native builtins. Strict OCI tools retain their own virtual-path preflight.
export function registerAtomicMutationPreflights(tools) {
  for (const tool of tools) if (NAMES.has(tool.name)) builtins.add(tool)
  return tools
}

export async function validateAtomicMutationPreflight(tool, args, context = {}) {
  if (!builtins.has(tool)) return
  const paths = Array.isArray(args?.changes) ? args.changes.map(change => change.path) : [args?.path]
  const seen = new Set()
  for (const requested of paths) {
    context.signal?.throwIfAborted()
    if (typeof requested !== 'string') continue // schema validation owns types
    const target = await resolveWorkspacePath(context.cwd || runtimeCwd(), requested)
    if (seen.has(target)) continue
    seen.add(target)
    await assertAtomicWriteTarget(target)
  }
}
