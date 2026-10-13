import { useEffect, useRef } from 'react';
import type { DeviceClient } from '../../../src/sdk/client.mjs';

/** Optional device-scope stream; session streaming/polling remains independent. */
export function useDeviceEvents({ enabled, gateway, deviceId, sdk, onEvent, onReconnect }: {
  enabled: boolean; gateway: boolean; deviceId: string; sdk: DeviceClient;
  onEvent: (event: Record<string, any>, signal: AbortSignal) => void | Promise<void>;
  onReconnect?: (signal: AbortSignal) => void | Promise<void>;
}) {
  const listener = useRef(onEvent); listener.current = onEvent;
  const reconnect = useRef(onReconnect); reconnect.current = onReconnect;
  useEffect(() => {
    if (!enabled || gateway && !deviceId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let attempts = 0, disconnected = false;
      while (!controller.signal.aborted) {
        try {
          await sdk.stream('', { signal: controller.signal,
            onEvent: (event: Record<string, any>) => { if (!controller.signal.aborted) return listener.current(event, controller.signal); },
            onGap: () => {},
            onMeta: async (meta: Record<string, any>) => {
              if (meta.type !== 'connected') return;
              if (disconnected) await reconnect.current?.(controller.signal);
              if (controller.signal.aborted) return;
              disconnected = false; attempts = 0;
            } });
        } catch (error: any) {
          const unsupported = error.code === 'stream_unavailable' && (!error.status || error.status < 400);
          if (controller.signal.aborted || unsupported || [401, 403, 404, 405, 501].includes(error.status)) return;
        }
        if (controller.signal.aborted) return;
        disconnected = true;
        attempts = Math.min(attempts + 1, 6);
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          timer = setTimeout(done, Math.min(500 * 2 ** attempts, 10000));
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    };
    void run();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, gateway, deviceId, sdk]);
}
