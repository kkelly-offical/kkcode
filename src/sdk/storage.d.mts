/** Experimental trusted-host APIs, not autonomous execution or remote authorization. */
export type RunState = 'running' | 'waiting_input' | 'waiting_approval' | 'paused' | 'verification_failed' | 'outcome_unknown' | 'cancelled' | 'completed';
export type ActionState = 'prepared' | 'succeeded' | 'failed' | 'unknown' | 'not_applied';
export interface TaskContract {
  objective: string;
  nonGoals?: string[];
  allowedPaths?: string[];
  allowedExternalActions?: string[];
  allowedTools?: string[];
  allowedNetworkOrigins?: string[];
  requiredCriteria: { id: string; description: string }[];
}
export interface RunGuard { runId: string; expectedRevision: number; ownerId: string; ownerEpoch: number }
export interface HostApproval { approved: true; actorId: string; reason: string }
export interface ActionSpec {
  id: string; kind: string; target: string; parameterHash: string;
  effect: 'read' | 'local_write' | 'external_write';
  retryPolicy: 'safe' | 'idempotent' | 'reconcile' | 'never';
  context?: { sessionId: string; turnId: string; invocationId: string; durableTurnId: string };
}
export interface ActionReceipt { evidenceRefs: string[]; summary: string | null }
export interface VerificationSpec {
  id: string; criterionId: string; candidateHash: string;
  status: 'passed' | 'failed' | 'unknown' | 'not_applicable';
  evidenceRefs?: string[];
}
export interface RunRecord {
  id: string; state: RunState; revision: number; ownerId: string; ownerEpoch: number;
  binding: RunBinding | null; lastTurn: RunTurn | null;
  budget: RunBudget | null;
  contractVersion: number; contract: Required<TaskContract>;
  candidateHash: string | null; candidateGeneration: number; createdAt: number; updatedAt: number;
  actions: (ActionSpec & { state: ActionState; ownerEpoch: number; receipt: ActionReceipt | null; createdAt: number; updatedAt: number })[];
  verifications: (VerificationSpec & { evidenceRefs: string[]; candidateGeneration: number; contractVersion: number; createdAt: number })[];
}
export interface RunBinding { sessionId: string; cwd: string; accountId: string; projectId: string; contractApprovalRef?: string; importedSessionRef?: string }
export interface RunTurn { id: string; sequence: number; inputHash: string; inputArtifactRef: string; hostContextRefs: string[]; status: string; startedAt: number; ownerEpoch: number; resultArtifactRef?: string; endedAt?: number }
export type RunSummary = Pick<RunRecord, 'id' | 'state' | 'revision' | 'ownerId' | 'ownerEpoch' | 'updatedAt'>;
export interface RunEvent { sequence: number; runId: string; revision: number; type: string; data: Record<string, unknown>; createdAt: number }
export interface RunStoreBackup { schema: 'kk.run-store-backup.v1'; id: string; version: 1 | 2; applicationId: number; createdAt: number; sha256: string; size: number }
export interface ModelBudgetRequest {
  requestId: string; kind: 'model' | 'delegation'; provider: string; model: string;
  reservedUsd: number; amountUsd: number | null; status: 'reserved' | 'settled' | 'unknown';
  ownerEpoch: number; createdAt: number; settledAt: number | null; evidenceRefs?: string[]; profileId?: string;
  /** Local-free cumulative authorization, not observed token usage; never refunded. */
  tokenAllowance?: number;
}
export interface BudgetProfile { version: 1; id: string; provider: string; model: string; protocol: 'openai' | 'anthropic' | 'responses' | 'ollama'; scopeHash: string; contextLimit: number; maxTokens: number; compaction: boolean; rates: { input: number; output: number; cacheRead: number; cacheWrite: number }; source: 'manual' | 'catalog' | 'built-in' }
/** Private host metadata, not a remotely accepted grant. Only a verified,
 * branded host authority may establish the actual local inference capability. */
