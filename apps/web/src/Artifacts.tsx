import React, { useEffect, useRef, useState } from 'react';
import { downloadArtifact } from '../../../src/sdk/client.mjs';

type Item = Record<string, any>;
export function ArtifactPanel({ rpc, sessionId, canManage }: { rpc: (method: string, params?: Item, options?: Item) => Promise<any>; sessionId: string; canManage: boolean }) {
  const [items, setItems] = useState<Item[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Item | null>(null), [text, setText] = useState(''), [pageCursor, setPageCursor] = useState<string | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [progress, setProgress] = useState('');
  const [query, setQuery] = useState(''), [matches, setMatches] = useState<Item | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const lifetime = useRef(new AbortController());
  const operation = useRef(false);
  useEffect(() => { lifetime.current = new AbortController(); return () => lifetime.current.abort(); }, [sessionId]);
  const call = (method: string, params: Item = {}, options: Item = {}) => rpc(method, { sessionId, ...params }, { signal: lifetime.current.signal, ...options });
  async function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setError(''); setBusy(true);
    try { await action(); } catch (cause: any) { if (!lifetime.current.signal.aborted) setError(cause.code === 'unknown_method' ? '当前设备尚不支持产物访问，请先升级被控电脑；已有对话仍可使用。' : cause.message); }
    finally { operation.current = false; if (!lifetime.current.signal.aborted) { setBusy(false); setProgress(''); } }
  }
  async function list(next?: string) {
    const result = await call('artifacts.list', { ...(next ? { cursor: next } : {}), limit: 30 });
    if (lifetime.current.signal.aborted) return;
    setItems(previous => next ? [...previous, ...result.items] : result.items); setCursor(result.nextCursor);
  }
  useEffect(() => { if (sessionId) void run(() => list()); }, [sessionId]);
  async function read(item: Item, next?: string) {
    const result = await call('artifacts.read', { id: item.id, ...(next ? { cursor: next } : {}), limit: 16000 });
    if (lifetime.current.signal.aborted) return;
    const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
    setText(new TextDecoder().decode(bytes)); setPageCursor(result.nextCursor); setSelected(item); setMatches(null);
  }
  if (!sessionId) return <p className="sheet-note">打开一个对话后，可在这里查看该会话的工具日志与产物。</p>;
  return <>
    <p className="sheet-note">完整内容保存在被控电脑。只读取当前会话已授权的产物；日志可能仅包含超时前捕获的部分内容，不能据此判断任务成功。</p>
    {selected ? <>
      <button disabled={busy} onClick={() => { setSelected(null); setText(''); setMatches(null); }}>返回产物列表</button>
      <p className="sheet-note">{selected.mime} · {selected.size.toLocaleString()} bytes · SHA-256 {selected.sha256}</p>
      <pre className="command-output">{text}</pre>
      <p className="sheet-note">这是按字节分页的文本预览，边界可能出现替代字符；下载文件保留原字节并校验哈希。</p>
      {pageCursor && <button disabled={busy} onClick={() => void run(() => read(selected, pageCursor))}>下一页</button>}
      <form onSubmit={event => { event.preventDefault(); void run(async () => setMatches(await call('artifacts.search', { id: selected.id, query }))); }}>
        <label>在完整内容中搜索<input value={query} maxLength={256} disabled={busy} onChange={event => { setQuery(event.target.value); setMatches(null); }} /></label>
        <button disabled={busy || !query.trim()}>搜索</button>
      </form>
      {matches && <p className="sheet-note">本段匹配字节位置：{matches.matches.map((match: Item) => match.offset).join('、') || '无'}{matches.nextCursor ? '（后续内容尚未搜索）' : '（已到末尾）'}</p>}
      {matches?.nextCursor && <button disabled={busy} onClick={() => void run(async () => setMatches(await call('artifacts.search', { id: selected.id, query, cursor: matches.nextCursor })))}>继续搜索下一段</button>}
    </> : <>
      {!busy && !items.length && <p className="sheet-note">这个会话暂时没有归档产物。</p>}
      <div className="settings-group">{items.map(item => <div className="artifact-item" key={item.id}>
        <p>{item.source?.kind || '产物'} · {item.mime} · {item.size.toLocaleString()} bytes</p>
        <small>{new Date(item.createdAt).toLocaleString()} · {item.retention?.pinned ? '已固定' : item.retention?.active ? '使用中' : '已保留'}</small>
        <div><button disabled={busy} onClick={() => void run(() => read(item))}>查看内容</button>
          <button disabled={busy} onClick={() => void run(async () => {
            const result = await downloadArtifact({ request: call }, { sessionId, id: item.id, signal: lifetime.current.signal, onProgress: (bytes, total) => setProgress(`下载 ${bytes.toLocaleString()} / ${total.toLocaleString()} bytes`) });
            const url = URL.createObjectURL(result.blob), link = document.createElement('a');
            link.href = url; link.download = `kkcode-${item.id}.${/^text\//.test(item.mime) ? 'txt' : 'bin'}`;
            link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          })}>下载并校验</button>
          {canManage && <button disabled={busy} onClick={() => void run(async () => { await call('artifacts.pin', { id: item.id, pinned: !item.retention?.pinned }); await list(); })}>{item.retention?.pinned ? '取消固定' : '固定保留'}</button>}
        </div>
      </div>)}</div>
      {cursor && <button disabled={busy} onClick={() => void run(() => list(cursor))}>加载更多</button>}
    </>}
    {canManage && <button disabled={busy} onClick={() => setConfirmPrune(true)}>清理可回收的临时产物</button>}
    {confirmPrune && <div role="alertdialog" aria-label="确认产物清理"><p>仅清理已结束、无引用、未固定且超过保留期限的临时内容；活跃、待核查或待验收的内容不删除。</p><button disabled={busy} onClick={() => void run(async () => { await call('artifacts.prune', { confirmed: true }); setConfirmPrune(false); await list(); })}>确认清理</button><button onClick={() => setConfirmPrune(false)}>取消</button></div>}
    {busy && <p className="sheet-note" role="status">{progress || '正在从设备读取…'}</p>}
    {error && <p className="sheet-error" role="alert">{error}</p>}
  </>;
}
