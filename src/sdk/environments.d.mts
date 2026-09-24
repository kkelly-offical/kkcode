export interface NpmEnvironmentLimits { packages: number; tarballBytes: number; downloadBytes: number; unpackBytes: number; unpackEntries: number; timeoutMs: number }
export interface NpmManifestHashes { packageJson: string; packageLock: string }
export interface NpmEnvironmentBinding { id: string; planId: string; treeHash: string; imageId: string }
export interface NpmPackage { path: string; version: string; resolved: string; integrity: string; selected: boolean }
export interface NpmEnvironmentPlan {
  readonly schema: 'kk.npm-plan.v1'; readonly id: string; readonly imageId: string;
  readonly manifestHashes: Readonly<NpmManifestHashes>; readonly platform: Readonly<{os: string; arch: string}>;
  readonly registryOrigins: readonly string[]; readonly allowPrivate: boolean; readonly limits: Readonly<NpmEnvironmentLimits>;
  readonly packages: readonly Readonly<NpmPackage>[]; readonly offlineScripts: 'separate_approval';
}
export interface NpmOfflineScript { path: string; event: 'preinstall'|'install'|'postinstall'; command: string; sha256: string }
export interface NpmOfflineScriptPlan {
  readonly schema: 'kk.npm-offline-scripts.v1'; readonly planId: string; readonly imageId: string;
  readonly scripts: readonly Readonly<NpmOfflineScript>[]; readonly scriptsHash: string; readonly network: 'none'; readonly limits: Readonly<NpmEnvironmentLimits>;
}
export interface NpmEnvironment {
  readonly schema: 'kk.npm-environment.v1'; readonly id: string; readonly directory: string; readonly planId: string; readonly imageId: string;
  readonly manifestHashes: Readonly<NpmManifestHashes>; readonly platform: Readonly<{os: string; arch: string}>;
  readonly registryOrigins: readonly string[]; readonly limits: Readonly<NpmEnvironmentLimits>;
  readonly status: 'ready'|'needs_offline_build'; readonly treeHash: string; readonly scripts: readonly Readonly<NpmOfflineScript>[];
  readonly scriptsHash: string; readonly files: number; readonly bytes: number;
}
export declare function inspectNpmEnvironment(options: {cwd: string; image: string; registryOrigins: readonly string[]; allowPrivate?: boolean; limits?: Partial<NpmEnvironmentLimits>; signal?: AbortSignal}): Promise<NpmEnvironmentPlan>;
export declare function prepareNpmEnvironment(options: {plan: NpmEnvironmentPlan; authorize: (plan: NpmEnvironmentPlan)=>boolean|Promise<boolean>; authorizeScripts?: (plan: NpmOfflineScriptPlan)=>boolean|Promise<boolean>; storageRoot?: string; signal?: AbortSignal}): Promise<NpmEnvironment>;
export declare function restoreNpmEnvironment(options: {directory: string; storageRoot?: string; signal?: AbortSignal}): Promise<NpmEnvironment>;
export declare function verifyNpmEnvironment(options: {environment: NpmEnvironment; cwd: string; image: string; signal?: AbortSignal}): Promise<{valid: true; id: string; planId: string; treeHash: string; imageId: string}>;
/** Explicitly creates an empty mountpoint only in a host-created task copy. */
export declare function prepareNpmWorkspace(options: {environment: NpmEnvironment; cwd: string; image: string; signal?: AbortSignal}): Promise<{prepared: true; workspace: string; environmentId: string}>;
export declare function isNpmEnvironment(value: unknown): value is NpmEnvironment;