export interface LocalFreePolicy {
  version: 1; id: string; provider: string; model: string;
  protocol: 'openai' | 'anthropic' | 'responses' | 'ollama';
  /** Canonical literal 127.0.0.1 / [::1] HTTP(S), no credentials/query/fragment. */
  baseUrl: string;
  scopeHash: string;
  maxRequests: number;
  /** Total conservatively authorized tokens across the entire task, not actual usage. */
  maxTokens: number;
  listener: { pid: number; uid: number; fd: number; inode: string; startTimeTicks: string; executable: string };
}
export interface RunBudget {
  budgetUsd: number; deadlineAt: number; spentUsd: number; reservedUsd: number; unknownUsd: number;
  requests: ModelBudgetRequest[]; profiles: BudgetProfile[];
  /** Private storage projection: never forward listener, endpoint or scope identity remotely. */
  localFreePolicy?: LocalFreePolicy;
  usedRequests?: number;
  /** Cumulative token allowance, including settled calls; not actual token usage. */
  reservedTokens?: number;
}
export interface RunStore {
  createRun(input: { id?: string; contract: TaskContract; ownerId: string; binding?: RunBinding; initialState?: 'running' | 'waiting_input' | 'paused' }): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord>;
  listRuns(input?: { limit?: number; states?: RunState[]; sessionId?: string; accountId?: string; cwd?: string; after?: { id: string; updatedAt: number } }): Promise<RunSummary[]>;
  claimRun(input: { runId: string; expectedRevision: number; expectedOwnerId: string; expectedOwnerEpoch: number; ownerId: string; approval: HostApproval }): Promise<RunRecord>;
  transitionRun(input: RunGuard & { state: RunState; reason?: string }): Promise<RunRecord>;
  requestControl(input: { runId: string; expectedRevision: number; expectedOwnerId: string; expectedOwnerEpoch: number; kind: 'pause' | 'cancel'; requestId: string; approval: HostApproval }): Promise<RunRecord>;
  beginTurn(input: RunGuard & { turnId: string; inputHash: string; inputArtifactRef: string; hostContextRefs?: string[] }): Promise<RunRecord>;
  endTurn(input: RunGuard & { turnId: string; state: RunState; resultArtifactRef?: string; reason?: string }): Promise<RunRecord>;
  prepareAction(input: RunGuard & { action: ActionSpec }): Promise<RunRecord>;
  settleAction(input: RunGuard & { actionId: string; state: Exclude<ActionState, 'prepared'>; receipt?: { evidenceRefs?: string[]; summary?: string } }): Promise<RunRecord>;
  setCandidate(input: RunGuard & { candidateHash: string }): Promise<RunRecord>;
  recordVerification(input: RunGuard & { receipt: VerificationSpec }): Promise<RunRecord>;
  reviseContract(input: RunGuard & { contract: TaskContract; approval: HostApproval }): Promise<RunRecord>;
  events(input: { runId: string; after?: number; limit?: number }): Promise<RunEvent[]>;
  getTaskGraph(input: { runId: string; graphId: string }): Promise<import('./tasks.mjs').TaskGraph | null>;
  listTaskGraphs(input: { runId: string }): Promise<import('./tasks.mjs').TaskGraph[]>;
  updateTaskGraph(input: RunGuard & { graphId: string; expectedGraphRevision: number; graph: import('./tasks.mjs').TaskGraph }): Promise<import('./tasks.mjs').TaskGraph>;
  getRunBudget(input: { runId: string }): Promise<RunBudget | null>;
  configureRunBudget(input: RunGuard & { budgetUsd: number; deadlineAt: number; profiles?: BudgetProfile[]; localFreePolicy?: LocalFreePolicy; approval: HostApproval }): Promise<RunBudget>;
  approveRunBudgetProfile(input: RunGuard & { profile: BudgetProfile; approval: HostApproval }): Promise<RunBudget>;
  reserveModelBudget(input: RunGuard & { requestId: string; amountUsd: number; provider: string; model: string } & ({ kind?: 'model'; profileId: string; tokenAllowance?: number } | { kind: 'delegation'; profileId?: never; tokenAllowance?: never })): Promise<{ fresh: boolean; budget: RunBudget; request: ModelBudgetRequest }>;
  settleModelBudget(input: RunGuard & ({ requestId: string; status: 'settled'; amountUsd: number } | { requestId: string; status: 'unknown'; amountUsd: null })): Promise<RunBudget>;
  reconcileModelBudget(input: RunGuard & { requestId: string; amountUsd: number; evidenceRefs: string[]; approval: HostApproval }): Promise<RunBudget>;
  createBackup(): Promise<RunStoreBackup>;
  listBackups(): Promise<RunStoreBackup[]>;
  verifyBackup(input: { id: string }): Promise<RunStoreBackup & { valid: true; runCount: number }>;
  restoreBackup(input: { id: string; directory: string }): Promise<{ restored: true; directory: string; backupId: string; version: 1 | 2; sha256: string }>;
  readonly workerPid: number;
  close(): Promise<void>;
}
export type ReadOnlyRunStore = Pick<RunStore, 'getRun' | 'listRuns' | 'events' | 'getTaskGraph' | 'listTaskGraphs' | 'getRunBudget' | 'listBackups' | 'verifyBackup' | 'workerPid' | 'close'>;
export interface RunStoreOptions { directory?: string; requestTimeoutMs?: number; readOnly?: boolean }
export declare function openRunStore(options: RunStoreOptions & { readOnly: true }): Promise<ReadOnlyRunStore>;
export declare function openRunStore(options?: Omit<RunStoreOptions, 'readOnly'> & { readOnly?: false }): Promise<RunStore>;
export declare function openRunStore(options: RunStoreOptions): Promise<RunStore | ReadOnlyRunStore>;
export declare const RUN_STATES: readonly RunState[];
export declare const ACTION_STATES: readonly ActionState[];
export declare const RUN_STORE_SCHEMA_VERSION: number;
export interface LegacySessionSnapshot { migrationId: string; source: string; sessions: number; files: number; bytes: number; originalPreserved: true; historyCompleteness: 'source_snapshot_only' }
export declare function inspectLegacySessions(source: string): Promise<LegacySessionSnapshot>;
export declare function resolveMigrationBackupDirectory(source: string, directory: string): Promise<string>;
export declare function importLegacySessions(input: { source: string; backupDirectory: string; store: RunStore; artifacts: ArtifactStore; actor: { accountId: string; projectId: string }; ownerId: string; expectedMigrationId?: string; expectedBackupDirectory?: string }): Promise<{ migrationId: string; backupDirectory: string; imported: { runId: string; sessionId: string; artifactId: string; alreadyImported: boolean }[]; originalPreserved: true; historyCompleteness: 'source_snapshot_only' }>;

