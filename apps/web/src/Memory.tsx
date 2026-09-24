import React, { useEffect, useRef, useState } from 'react';
type Item = Record<string, any>;
const states: Record<string, string> = { active: '已启用', candidate: '待确认', disabled: '已禁用', stale: '来源已变化' };
export function MemoryPanel({ rpc, sessionId }: { rpc: (method: string, params?: Item, options?: Item) => Promise<any>; sessionId: string }) {
  const [scope, setScope] = useState('project'), [entries, setEntries] = useState<Item[]>([]), [legacy, setLegacy] = useState<Item[]>([]);
  const [draft, setDraft] = useState(''), [editing, setEditing] = useState<Item | null>(null), [pending, setPending] = useState<Item | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lifetime = useRef(new AbortController());
  const operation = useRef(false);
  useEffect(() => { lifetime.current = new AbortController(); return () => lifetime.current.abort(); }, [sessionId, scope]);
  const request = (method: string, params: Item = {}) => rpc(method, { scope, ...(sessionId ? { sessionId } : {}), ...params }, { signal: lifetime.current.signal });
  async function refresh() {
    const result = await request('memory.list', { includeCandidates: true, includeDisabled: true });
    if (!lifetime.current.signal.aborted) setEntries(result.entries);
  }
  async function run(fn: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    const controller = lifetime.current;
    setBusy(true); setError('');
    try { await fn(); } catch (cause: any) { if (!controller.signal.aborted) setError(cause.code === 'unknown_method' ? '当前电脑尚不支持新的记忆管理，请升级被控设备。旧记忆文件仍保留。' : cause.message); }
    finally { operation.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => { setEntries([]); setLegacy([]); setEditing(null); setPending(null); setDraft(''); if (scope !== 'project' || sessionId) void run(refresh); }, [sessionId, scope]);
  const key = (entry: Item) => ({ id: entry.id, expectedVersion: entry.version });
  function confirm(method: string, params: Item, title: string, text: string) { setPending({ method, params, title, text }); }
  return <>
    <div className="settings-group"><button disabled={busy} aria-pressed={scope === 'project'} onClick={() => setScope('project')}>项目记忆</button><button disabled={busy} aria-pressed={scope === 'personal'} onClick={() => setScope('personal')}>个人偏好</button></div>
    <p className="sheet-note">{scope === 'personal' ? '个人偏好会跨项目使用，只有你逐项明确确认后才启用。' : '项目事实会记录来源，来源变化后不继续作为有效记忆使用；自由文本先进入待确认列表。'}记忆是参考，不授予工具权限，也不能覆盖本次任务要求。</p>
    {scope === 'project' && !sessionId ? <p className="sheet-note">先打开一个会话，再管理该工作目录的项目记忆。</p> : <>
      <form onSubmit={event => { event.preventDefault(); void run(async () => { if (editing) await request('memory.correct', { ...key(editing), text: draft }); else await request('memory.propose', { text: draft, category: scope === 'personal' ? 'preference' : 'workflow' }); setDraft(''); setEditing(null); await refresh(); }); }}>
        <label>{editing ? '更正这条记忆（更正后需重新确认）' : '新增待确认的记忆'}<textarea rows={3} maxLength={1600} disabled={busy} value={draft} onChange={event => setDraft(event.target.value)} /></label>
        <button disabled={busy || !draft.trim()}>{editing ? '保存更正' : '提出记忆'}</button>{editing && <button type="button" disabled={busy} onClick={() => { setEditing(null); setDraft(''); }}>取消更正</button>}
      </form>
      <div className="settings-group">{entries.map(entry => <section className="artifact-item" key={entry.id}>
        <p>{entry.text}</p><small>{states[entry.status] || entry.status} · v{entry.version} · {entry.automatic ? '已验证项目事实' : '人工确认候选'}</small>
        <details><summary>来源与版本记录</summary><pre>{JSON.stringify({ evidence: entry.evidence, changes: entry.changes }, null, 2)}</pre></details>
        <div>
          {entry.status === 'candidate' && <button disabled={busy} onClick={() => confirm('memory.confirm', key(entry), '确认启用这条记忆？', entry.text)}>确认启用</button>}
          {entry.status === 'disabled' && <button disabled={busy} onClick={() => confirm('memory.enable', { ...key(entry), enabled: true }, '重新启用这条记忆？', entry.text)}>启用</button>}
          {entry.status === 'active' && <button disabled={busy} onClick={() => void run(async () => { await request('memory.enable', { ...key(entry), enabled: false }); await refresh(); })}>禁用</button>}
          <button disabled={busy} onClick={() => { setEditing(entry); setDraft(entry.text); }}>更正</button>
          <button disabled={busy} onClick={() => confirm('memory.forget', key(entry), '忘记这条记忆？', `${entry.text}\n正文和历史版本将从记忆库移除；保留不含正文的抑制指纹，避免再次自动学习。原对话或旧文件不会因此删除。`)}>忘记</button>
        </div>
      </section>)}</div>
      {!busy && !entries.length && <p className="sheet-note">当前范围没有记忆。</p>}
      {scope === 'project' && <div><button disabled={busy} onClick={() => void run(async () => { await request('memory.observe'); await refresh(); })}>核验项目事实</button><button disabled={busy} onClick={() => void run(async () => setLegacy((await request('memory.legacy')).sources))}>检查旧记忆文件</button>
        {legacy.map(source => <p key={source.source}>{source.source} · {source.bytes} bytes <button disabled={busy} onClick={() => confirm('memory.import', { source: source.source }, '将旧文件导入待确认列表？', '旧文件保留，导入不会自动启用任何条目；敏感或不支持的内容会被拒绝。')}>导入候选</button></p>)}
      </div>}
    </>}
    {pending && <div className="approval" role="alertdialog" aria-label={pending.title}><h3>{pending.title}</h3><p>{pending.text}</p>{scope === 'personal' && <p>确认后可能在其他项目使用，请不要保存密码、密钥或项目秘密。</p>}<button disabled={busy} onClick={() => void run(async () => { await request(pending.method, { ...pending.params, confirmed: true }); setPending(null); await refresh(); })}>确认</button><button disabled={busy} onClick={() => setPending(null)}>取消</button></div>}
    {busy && <p className="sheet-note" role="status">正在读取或保存…</p>}{error && <p className="sheet-error" role="alert">{error}</p>}
  </>;
}
