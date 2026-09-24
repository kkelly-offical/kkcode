/** Host-approved language inspection. No project-auto-discovery or package install. */
export { createLanguageService, createLspTools, LSP_LANGUAGES, LanguageServiceError } from '../kernel/lsp/service.mjs'
export { createIsolatedLanguageServerConfigs } from '../kernel/lsp/image-preset.mjs'
