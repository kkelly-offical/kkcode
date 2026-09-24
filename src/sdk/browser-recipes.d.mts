export interface BrowserRecipeAuthority { readonly __browserRecipeAuthority?: never }
export type BrowserRecipeState = 'candidate' | 'reviewed' | 'validated' | 'enabled' | 'disabled' | 'invalidated';
export interface BrowserRecipeStep {
  action: 'snapshot' | 'open' | 'click' | 'fill' | 'press'; role?: string; name?: string; nameParameter?: string;
  valueParameter?: string; pathParameter?: string; inputType?: string; key?: string;
}
export interface BrowserRecipeCandidate {
  schema: 'kk.browser-recipe.v1'; origin: string; fingerprint: string; steps: BrowserRecipeStep[];
  parameters: Record<string, { kind: 'text' | 'path' | 'target'; maxLength: number }>;
}
export interface BrowserRecipeValidation {
  recipeHash: string; fixtureHash: string; isolated: true; network: 'blocked'; executedSteps: number; assertions: number; at: number;
}
export interface BrowserRecipeRecord {
  id: string; hash: string; candidate: BrowserRecipeCandidate; state: BrowserRecipeState; revision: number;
  createdAt: number; updatedAt: number; reviewedAt?: number; enabledAt?: number; validation?: BrowserRecipeValidation | null; invalidation?: string | null;
}
export interface BrowserRecipeFixtureReceipt { hash: string; fixtureHash: string; isolated: true; network: 'blocked'; executedSteps: number; assertions: boolean[] }
export interface BrowserRecipeExecutor {
  observe(options: { signal?: AbortSignal }): Promise<{ origin: string; fingerprint: string }>;
  execute(step: { action: string; role?: string; name?: string; value?: string; url?: string; key?: string }, options: { signal?: AbortSignal; recipeId: string; hash: string; origin: string; fingerprint: string; authorize(): Promise<true>; recordedInputType?: string }): Promise<unknown>;
}
export interface BrowserRecipeRecorder {
  readonly id: string; readonly origin: string; readonly expiresAt: number; readonly signal: AbortSignal;
  isActive(): boolean;
  record(event: { action: string; role?: string; name?: string; inputType?: string; key?: string; value?: string; url?: string }): Promise<{ recorded: boolean; reason?: string; steps?: number }>;
  finish(): Promise<BrowserRecipeRecord | { id: string; closed: true; empty: true } | { id: string; cancelled: true }>;
  cancel(): Promise<BrowserRecipeRecord | { id: string; closed: true; empty: true } | { id: string; cancelled: true }>;
}
export interface BrowserRecipeStore {
  list(): Promise<Array<{ id: string; hash: string; state: BrowserRecipeState; origin: string; steps: number; updatedAt: number }>>;
  get(options: { id: string }): Promise<BrowserRecipeRecord>;
  start(options: { origin: string; minutes?: number; signal?: AbortSignal }): Promise<BrowserRecipeRecorder>;
  review(options: { id: string; hash: string }): Promise<BrowserRecipeRecord>;
  validate(options: { id: string; hash: string; signal?: AbortSignal }): Promise<BrowserRecipeRecord>;
  enable(options: { id: string; hash: string }): Promise<BrowserRecipeRecord>;
  disable(options: { id: string }): Promise<BrowserRecipeRecord>;
  run(options: { id: string; hash: string; parameters?: Record<string, string>; signal?: AbortSignal }): Promise<{ id: string; hash: string; completedSteps: number; status: 'completed' }>;
  shutdown(): Promise<void>;
}
export class BrowserRecipeError extends Error { code: string; details: Record<string, unknown> }
export function createBrowserRecipeAuthority(options: { confirm(request: Readonly<{ action: 'record' | 'review' | 'enable'; id?: string; hash?: string; candidate?: BrowserRecipeCandidate; origin?: string; fingerprint?: string; minutes?: number; warning?: string; validation?: BrowserRecipeValidation }>): Promise<boolean> }): BrowserRecipeAuthority;
export function createBrowserRecipeStore(options?: {
  rootDir?: string; authority?: BrowserRecipeAuthority; executor?: BrowserRecipeExecutor;
  fixtureRunner?: (input: { id: string; hash: string; candidate: BrowserRecipeCandidate; signal?: AbortSignal }) => Promise<BrowserRecipeFixtureReceipt>;
  now?: () => number;
}): BrowserRecipeStore;
export function createScopedBrowserRecipeStore(options?: {
  cwd?: string; authority?: BrowserRecipeAuthority; executor?: BrowserRecipeExecutor;
  fixtureRunner?: (input: { id: string; hash: string; candidate: BrowserRecipeCandidate; signal?: AbortSignal }) => Promise<BrowserRecipeFixtureReceipt>;
  now?: () => number;
}): Promise<BrowserRecipeStore>;
export function createBrowserRecipeFixtureRunner(options: { html: string; parameters?: Record<string, string>; assertions: string[]; browserConfig?: Record<string, unknown> }): (input: { hash: string; candidate: BrowserRecipeCandidate; signal?: AbortSignal }) => Promise<BrowserRecipeFixtureReceipt>;
export function createBrowserRecipeHost(options?: { authority?: BrowserRecipeAuthority; fixture?: { html: string; parameters?: Record<string, string>; assertions: string[] }; rootDir?: string; cwd?: string; headless?: boolean }): Promise<{ store: BrowserRecipeStore; open(url: string): Promise<unknown>; attachRecorder(recorder: BrowserRecipeRecorder): Promise<unknown>; close(): Promise<void> }>;
