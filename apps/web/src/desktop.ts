const keys = ['kkcode.web.theme', 'kkcode.web.reading', 'kkcode.studio.palette', 'kkcode.studio.motion', 'kkcode.studio.compact'];
export async function initializeDesktopPreferences() {
  if (!window.kkcodeDesktop) return;
  try {
    const saved = await window.kkcodeDesktop.loadPreferences();
    for (const key of keys) if (typeof saved[key] === 'string') localStorage.setItem(key, saved[key]);
  } catch { /* A missing desktop preference never prevents access to the workspace. */ }
}
export async function persistDesktopPreferences() {
  if (!window.kkcodeDesktop) return;
  try {
    const value = Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]).filter((entry): entry is [string, string] => entry[1] !== null));
    await window.kkcodeDesktop.savePreferences(value);
  } catch { /* Browser storage still holds this window's current preferences. */ }
}
