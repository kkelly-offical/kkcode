import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright-core'
import { createKernel } from '../kernel/index.mjs'
import { createBrowserController } from '../kernel/browser/controller.mjs'
import { effectiveDataPolicy } from '../kernel/permission/data-policy.mjs'
import { createBrowserRecipeStore, createScopedBrowserRecipeStore } from '../kernel/browser/recipes.mjs'
import { createBrowserRecipeFixtureRunner } from '../kernel/browser/recipe-fixture.mjs'

export { BrowserRecipeError, createBrowserRecipeStore, createScopedBrowserRecipeStore, createBrowserRecipeAuthority } from '../kernel/browser/recipes.mjs'
export { createBrowserRecipeFixtureRunner } from '../kernel/browser/recipe-fixture.mjs'

/** Trusted-host convenience only, never a remote/model RPC. Uses a fresh
 * bundled, sandboxed browser and the effective inherited data policy. The
 * temporary profile is closed with the host; personal profiles stay separate. */
export async function createBrowserRecipeHost({ authority, fixture = undefined, rootDir = undefined, cwd = process.cwd(), headless = false } = {}) {
  const kernel = await createKernel({ cwd, boot: false })
  const browser = createBrowserController({ headless })
  const ctx = { sessionId: `recipe-host-${randomUUID()}`, strictManagedBrowser: true, configState: kernel.configState, config: { data_policy: effectiveDataPolicy(kernel.configState), tool: { browser: { chromium_sandbox: true, executable_path: chromium.executablePath() } } } }
  let store
  try {
    const options = { rootDir, cwd, authority,
      ...(fixture ? { fixtureRunner: createBrowserRecipeFixtureRunner({ ...fixture, browserConfig: ctx.config }) } : {}),
      executor: { observe: () => browser.observe({ sessionId: ctx.sessionId }), execute: (step, { signal, origin, fingerprint, authorize }) => browser.execute(step, { ...ctx, signal, recipeGuard: { origin, fingerprint, authorize } }) }
    }
    store = rootDir ? createBrowserRecipeStore(options) : await createScopedBrowserRecipeStore(options)
  }
  catch (error) { await browser.shutdown(); await kernel.shutdown(); throw error }
  return Object.freeze({ store,
    open: url => browser.execute({ action: 'open', url }, ctx),
    attachRecorder: recorder => browser.attachRecorder({ sessionId: ctx.sessionId, recorder }),
    async close() { try { await store.shutdown(); await browser.shutdown() } finally { await kernel.shutdown() } }
  })
}
