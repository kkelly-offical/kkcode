import React, { useEffect, useState } from 'react';
type Item = Record<string, any>;
export async function accountModels(path = '', body?: Item) {
  const response = await fetch(`/api/v1/account/models${path}`, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(response.status === 404 ? '当前网关尚未支持账号模板，请升级网关后使用。' : data.error?.message || '无法读取账号模型模板。');
  return data;
}
export async function saveAccountModelTemplate(provider: Item) {
  const current = await accountModels();
  return accountModels('', { revision: current.revision, provider });
}
export function AccountModels({ rpc, onSettings }: { rpc: (method: string, params?: Item) => Promise<any>; onSettings: (value: Item) => void }) {
  const [data, setData] = useState<Item>({ provider: {} }), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState('');
  useEffect(() => { void accountModels().then(setData).catch(e => setError(e.message)); }, []);
  const [draft, setDraft] = useState<Item | null>(null);
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <div className="account-models"><p className="sheet-note">账号模板可以跨端复用。复制到设备后各自独立，之后修改不会互相覆盖。</p>
    {error && <p className="sheet-error" role="alert">{error}</p>}{copied && <p role="status">{copied}</p>}
    {draft ? <form className="settings-form" onSubmit={e => { e.preventDefault(); void run(async () => {
      const { name, existing, ...entry } = draft;
      if (existing && !entry.api_key) delete entry.api_key;
      setData(await accountModels('', { revision: data.revision, provider: { [name]: entry } })); setDraft(null);
    }); }}>
      <label>模板名称<input required pattern="[A-Za-z0-9_-]+" readOnly={draft.existing} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>协议<select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value })}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic 兼容</option></select></label>
      <label>Base URL<input required value={draft.base_url} onChange={e => setDraft({ ...draft, base_url: e.target.value })} /></label>
      <label>API Key<input type="password" autoComplete="new-password" value={draft.api_key} placeholder={draft.existing ? '留空保留已保存密钥' : '无认证服务可留空'} onChange={e => setDraft({ ...draft, api_key: e.target.value })} /></label>
      <label>默认模型<input required value={draft.default_model} onChange={e => setDraft({ ...draft, default_model: e.target.value })} /></label>
      <button className="sheet-primary" disabled={busy}>保存到账号</button><button type="button" onClick={() => setDraft(null)}>取消</button>
    </form> : <>
      <button className="sheet-secondary" onClick={() => setDraft({ name: '', type: 'openai', base_url: '', api_key: '', api_key_env: '', default_model: '' })}>＋ 添加账号模板</button>
      {Object.entries(data.provider || {}).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value) && ('base_url' in value || 'type' in value)).map(([name, value]: any) => <div className="connection-row" key={name}><div className="connection-description"><strong>{name}</strong><small>{value.default_model}</small></div><div className="connection-actions">
        <button onClick={() => setDraft({ name, ...value, api_key: '', existing: true })}>编辑</button>
        <button disabled={busy} onClick={() => void run(async () => {
          const settings = await rpc('settings.get');
          let targetName = name;
          for (let index = 1; settings.provider?.[targetName]; index++) targetName = `${name}-copy-${index}`;
          const resolved = await accountModels('/resolve', {}), entry = resolved.provider?.[name];
          if (!entry) throw new Error('模板已改变，请刷新后重试。');
          const result = await rpc('settings.update', { config: { provider: { [targetName]: entry } } }); onSettings(result.config); setCopied(`${targetName} 已复制到当前设备，后续独立修改。`);
        })}>复制到设备</button>
      </div></div>)}
    </>}
  </div>;
}
