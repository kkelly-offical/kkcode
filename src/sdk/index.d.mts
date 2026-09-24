export * from './client.mjs';
export interface KernelEvent { type: string; sessionId?: string; turnId?: string; payload?: Record<string, unknown>; timestamp?: number }
export interface KernelOptions {
  cwd?: string; config?: Record<string, unknown>; configState?: Record<string, unknown>;
  trust?: boolean; trustState?: { trusted?: boolean }; boot?: boolean;
  services?: { lsp?: import('./lsp.mjs').LanguageService; office?: import('./office.mjs').OfficeService };
  dependencyEnvironment?: import('./environments.mjs').NpmEnvironment | null;
  handlers?: {
    onEvent?: (event: KernelEvent) => void | Promise<void>;
    onOutput?: (event: unknown) => void;
    onPermissionPrompt?: (request: Record<string, unknown>) => unknown | Promise<unknown>;
    onQuestionPrompt?: (request: Record<string, unknown>) => unknown | Promise<unknown>;
  };
}
export interface TurnOptions {
  prompt: string; sessionId?: string; mode?: string; model?: string; providerType?: string;
  baseUrl?: string; apiKeyEnv?: string; maxIterations?: number; signal?: AbortSignal;
  contentBlocks?: readonly Record<string, unknown>[]; configState?: Record<string, unknown>;
  toolContext?: Record<string, unknown>; runSpec?: Record<string, unknown>; output?: unknown;
  allowQuestion?: boolean; steerSource?: (() => unknown);
}
export interface TurnResult { sessionId: string; reply?: string; status?: string; context?: import('./client.mjs').ContextUsage | null; usage?: Record<string, number>; [key: string]: unknown }
export interface KernelSession { id: string; cwd?: string; title?: string; status?: string; model?: string; context?: import('./client.mjs').ContextUsage | null; [key: string]: unknown }
export interface Kernel {
  readonly cwd: string; readonly configState: Record<string, unknown>; readonly trustState: { trusted?: boolean };
  executeTurn(options: TurnOptions): Promise<TurnResult>;
  turns: {
    executeTurn(options: TurnOptions): Promise<TurnResult>;
    newSessionId(): string;
    resolveMode(mode?: string): string;
    [key: string]: unknown;
  };
  sessions: {
    listSessions(options?: { cwd?: string; limit?: number; includeChildren?: boolean }): Promise<KernelSession[]>;
    getSession(id: string): Promise<{ session: KernelSession; messages: Record<string, unknown>[]; parts: Record<string, unknown>[] } | null>;
    deleteSession(id: string): Promise<{ deleted: boolean; recoverable?: boolean; filesChanged?: boolean }>;
    [key: string]: unknown;
  };
  events: { subscribe(listener: (event: KernelEvent) => void | Promise<void>): () => void; emit(event: KernelEvent): Promise<void>; listenerCount(): number; EVENT_TYPES: Readonly<Record<string, string>>; registerSink(listener: (event: KernelEvent) => void | Promise<void>): () => void };
  tools: { list(options?: Record<string, unknown>): Promise<import('./client.mjs').ToolDefinition[]>; get(name: string): Promise<unknown>; [key: string]: unknown };
  extensions: Record<string, unknown>; permissions: Record<string, unknown>; providers: Record<string, unknown>; background: Record<string, unknown>;
  diagnostics: { inspectPrompt(sessionId: string): Promise<Record<string, unknown>>; services(): Record<string, unknown>[] };
  bootExtensions(): Promise<unknown>;
  applyTrustState(state: { trusted?: boolean }): Promise<unknown>;
  run<T>(operation: () => T): T;
  shutdown(): Promise<void>;
}
export declare function createKernel(options?: KernelOptions): Promise<Kernel>;
