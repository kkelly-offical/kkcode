import type { BudgetProfile } from './storage.mjs';
export type { BudgetProfile } from './storage.mjs';

export type TaskModelRole = 'planning' | 'implementation' | 'review' | 'compaction' | 'title';
export type ModelEvidenceSource = 'configuration' | 'catalog' | 'inference' | 'unknown' | 'adapter';
/** Use the actual host ConfigState so inherited data-policy and trust sources remain available. */
export interface ModelConfigState { config: Record<string, any>; source?: Record<string, any>; userConfig?: Record<string, any> }
export interface TaskModelRoute {
  role: TaskModelRole; providerType: string; model: string; baseUrl: string | null; apiKeyEnv: string | null;
  source: 'configured-role' | 'legacy-stage' | 'conversation'; overridden: boolean;
}
export interface ProviderProfile {
  schemaVersion: 1; provider: string; model: string; protocol: string; endpointOrigin: string; scope: string;
  capabilities: Record<string, { value: boolean | null; source: ModelEvidenceSource }>;
  continuity: { kind: 'responses-native-output' | 'anthropic-completed-compaction-response' | 'none' };
  context: { limit: number; source: 'configuration' | 'inference'; estimated: boolean; catalogLimit: number | null; note: string };
  output: { reserved: number; declaredLimit: number | null; source: 'configuration' | 'bounded-default' };
  catalog: { available: boolean; fetchedAt: number | null };
  compatibility: { endpointTested: false; note: string };
}
export declare const TASK_MODEL_ROLES: readonly TaskModelRole[];
export declare function resolveTaskModel(configState: ModelConfigState, input: {
  role: TaskModelRole; providerType?: string | null; model?: string | null; baseUrl?: string | null;
  apiKeyEnv?: string | null; legacyModel?: string | null;
}): Promise<TaskModelRoute>;
/** No network, paid inference, model discovery or credential/query disclosure. */
export declare function resolveProviderProfile(configState: ModelConfigState, providerName?: string | null, modelId?: string | null): Promise<ProviderProfile>;

/** Select an actual host-configured route. Never provide raw credentials here. */
export interface BudgetProfileSelection {
  providerType?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
}
/** Prepare a proposed price/window profile from the actual host ConfigState and
 * its configured prices or matching cached catalog. No network, inference,
 * consent or persistence. Have the host review it before starting; the durable
 * coordinator freezes the approved profile. UI-redacted config is insufficient.
 * The returned profile contains no raw credential, URL or environment name. */
export declare function prepareBudgetProfile(configState: ModelConfigState, input: BudgetProfileSelection): Promise<BudgetProfile>;
/** Prepare the default, explicit role and selected legacy model profiles before
 * host approval. This does not automatically authorize any of those models. */
export declare function prepareBudgetProfiles(configState: ModelConfigState): Promise<BudgetProfile[]>;
