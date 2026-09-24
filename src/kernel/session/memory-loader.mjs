import { runtimeCwd } from '../core/runtime-context.mjs'
import { createMemoryController } from './memory-controller.mjs'

/** Only scoped, host-confirmed or deterministically verified references enter
 * the prompt. Legacy files remain intact and require an explicit migration. */
export async function loadAutoMemory(cwd = runtimeCwd()) {
  try {
    const memory = createMemoryController({ cwd })
    const text = await memory.formatForPrompt()
    const legacy = await memory.legacySources()
    const notice = legacy.sources.length
      ? '\nLegacy memory files exist on this device. Their contents were not automatically migrated or injected. The user can explicitly import them as reviewable candidates through memory management; files have not been deleted.'
      : ''
    return [text, notice].filter(Boolean).join('\n')
  } catch {
    // Never fall back to unscoped notes on identity/storage errors, and never
    // copy malformed JSON or private file contents into provider diagnostics.
    return 'Scoped memory is currently unavailable. No unverified or cross-account memory was loaded. Continue using current task instructions; the user can inspect memory storage locally.'
  }
}
