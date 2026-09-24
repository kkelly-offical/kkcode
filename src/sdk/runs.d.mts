import type { Kernel, KernelOptions, TurnResult } from './index.mjs';
import type { RunStore, RunRecord, TaskContract, ActionSpec, ArtifactStore, ActionState, RunBudget, BudgetProfile, LocalFreePolicy } from './storage.mjs';
import type { TaskGraphHost } from './tasks.mjs';
export { openRunStore, createArtifactStore } from './storage.mjs';
export interface StrictLimits { cpus?: number; memory_mb?: number; pids?: number; tmp_mb?: number; max_output_bytes?: number; timeout_ms?: number }
export interface StrictExecutionBackend {
  readonly allowedToolNames: readonly string[];
  ensureReady(options: { cwd: string; contract: TaskContract; signal?: AbortSignal }): Promise<Record<string, unknown>>;
  runCommand(options: { command: string; args?: string[]; cwd: string; shell?: false; timeoutMs?: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string; [key: string]: unknown }>;
  executeTool(options: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface HostAcceptance { required: true; goal: Record<string, unknown>; testSources: string[]; baseRevision?: string; sourceBaseline?: Record<string, unknown> }
export interface RunModelLimits { budgetUsd: number; deadlineAt: number }
declare const localFreeBrand: unique symbol;
/** Real host-created capability, not serializable model/RPC approval. */
export interface LocalFreeInferenceAuthorization { readonly kind: 'local-free-inference'; readonly id: string; readonly [localFreeBrand]: true }
export declare function createLocalFreeInferenceAuthorization(options: { profile: BudgetProfile; baseUrl: string; apiKeyEnv?: string; maxRequests: number; maxTokens: number; expectedPolicy?: LocalFreePolicy | null; authorize: (request: Readonly<{ kind: 'local-free-inference'; policy: LocalFreePolicy; profile: BudgetProfile; apiFeesUsd: 0; concurrency: 1 }>) => boolean | Promise<boolean> }): Promise<LocalFreeInferenceAuthorization>;
export declare function isLocalFreeInferenceAuthorization(value: unknown): value is LocalFreeInferenceAuthorization;
export declare function localFreePolicy(authority: LocalFreeInferenceAuthorization): Readonly<LocalFreePolicy>;
export interface RunInput { runId: string; prompt: string; model?: string; providerType?: string; mode?: string; signal?: AbortSignal; output?: unknown; limits?: RunModelLimits }
export interface RunCoordinator {
  start(options: { id?: string; contract: TaskContract; sessionId?: string; limits?: RunModelLimits }): Promise<RunRecord>;
  inspect(runId: string): Promise<RunRecord>;
  attach(options: { runId: string; expectedRevision?: number; expectedOwnerEpoch?: number }): Promise<RunRecord>;
  execute(options: RunInput): Promise<{ run: RunRecord; turn: TurnResult; verified: boolean; awaitingDelivery: boolean; budget: RunBudget }>;
  resume(options: Omit<RunInput, 'prompt'> & { prompt?: string }): Promise<{ run: RunRecord; turn: TurnResult; verified: boolean; awaitingDelivery: boolean; budget: RunBudget }>;
  pause(options: { runId: string; reason?: string; expectedRevision?: number; expectedOwnerEpoch?: number }): Promise<RunRecord>;
  cancel(options: { runId: string; reason?: string; expectedRevision?: number; expectedOwnerEpoch?: number }): Promise<RunRecord>;
  reconcile(options: { runId: string; actionId: string; state: 'succeeded' | 'failed' | 'not_applied'; evidenceRefs: string[] }): Promise<RunRecord>;
  complete(options: { runId: string }): Promise<RunRecord>;
  verifiedCandidate(options: { runId: string; reconcileActionId?: string; preparedActionId?: string }): Promise<{ run: RunRecord; candidate: Record<string, unknown> }>;
  resumeDelivery(options: { runId: string; expectedRevision?: number }): Promise<RunRecord>;
  recordDeliveryReceipt(options: { runId: string; criterionId: string; inspectDelivery: () => Promise<Record<string, unknown>> }): Promise<RunRecord>;
  actionAdapter(runId: string): { authorize(action: ActionSpec): Promise<boolean>; lookup(action: ActionSpec): Promise<{ fresh: false; state: string; receipt: unknown } | null>; prepare(action: ActionSpec): Promise<{ fresh: boolean; state: string; receipt: unknown }>; settle(input: { id: string; state: Exclude<ActionState, 'prepared'>; receipt?: { evidenceRefs?: string[]; summary?: string } }): Promise<RunRecord> };
  close(): Promise<void>;
}
export declare function createRunCoordinator(options: { kernel: Kernel; store: RunStore; artifacts: ArtifactStore; actor: { accountId: string; projectId: string }; ownerId?: string; authorize: (request: Readonly<Record<string, unknown>>) => Promise<boolean | { actorId: string; reason: string }> | boolean | { actorId: string; reason: string }; executionBackend: StrictExecutionBackend; acceptance?: HostAcceptance | null; taskGraph?: TaskGraphHost; toolAllowlist?: string[]; modelRole?: 'review' | 'implementation'; budgetProfiles?: BudgetProfile[]; hostBindingHash?: string | null; localFreeAuthorization?: LocalFreeInferenceAuthorization; leaseDirectory?: string; verifyDeliveryBinding?: (input: { run: RunRecord; receipt: Record<string, unknown> }) => boolean | Promise<boolean> }): RunCoordinator;
export declare function verifyRunHostBinding(options: { run: RunRecord; artifacts: ArtifactStore; hostBindingHash?: string | null }): Promise<{ verified: true; hostBindingHash: string | null }>;
export declare function createDelegatedKernel(options: KernelOptions & { cwd: string }): Promise<Kernel>;
export declare function createDockerExecutionBackend(options: { image: string; limits?: StrictLimits; networkOrigins?: string[]; delegationEnabled?: boolean; dependencyEnvironment?: import('./environments.mjs').NpmEnvironment }): StrictExecutionBackend;
export declare function inspectStrictIsolation(options: { image: string }): Promise<Record<string, unknown>>;
export declare function taskWorkspaceBaseline(cwd: string): Promise<{ cwd: string; commit: string }>;
export declare function createTaskWorkspace(options: { cwd: string; expectedCommit: string; parent?: string; maxFiles?: number; maxBytes?: number }): Promise<{ cwd: string; sourceCwd: string; baseRevision: string; originalWorkingTreeUnchanged: true }>;
