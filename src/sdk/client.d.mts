export interface DeviceEvent { schemaVersion: '1'; id: string; seq: number; sessionId: string; type: string; payload: unknown; timestamp: number }
export interface DeviceRequest { id: string; method: string; params?: Record<string, unknown>; issuedAt?: number }
export interface DeviceCredentials { access_token: string; refresh_token: string; expires_in: number; profile?: Record<string, unknown> }
export declare const PROTOCOL_VERSION: '1';
export declare class DeviceClient {
  constructor(options: { url: string; token?: string; deviceId?: string | null; gateway?: boolean; refreshToken?: string | null; onCredentials?: (credentials: DeviceCredentials) => void | Promise<void>; fetch?: typeof fetch; headers?: Record<string, string>; retries?: number });
  deviceId: string | null;
  token?: string;
  refresh(options?: { signal?: AbortSignal }): Promise<unknown>;
  http<T = unknown>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal; id?: string; issuedAt?: number }): Promise<T>;
  listDevices<T = unknown>(options?: { signal?: AbortSignal }): Promise<T>;
  profile<T = unknown>(options?: { signal?: AbortSignal }): Promise<T>;
  events(sessionId: string, options?: { after?: number; signal?: AbortSignal; interval?: number }): AsyncGenerator<DeviceEvent>;
}
