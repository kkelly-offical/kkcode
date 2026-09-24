/** Node-only trusted-host memory API. Never expose confirmMemory's callback or
 * synthesize its approval from model-authored JSON. */
export { createMemoryController, MemoryError } from '../kernel/index.mjs'
