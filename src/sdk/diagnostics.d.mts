import type { ReadOnlyRunStore, RunState } from './storage.mjs';
import type { Kernel } from './index.mjs';
export interface RunDiagnosis { schemaVersion: 1; runId: string; revision: number; state: RunState; candidateHash: string | null; blockers: { code: string; count: number; message: string }[]; criteria: { id: string; status: string }[]; note: string }
export declare function diagnoseRun(options: { store: ReadOnlyRunStore; runId: string }): Promise<RunDiagnosis>;
export declare function diagnoseKernel(options: { kernel: Kernel; sessionId?: string }): Promise<{ schemaVersion: 1; services: Record<string, unknown>[]; prompt: Record<string, unknown> | null; note: string }>;