/** These identifiers MUST be derived by the trusted host, never copied from a caller's untrusted arguments. */
export interface ArtifactActor { accountId: string; projectId: string; sessionId: string; runId: string }
export interface ArtifactSource { kind: 'tool' | 'web' | 'document' | 'user' | 'system'; toolCallId?: string; messageId?: string; operationId?: string }
export interface ArtifactLimits { fileBytes: number; runBytes: number; deviceBytes: number; retentionMs: number; pageBytes: number; searchBytes: number; lockTimeoutMs: number }
export interface ArtifactMetadata {
  schemaVersion: number; id: string; sha256: string; size: number; mime: string; createdAt: number;
  scope: ArtifactActor; source: ArtifactSource;
  retention: { active: boolean; resolved: boolean; pinned: boolean; references: string[]; retired?: boolean; updatedAt: number };
}
export interface ArtifactIdentity { actor: ArtifactActor; id: string }
export interface ArtifactPage { id: string; sha256: string; size: number; offset: number; encoding: 'base64'; data: string; nextCursor: string | null }
export interface ArtifactStorageInspection { schemaVersion: 1; checkToken: string; healthy: boolean; indexed: number; totalBytes: number; quarantinedBytes: number; issues: { id: string; kind: string; artifactId?: string; sha256?: string; size?: number; repairable: boolean }[]; recoveries: { recoveryId: string; state: string; size: number; restorable: boolean }[] }
/** Minimal local handle surface; callers need not install Node declarations to consume the SDK types. */
export interface ArtifactDownloadHandle {
  close(): Promise<void>;
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  readFile(options: { encoding: 'utf8' } | 'utf8'): Promise<string>;
  readFile(): Promise<Uint8Array>;
}
export declare const ARTIFACT_LIMITS: Readonly<ArtifactLimits>;
export declare class ArtifactStoreError extends Error { code: string; status: number; constructor(code: string, message: string, status?: number) }
export declare class ArtifactStore {
  constructor(options?: { root?: string; limits?: Partial<ArtifactLimits>; clock?: () => number });
  put(input: { actor: ArtifactActor; content: string | Uint8Array | AsyncIterable<string | Uint8Array>; mime?: string; source?: ArtifactSource; signal?: AbortSignal }): Promise<ArtifactMetadata>;
  getMetadata(input: ArtifactIdentity): Promise<ArtifactMetadata>;
  read(input: ArtifactIdentity & { cursor?: string; limit?: number }): Promise<ArtifactPage>;
  search(input: ArtifactIdentity & { query: string; cursor?: string; maxBytes?: number; maxMatches?: number }): Promise<{ id: string; sha256: string; matches: { offset: number; length: number; readCursor: string }[]; scannedBytes: number; nextCursor: string | null }>;
  list(input: { actor: ArtifactActor; cursor?: string; limit?: number }): Promise<{ items: ArtifactMetadata[]; nextCursor: string | null }>;
  setRetention(input: ArtifactIdentity & { active?: boolean; resolved?: boolean; references?: string[] }): Promise<ArtifactMetadata>;
  pin(input: ArtifactIdentity & { pinned?: boolean }): Promise<ArtifactMetadata>;
  delete(input: ArtifactIdentity): Promise<{ id: string; deleted: boolean }>;
  prune(input: { actor: ArtifactActor }): Promise<{ removed: string[] }>;
  reconcileRetention(input: { actor: ArtifactActor; active: boolean; resolved: boolean; references?: Record<string, string[]>; retired?: boolean }): Promise<{ matched: number; changed: number }>;
  pruneRetired(input: { accountId: string; protectedSessions?: string[] }): Promise<{ removed: string[] }>;
  /** Local trusted host maintenance only; these are deliberately not remote RPCs. */
  inspectStorage(): Promise<ArtifactStorageInspection>;
  quarantineOrphans(input: { checkToken: string; issueIds: string[]; confirmed: true }): Promise<{ quarantined: { recoveryId: string; size: number }[]; recoverable: true; note: string }>;
  restoreQuarantined(input: { recoveryId: string; confirmed: true }): Promise<{ recoveryId: string; restored: true }>;
  /** Local-only. The caller must close the handle. No host path crosses the SDK. */
  openDownload(input: ArtifactIdentity): Promise<{ metadata: ArtifactMetadata; handle: ArtifactDownloadHandle }>;
}
export declare function createArtifactStore(options?: ConstructorParameters<typeof ArtifactStore>[0]): ArtifactStore;
