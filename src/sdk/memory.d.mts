export type MemoryScope = 'project' | 'personal';
export type MemoryCategory = 'project-fact' | 'workflow' | 'preference';
export type MemoryStatus = 'candidate' | 'active' | 'disabled' | 'stale';
export type LegacyMemorySource = 'auto-memory' | 'instincts' | 'project-memory';
export type MemoryEvidence =
  | { kind: 'proposal'; sessionId: string | null; turnId: string | null; observedAt: number }
  | { kind: 'project_file'; path: 'package.json'; sha256: string; schemaVersion: 1; observedAt: number; sessionId: string | null; turnId: string | null }
  | { kind: 'host_confirmation'; confirmedByHash: string; approvalIdHash: string; confirmedAt: number }
  | { kind: 'correction'; observedAt: number }
  | { kind: 'legacy_import'; source: LegacyMemorySource; sha256: string; importedAt: number };
export interface MemoryEntry {
  id: string; scope: MemoryScope; text: string; category: MemoryCategory; fingerprint: string;
  version: number; status: MemoryStatus; automatic: boolean; evidence: MemoryEvidence[];
  createdAt: number; updatedAt: number; factKey?: string | null;
  changes: { version: number; contentHash: string; reason: string; changedAt: number }[];
}
export interface MemoryList { scope: MemoryScope; revision: number; entries: MemoryEntry[] }
export interface MemoryKey { scope?: MemoryScope; id: string }
export interface MemoryMutation extends MemoryKey { expectedVersion: number }
export interface MemoryConfirmationRequest {
  action: 'memory.confirm' | 'memory.import-legacy' | 'memory.forget';
  scope: MemoryScope; entry?: MemoryEntry; source?: LegacyMemorySource; message?: string;
}
export interface MemoryHostDecision { approved: boolean; confirmedBy?: string; approvalId?: string }
export type MemoryProposal = MemoryEntry | { suppressed: true };
export interface MemoryController {
  propose(input: { scope?: MemoryScope; text: string; category?: MemoryCategory; sessionId?: string; turnId?: string }): Promise<MemoryProposal>;
  list(input?: { scope?: MemoryScope; includeCandidates?: boolean; includeDisabled?: boolean }): Promise<MemoryList>;
  get(input: MemoryKey): Promise<MemoryEntry>;
  correct(input: MemoryMutation & { text: string }): Promise<MemoryEntry>;
  /** Always invokes the host callback; model JSON cannot supply an approval. */
  confirm(input: MemoryMutation): Promise<MemoryEntry>;
  setEnabled(input: MemoryMutation & { enabled: boolean }): Promise<MemoryEntry>;
  forget(input: MemoryMutation): Promise<{ forgotten: true; id: string }>;
  observeProject(input?: { sessionId?: string; turnId?: string }): Promise<{ observed: number; entries: MemoryEntry[] }>;
  legacySources(): Promise<{ sources: { source: LegacyMemorySource; bytes: number; requiresConfirmation: true }[]; note: string }>;
  importLegacy(input: { source: LegacyMemorySource }): Promise<{ entries: MemoryProposal[]; rejected: number; truncated: boolean; source: LegacyMemorySource; activated: 0 }>;
  formatForPrompt(): Promise<string>;
}
export declare function createMemoryController(options: {
  cwd: string;
  confirmMemory?: (request: MemoryConfirmationRequest) => Promise<MemoryHostDecision> | MemoryHostDecision;
}): MemoryController;
export declare class MemoryError extends Error { code: string; status: number; constructor(code: string, message: string, status?: number) }
