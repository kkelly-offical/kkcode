import type { RunCoordinator } from './runs.mjs';
import type { RunRecord } from './storage.mjs';
export type ForgeKind = 'github' | 'gitlab';
export interface ForgeRepository {
  readonly kind: ForgeKind; readonly origin: string; readonly project: string;
  readonly apiBase: string; readonly id: string; readonly webUrl: string; readonly remote: string;
}
export declare class ForgeError extends Error { code: string; httpStatus: number | null }
/** Identity only. Unknown hosts require an explicit host-selected kind. Credentials are forbidden. */
export declare function parseForgeRemote(remote: string, options?: { kind?: ForgeKind; apiBase?: string }): ForgeRepository;
export interface ForgeRequest {
  number: number; nodeId: string | null; sourceBranch: string; targetBranch: string;
  headSha: string; state: string; draft: boolean; title: string; body: string; url: string;
  mergeable: boolean | null; mergeState: string; discussionsResolved: boolean | null;
}
export interface ForgeComment { id: number; body: string; author: string; source: 'remote_untrusted'; url: string; commitSha?: string; path?: string }
export interface ForgeCheck { id: number; name: string; kind: 'check_run' | 'status' | 'job'; appId: number | null; sha: string; status: string; pipelineStatus?: string; pipelineId?: number }
export interface ForgeReviewState { approved: number; decision: string; unresolved: number | null; headSha?: string; mergeState?: string }
export interface SignalOptions { signal?: AbortSignal }
export interface ForgeClient {
  readonly repository: ForgeRepository;
  validateText(...values: string[]): void;
  getBranch(name: string, options?: SignalOptions & { allowMissing?: boolean }): Promise<string | null>;
  getRequest(number: number, options?: SignalOptions): Promise<ForgeRequest>;
  listRequests(options: SignalOptions & { sourceBranch: string; targetBranch: string }): Promise<ForgeRequest[]>;
  listComments(number: number, options?: SignalOptions): Promise<ForgeComment[]>;
  listChecks(candidateSha: string, options?: SignalOptions): Promise<ForgeCheck[]>;
  reviewState(number: number, options?: SignalOptions): Promise<ForgeReviewState>;
  /** Ungoverned HTTP primitives for trusted host composition only. Prefer ForgeDelivery. */
  createDraft(options: SignalOptions & { sourceBranch: string; targetBranch: string; title: string; body: string }): Promise<ForgeRequest>;
  updateDraft(number: number, options: SignalOptions & { title: string; body: string }): Promise<ForgeRequest>;
  postComment(number: number, options: SignalOptions & { body: string }): Promise<unknown>;
  markReady(number: number, options?: SignalOptions): Promise<ForgeRequest>;
}
/** Token/endpoint come from trusted host settings, never from repository/project or model data. */
export declare function createForgeClient(options: { repository: ForgeRepository; token: string; allowPrivate?: boolean; timeoutMs?: number }): ForgeClient;
export type ForgeActionKind = 'forge.push' | 'forge.draft.create' | 'forge.draft.update' | 'forge.comment' | 'forge.ready';
export interface ForgeContract {
  runId: string; repositoryId: string; sourceBranch: string; targetBranch: string;
  targetSha: string; candidateSha: string;
  requiredChecks: Array<{ kind: 'check_run' | 'status' | 'job'; name: string; appId?: number }>;
  requiredApprovals?: number; allowedExternalActions: ForgeActionKind[];
}
export interface ForgeActionIntent { id: string; kind: ForgeActionKind; target: string; parameterHash: string; effect: 'external_write'; retryPolicy: 'reconcile' }
export interface ForgeReceipt { evidenceRefs: string[]; summary: string }
export interface ForgeActionAdapter {
  lookup?(intent: ForgeActionIntent): Promise<{ fresh: false; state: string; receipt?: ForgeReceipt | null } | null>;
  prepare(intent: ForgeActionIntent): Promise<{ fresh: boolean; state: 'prepared' | 'succeeded' | 'failed' | 'unknown' | 'not_applied'; receipt?: ForgeReceipt | null }>;
  settle(outcome: { id: string; state: 'succeeded' | 'unknown' | 'not_applied'; receipt: ForgeReceipt }): Promise<unknown>;
}
export interface ForgeOperationResult {
  actionId: string; status: 'succeeded' | 'failed' | 'unknown' | 'not_applied' | 'changed_after_success';
  replayed: false; reconciled?: boolean; result?: ForgeRequest | ForgeComment | { id: string; sha: string } | null; receipt?: ForgeReceipt | null; message?: string;
}
export interface ForgeInspection {
  runId: string; repositoryId: string; number: number; candidateSha: string; targetSha: string; status: 'blocked' | 'ready_for_review' | 'mergeable';
  reasons: string[]; request: ForgeRequest; checks: ForgeCheck[]; reviews: ForgeReviewState;
  comments: ForgeComment[]; observedAt: string; canMergeAutomatically: false;
}
export interface ForgeDeliveryOptions {
  client: ForgeClient; contract: ForgeContract; actions: ForgeActionAdapter;
  /** Must check current host grant AND current local candidate verification. Model approval JSON is invalid. */
  authorize(intent: ForgeActionIntent, context: Readonly<{
    runId: string; repositoryId: string; commitSha: string; targetSha: string;
    sourceBranch: string; targetBranch: string; payload: Record<string, unknown>;
  }>): Promise<boolean>;
  /** Host-controlled Git executor; literal approved remote and SHA refspec, no force, no project endpoint credentials. */
  push?(request: SignalOptions & { repository: ForgeRepository; sourceBranch: string; candidateSha: string; refspec: string; force: false }): Promise<unknown>;
}
export declare class ForgeDelivery {
  constructor(options: ForgeDeliveryOptions);
  readonly client: ForgeClient; readonly contract: Readonly<ForgeContract>;
  pushCandidate(options: SignalOptions & { actionId: string }): Promise<ForgeOperationResult>;
  openDraft(options: SignalOptions & { actionId: string; title: string; body?: string }): Promise<ForgeOperationResult>;
  updateDraft(options: SignalOptions & { actionId: string; number: number; title: string; body?: string }): Promise<ForgeOperationResult>;
  postComment(options: SignalOptions & { actionId: string; number: number; body: string }): Promise<ForgeOperationResult>;
  inspect(options: SignalOptions & { number: number }): Promise<ForgeInspection>;
  markReady(options: SignalOptions & { actionId: string; number: number }): Promise<ForgeOperationResult>;
}
export declare function createForgeDelivery(options: ForgeDeliveryOptions): ForgeDelivery;

