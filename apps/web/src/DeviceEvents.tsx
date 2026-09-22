import { useEffect, useRef } from 'react';
import { eventsStreamPath, streamSessionEvents } from './live.mjs';

/** Optional device-scope stream; session streaming/polling remains independent. */
export function useDeviceEvents({ enabled, gateway, deviceId, onEvent }: {
  enabled: boolean; gateway: boolean; deviceId: string; onEvent: (event: Record<string, any>, signal: AbortSignal) => void | Promise<void>;
}) {
  const listener = useRef(onEvent); listener.current = onEvent;
  useEffect(() => {
    if (!enabled || gateway && !deviceId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let attempts = 0;
      while (!controller.signal.aborted && attempts <= 5) {
        try {
          await streamSessionEvents({ url: eventsStreamPath({ gateway, deviceId }), signal: controller.signal,
            onEvent: (event: Record<string, any>) => { if (!controller.signal.aborted) return listener.current(event, controller.signal); },
            onGap: () => {},
            onMeta: () => { attempts = 0; } });
        } catch (error: any) {
          if (controller.signal.aborted || [401, 403, 404, 405, 501].includes(error.status) || error.code === 'stream_unavailable') return;
        }
        attempts++;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          timer = setTimeout(done, Math.min(500 * 2 ** attempts, 10000));
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    };
    void run();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, gateway, deviceId]);
}
