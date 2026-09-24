/** Local host integration. Authorization/recording methods must never be exposed
 * verbatim as model tools. Browser downloads return scoped artifact references. */
export { createBrowserController, createBrowserTool, browserStatus } from '../kernel/browser/controller.mjs'
export { createBrowserBridgeController, authorizeBrowserBridge, revokeBrowserBridge } from '../kernel/browser/bridge.mjs'
export { installBrowserBridge, browserBridgeStatus } from '../kernel/browser/bridge-runtime.mjs'
