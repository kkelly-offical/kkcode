export type TaskNodeState = 'pending' | 'preparing' | 'ready' | 'running' | 'needs_review' | 'accepted' | 'failed' | 'unknown' | 'cancelled';
export type TaskGraphState = 'pending' | 'running' | 'needs_review' | 'accepted' | 'blocked' | 'cancelled';
export interface TaskGraphContext { parentRunId: string; ownerEpoch: number; invocationId?: string; signal?: AbortSignal; }
export interface TaskBrief { task_id?: string; prompt: string; write_scope?: 'read-only' | 'write' | 'workspace'; depends_on?: string[]; budget_usd?: number; deadline_at?: number; criteria?: { id: string; description: string }[]; }
export interface TaskGraphNode {
  id: string; prompt: string; role: 'review' | 'writer'; dependsOn: string[]; budgetUsd: number; deadlineAt: number;
  childRunId: string; sessionId: string; tools: string[]; criteria: { id: string; description: string }[];
  state: TaskNodeState; workspace: string | null; candidateHash: string | null; evidenceRefs: string[];
  resultArtifactRef: string | null; parentResultRef: string | null; approvalRef: string | null; costUsd: number; errorCode: string | null;
  startedAt: number | null; finishedAt: number | null;
}
export interface TaskGraph {
  version: 1; id: string; revision: number; ownerEpoch: number; createdAt: number; deadlineAt: number;
  budgetUsd: number; maxConcurrency: number; parentCandidateHash: string; baseRevision: string;
  proposalHash: string; approvalRef: string; cancelRequestedAt: number | null; status: TaskGraphState; nodes: TaskGraphNode[];
}
export interface TaskGraphHost {
  propose(input: { graphId?: string; tasks: TaskBrief[]; budgetUsd?: number; deadlineAt?: number; maxConcurrency?: number }, context: TaskGraphContext): Promise<TaskGraph>;
  inspect(graphId: string, context: TaskGraphContext): Promise<TaskGraph | null>;
  execute(graphId: string, context: TaskGraphContext): Promise<TaskGraph>;
  recover(graphId: string, context: TaskGraphContext): Promise<TaskGraph>;
  approveResult(graphId: string, nodeId: string, input: { expectedRevision: number; candidateHash: string }, context: TaskGraphContext): Promise<TaskGraph>;
  cancel(graphId: string, context: TaskGraphContext): Promise<TaskGraph>;
  delegateTask(args: TaskBrief, context: TaskGraphContext): Promise<Record<string, unknown>>;
  delegateTaskGroup(args: { tasks: TaskBrief[]; budget_usd?: number; deadline_at?: number; max_concurrency?: number }, context: TaskGraphContext): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export interface TaskGraphHostOptions {
  store: Record<string, any>; artifacts: Record<string, any>; actor: { accountId: string; projectId: string };
  configState: Record<string, any>; image: string; trustState?: Record<string, any>;
  /** A real branded host-prepared dependency environment, never model JSON. */
  dependencyEnvironment?: import('./environments.mjs').NpmEnvironment;
  authorize(request: Readonly<Record<string, any>>, control?: { signal?: AbortSignal }): Promise<boolean | { approved?: boolean; actorId: string; reason: string }> | boolean | { approved?: boolean; actorId: string; reason: string };
  workspaceDirectory?: string; lockDirectory?: string; maxBudgetUsd?: number; deadlineAt?: number; maxConcurrency?: number;
}
export function createTaskGraphHost(options: TaskGraphHostOptions): TaskGraphHost;
export function isTaskGraphHost(value: unknown): value is TaskGraphHost;
export function normalizeTaskGraph(value: unknown): TaskGraph;
export function assertTaskGraphTransition(previous: TaskGraph | null, next: TaskGraph, options?: { ownerEpoch?: number }): TaskGraph;
export const TASK_GRAPH_STATES: readonly TaskGraphState[];
export const TASK_NODE_STATES: readonly TaskNodeState[];
