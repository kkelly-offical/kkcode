export interface DeviceEvent { schemaVersion: '1'; id: string; seq: number; sessionId: string; type: string; payload: unknown; timestamp: number }
export interface ContextUsage { tokens: number; limit: number; percent: number; outputReserved?: number; inputBudget?: number; requiredTokens?: number; source: 'estimated' | 'count-api' | 'provider-usage'; estimated: boolean; components: { system?: number; tools?: number; messages?: number }; updatedAt?: number }
export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface SessionInfo { id: string; title?: string; cwd?: string; model?: string; providerType?: string; status?: string; archived?: boolean; context?: ContextUsage; [key: string]: unknown }
export interface AttachmentInfo { id: string; sessionId: string; name: string; mediaType: string; size: number; createdAt: number; expiresAt: number }
export interface FolderListing { path: string; parent: string | null; roots: string[]; entries: { name: string; path: string; directory: boolean }[] }
export interface BranchSnapshot { cwd: string; current: string | null; head: string | null; clean: boolean; stateToken: string; branches: Record<string, unknown>[]; remoteBranches: Record<string, unknown>[]; worktrees: { path: string; branch: string | null; head: string | null; locked: boolean; prunable: boolean; current: boolean }[]; [key: string]: unknown }
export interface DeviceProfile { beginner: boolean; languages: string[]; tech_stack: string[]; design_style: string; extra_notes: string }
export interface ExtensionsInfo { skills: Record<string, unknown>[]; mcp: Record<string, unknown>[] | Record<string, unknown>; plugins: Record<string, unknown>[] }
export type EmptyParams = Record<string, never>;
export type WorkspaceParams = { sessionId?: string; cwd?: string };
export type BranchMutation = WorkspaceParams & { name: string; stateToken: string; confirmed: true; startPoint?: string };
export interface DeviceMethods {
  'status': { params: EmptyParams; result: { schemaVersion: '1'; device: Record<string, unknown>; roots: string[]; active: string[]; retention: Record<string, unknown> } };
  'folders.list': { params: { path?: string }; result: FolderListing };
  'files.read': { params: { path: string }; result: { path: string; content: string } };
  'media.preview': { params: { sessionId: string; messageId: string; index: number }; result: { type: 'image'; data: string; mediaType: string } };
  'sessions.list': { params: { cwd?: string; limit?: number }; result: SessionInfo[] };
  'sessions.get': { params: { sessionId: string; before?: string; limit?: number }; result: SessionInfo & { messages: Record<string, unknown>[]; parts: Record<string, unknown>[] } };
  'sessions.create': { params: { cwd: string; mode?: string; model?: string; provider?: string; title?: string }; result: { id: string; cwd: string } };
  'sessions.update': { params: { sessionId: string; title?: string; expectedTitleRevision?: number; archived?: boolean }; result: SessionInfo };
  'sessions.configure': { params: { sessionId: string; mode?: string; model?: string; provider?: string }; result: SessionInfo };
  'sessions.delete': { params: { sessionId: string; confirmed: true }; result: { deleted: boolean; recoverable: boolean; filesChanged: false } };
  'sessions.rewind': { params: { sessionId: string; confirmed: true; messageId?: string; expectedLastMessageId?: string }; result: { ok: boolean; prompt?: string; filesChanged: false } };
  'turns.start': { params: { sessionId: string; prompt: string; attachmentIds?: string[]; mode?: string; model?: string; provider?: string; skill?: string }; result: { accepted: true; turnId: string } };
  'turns.cancel': { params: { sessionId: string }; result: Record<string, unknown> };
  'control.acquire': { params: { sessionId: string; takeover?: boolean }; result: Record<string, unknown> };
  'control.release': { params: { sessionId: string }; result: Record<string, unknown> };
  'events.list': { params: { sessionId: string; after?: number }; result: { events: DeviceEvent[]; cursor: number; gap?: boolean } };
  'approvals.resolve': { params: { sessionId: string; id: string; answer: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | Record<string, unknown> }; result: { resolved: true } };
  'commands.list': { params: WorkspaceParams; result: Record<string, unknown>[] };
  'commands.run': { params: { sessionId: string; command: string }; result: Record<string, unknown> };
  'settings.get': { params: EmptyParams; result: Record<string, unknown> };
  'settings.update': { params: { config: Record<string, unknown> }; result: Record<string, unknown> };
  'extensions.list': { params: WorkspaceParams; result: ExtensionsInfo };
  'extensions.reload': { params: WorkspaceParams; result: ExtensionsInfo };
  'models.discover': { params: { provider?: string; refresh?: boolean; connection?: { type?: string; protocol?: string; base_url?: string; api_key?: string; api_key_env?: string; endpoints?: Record<string, string>; default_model?: string } }; result: { models: { id: string; [key: string]: unknown }[]; provider?: string; source: string; stale?: boolean } };
  'profile.get': { params: EmptyParams; result: DeviceProfile };
  'profile.update': { params: { profile: Partial<DeviceProfile> }; result: DeviceProfile };
  'attachments.upload': { params: { sessionId: string; name: string; mediaType: string; data: string }; result: AttachmentInfo };
  'attachments.list': { params: { sessionId: string }; result: { attachments: AttachmentInfo[]; limits: Record<string, number> } };
  'attachments.remove': { params: { sessionId: string; id: string }; result: { removed: boolean } };
  'branches.list': { params: WorkspaceParams; result: BranchSnapshot };
  'branches.switch': { params: BranchMutation; result: BranchSnapshot };
  'branches.create': { params: BranchMutation; result: BranchSnapshot };
  'worktrees.list': { params: WorkspaceParams; result: BranchSnapshot };
  'worktrees.create': { params: WorkspaceParams & { name: string; parent: string; folderName: string; startPoint?: string; stateToken: string; confirmed: true }; result: BranchSnapshot & { created: Record<string, unknown> } };
  'worktrees.open': { params: WorkspaceParams & { path: string; stateToken: string; confirmed: true }; result: { id: string; cwd: string; sessionId: string; originalSessionUnchanged: true } };
}
export interface DeviceRequest { id: string; method: string; params?: Record<string, unknown>; issuedAt?: number }
export interface DeviceCredentials { access_token: string; refresh_token: string; expires_in: number; profile?: Record<string, unknown> }
export declare const PROTOCOL_VERSION: '1';
export declare class DeviceClient {
  constructor(options: { url: string; token?: string; deviceId?: string | null; gateway?: boolean; refreshToken?: string | null; onCredentials?: (credentials: DeviceCredentials) => void | Promise<void>; fetch?: typeof fetch; headers?: Record<string, string>; retries?: number });
  deviceId: string | null;
  token?: string;
  refresh(options?: { signal?: AbortSignal }): Promise<unknown>;
  http<T = unknown>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal; id?: string; issuedAt?: number }): Promise<T>;
  call<M extends keyof DeviceMethods>(method: M, params: DeviceMethods[M]['params'], options?: { signal?: AbortSignal; id?: string; issuedAt?: number }): Promise<DeviceMethods[M]['result']>;
  listDevices<T = unknown>(options?: { signal?: AbortSignal }): Promise<T>;
  profile<T = unknown>(options?: { signal?: AbortSignal }): Promise<T>;
  stream(sessionId: string, options?: { after?: number; signal?: AbortSignal; onEvent?: (event: DeviceEvent) => void | Promise<void>; onMeta?: (state: Record<string, unknown>) => void | Promise<void>; onGap?: (state: Record<string, unknown>) => void | Promise<void> }): Promise<'closed'>;
  events(sessionId: string, options?: { after?: number; signal?: AbortSignal; interval?: number }): AsyncGenerator<DeviceEvent>;
}
