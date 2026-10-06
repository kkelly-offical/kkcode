/// <reference types="vite/client" />
declare const __KKCODE_VERSION__: string;
declare const __KKCODE_WEB_DISPLAY__: string;
interface Window {
  kkcodeDesktopLogin?: { prepare: (state: string) => Promise<boolean>; finish: (state: string) => Promise<boolean> };
  kkcodeDesktop?: { platform: string; openFolder: () => Promise<string | null>; connectGateway: (origin: string) => Promise<boolean>; loadPreferences: () => Promise<Record<string, string>>; savePreferences: (value: Record<string, string>) => Promise<boolean> };
}