export interface GitPushTransport {
  readonly candidateSha: string; readonly tree: string; readonly repositoryId: string;
  push: NonNullable<ForgeDeliveryOptions['push']>;
  files(): Promise<Array<{ path: string; kind: 'file' | 'symlink'; hash: string; size?: number; executable?: boolean }>>;
  close(): Promise<void>;
}
/** Host-only: creates a clean immutable bare snapshot. Domain remotes require a
 * Git build supporting http.curloptResolve; never uses workspace Git settings. */
export declare function createGitPushTransport(options: {
  cwd: string; repository: ForgeRepository; candidateSha: string; sourceBranch: string;
  targetBranch: string; targetSha: string; token: string; allowPrivate?: boolean; timeoutMs?: number;
}): Promise<GitPushTransport>;
export interface RunForgeBinding {
  readonly schema: 'kk.run-forge-binding.v1'; readonly runId: string; readonly repositoryId: string;
  readonly candidateHash: string; readonly candidateGeneration: number; readonly contractVersion: number;
  readonly candidateSha: string; readonly tree: string; readonly baseRevision: string;
  readonly sourceBranch: string; readonly targetBranch: string; readonly targetSha: string;
}
/** Requires actual independent local acceptance from the live coordinator.
 * Persist binding.candidateSha outside the workspace to resume an identical
 * operation; model-provided SHA/approval claims are never acceptance evidence. */
export declare function createRunForgeDelivery(options: {
  coordinator: RunCoordinator; runId: string; repository: ForgeRepository; token: string;
  sourceBranch: string; targetBranch: string; targetSha: string; candidateSha?: string | null;
  requiredChecks?: ForgeContract['requiredChecks']; requiredApprovals?: number; allowPrivate?: boolean;
  authorizeDelivery: ForgeDeliveryOptions['authorize']; reconcileActionId?: string | null;
}): Promise<{
  delivery: ForgeDelivery; binding: RunForgeBinding;
  verifyReceipt(input: { run: RunRecord; receipt: ForgeInspection }): Promise<boolean>;
  close(): Promise<void>;
}>;

/** Reads only an exact pre-existing intent; never calls prepare, authorizes a
 * new write or requires the current local worktree to still be unchanged. */
export declare function createForgeReconciler(options: {
  client: ForgeClient; contract: ForgeContract;
  actions: Pick<ForgeActionAdapter, 'settle'> & Required<Pick<ForgeActionAdapter, 'lookup'>>;
}): { reconcile(options: SignalOptions & {
  operation: 'push' | 'draft' | 'update' | 'comment' | 'ready';
  request: { actionId: string; number?: number; title?: string; body?: string };
}): Promise<ForgeOperationResult & { readOnly: true; candidateRevalidated: false; requiresReverification: true; targetChanged?: boolean }> };
