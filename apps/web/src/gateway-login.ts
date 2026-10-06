export async function desktopLoginProof() {
  if (!window.kkcodeDesktopLogin) return null;
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const state = encode(crypto.getRandomValues(new Uint8Array(32))), verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  await window.kkcodeDesktopLogin.prepare(state);
  const discovery = await fetch('/api/v1/discovery', { redirect: 'error' });
  if (!discovery.ok || (await discovery.json()).authentication?.desktopLogin?.platform !== 'windows') return { state, verifier: undefined, native: undefined };
  return { state, verifier, native: { platform: 'windows', state, code_challenge: challenge, code_challenge_method: 'S256' } };
}
