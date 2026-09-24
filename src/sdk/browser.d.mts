export interface BrowserAction {
  action: 'status' | 'open' | 'snapshot' | 'click' | 'fill' | 'press' | 'screenshot' | 'diagnostics' | 'viewport' | 'tabs' | 'new_tab' | 'select_tab' | 'close_tab' | 'frames' | 'dialogs' | 'upload' | 'download' | 'close';
  url?: string; tab_id?: string; frame_id?: string; snapshot_id?: string; ref?: string;
  role?: string; name?: string; selector?: string; value?: string; key?: string;
  artifact_id?: string; width?: number; height?: number; development?: boolean; websocketProtocol?: string;
  dialog_response?: { accept: boolean; promptText?: string };
}
export interface BrowserContext {
  sessionId: string; config?: Record<string, unknown>; configState?: unknown;
  artifactAccess?: object; toolCallId?: string; signal?: AbortSignal; strictManagedBrowser?: boolean;
  /** Trusted host-only narrowing guard, never reconstructed from RPC/model JSON. */
  recipeGuard?: {origin: string; fingerprint: string; authorize(): Promise<boolean>};
}
export interface BrowserRecorder {
  origin: string; signal: AbortSignal; expiresAt?: number; isActive(): boolean;
  record(event: {action: string; role: string; name: string; inputType?: string}): Promise<unknown> | unknown;
}
export interface BrowserController {
  execute(args: BrowserAction, context: BrowserContext): Promise<unknown>;
  observe(options: {sessionId: string}): Promise<{origin: string; fingerprint: string}>;
  attachRecorder(options: {sessionId: string; recorder: BrowserRecorder}): Promise<{detach(): Promise<void>}>;
  close(sessionId: string): Promise<void>; shutdown(): Promise<void>;
}
export declare function createBrowserController(options?: {headless?: boolean}): BrowserController;
export declare function createBrowserTool(): object;
export declare function browserStatus(options?: {executablePath?: string}): Promise<{installed: boolean; engine: string; setup: string | null; isolated: boolean}>;
export interface BridgeAction {
  action: 'status' | 'snapshot' | 'screenshot' | 'click' | 'fill' | 'tabs' | 'select_tab' | 'disconnect';
  snapshot_id?: string; ref?: string; value?: string; tab_list_id?: string; tab_id?: string;
}
export declare function createBrowserBridgeController(): {execute(args: BridgeAction, context: BrowserContext): Promise<unknown>; close(sessionId: string): Promise<void>; shutdown(): Promise<void>};
export declare function authorizeBrowserBridge(options: {sessionId: string; origins: string[]; browser?: 'chrome' | 'msedge'; profile?: string; allowInteraction?: boolean; allowScreenshots?: boolean; minutes?: number; confirmed: boolean}): Promise<object>;
export declare function revokeBrowserBridge(options: {sessionId: string}): Promise<{revoked: boolean}>;
export declare function installBrowserBridge(options?: {rootDir?: string; onProgress?: (message: string) => void}): Promise<object>;
export declare function browserBridgeStatus(options?: {rootDir?: string}): Promise<object>;
