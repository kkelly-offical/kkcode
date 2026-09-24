import { LSP_LANGUAGES } from './service.mjs'

/** Explicit host convenience for the separately built containers/lsp image.
 * Does not install, inspect or pull an image and never enables a host fallback. */
export function createIsolatedLanguageServerConfigs(languages = LSP_LANGUAGES) {
  if (!Array.isArray(languages) || !languages.length || languages.length > 5 || languages.some(language => !LSP_LANGUAGES.includes(language))) throw new Error('Choose supported languages from the locked LSP image')
  return Object.fromEntries(languages.map(language => [language, Object.freeze({
    command: '/usr/local/bin/node', args: Object.freeze(['/opt/kkcode-lsp/launch.mjs', language]),
    initializationOptions: Object.freeze(['typescript', 'javascript'].includes(language)
      ? { disableAutomaticTypingAcquisition: true, tsserver: Object.freeze({ useSyntaxServer: 'never' }) }
      : language === 'go' ? { staticcheck: false } : {})
  })]))
}
