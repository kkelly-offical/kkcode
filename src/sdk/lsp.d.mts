export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'kotlin';
export type LanguageOperation = 'diagnostics' | 'symbols' | 'definition' | 'references';
export declare const LSP_LANGUAGES: readonly Language[];
export declare class LanguageServiceError extends Error { code: string }
export interface LanguageServerConfiguration { command: string; args?: string[]; initializationOptions?: Record<string, unknown> }
export interface LanguageServiceOptions {
  cwd: string; servers: Partial<Record<Language, LanguageServerConfiguration>>;
  mode?: 'strict' | 'host'; image?: string; timeoutMs?: number;
  dependencyEnvironment?: import('./environments.mjs').NpmEnvironment;
  authorizeStart(request: Readonly<{ workspace: string; mode: 'strict' | 'host'; image: string | null; language: Language; command: string; args: string[]; fingerprint: string }>): boolean | Promise<boolean>;
}
export interface LanguageQuery { operation: LanguageOperation; path: string; line?: number; character?: number; signal?: AbortSignal }
export interface LanguagePosition { line: number; character: number }
export interface LanguageItem {
  path: string; range: { start: LanguagePosition; end: LanguagePosition };
  name?: string; kind?: number | null; severity?: number | null; message?: string; source?: string;
}
export interface LanguageResult {
  operation: LanguageOperation; language: Language; path: string; sourceHash: string;
  items: LanguageItem[]; filteredLocations: number; truncated: boolean; readOnlyProtocol: true;
  diagnosticMode: 'pull_full' | 'push_snapshot' | 'typescript_sync' | null;
  isolation: { backend: 'docker' | 'host'; strict: boolean; network?: 'none'; dependencyEnvironment?: import('./environments.mjs').NpmEnvironmentBinding }; note?: string;
}
export interface LanguageService {
  readonly strict: boolean; readonly workspace: string;
  inspect(query: LanguageQuery): Promise<LanguageResult>;
  status(): { mode: 'strict' | 'host'; configured: Language[]; running: number; closed: boolean };
  close(): void;
}
export declare function createLanguageService(options: LanguageServiceOptions): Promise<LanguageService>;
/** Configures only the separately built, locked Linux/amd64 LSP image. No install or pull. */
export declare function createIsolatedLanguageServerConfigs(languages?: readonly Language[]): Partial<Record<Language, LanguageServerConfiguration>>;
export declare function createLspTools(): Array<{
  name: 'lsp'; description: string; inputSchema: Record<string, unknown>;
  capabilityFor(): 'read'; execute(args: LanguageQuery, context: { lspService: LanguageService; cwd: string; signal?: AbortSignal }): Promise<{ output: string }>;
}>;
