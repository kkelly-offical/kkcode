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
