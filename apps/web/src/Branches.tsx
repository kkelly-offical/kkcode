import React, { useEffect, useState } from "react";
import { SettingsRow } from "./Home";

type Item = Record<string, any>;
export function BranchPanel({ rpc, sessionId, cwd, ensureSession, onChanged }: {
  rpc: (method: string, params?: Item) => Promise<any>; sessionId: string; cwd: string;
  ensureSession: () => Promise<string>; onChanged: (snapshot: Item) => void;
}) {
  const [snapshot, setSnapshot] = useState<Item | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [query, setQuery] = useState("");
  const [name, setName] = useState(""), [pending, setPending] = useState<{ name: string; create: boolean } | null>(null);
  const refresh = async () => {
    setLoading(true); setError(""); setPending(null);
    try { setSnapshot(await rpc("branches.list", sessionId ? { sessionId } : { cwd })); }
    catch (cause: any) { setError(cause.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [sessionId, cwd]);
  const change = async () => {
    if (!pending || !snapshot) return;
    setLoading(true); setError("");
    try {
      const id = sessionId || await ensureSession();
      await rpc("control.acquire", { sessionId: id });
      try {
        const result = await rpc(pending.create ? "branches.create" : "branches.switch", { sessionId: id, name: pending.name, confirmed: true, stateToken: snapshot.stateToken });
        setSnapshot(result); setPending(null); setName(""); onChanged(result);
      } finally { await rpc("control.release", { sessionId: id }).catch(() => {}); }
    } catch (cause: any) {
      setError(`${cause.message}。请刷新分支状态后重试；不会丢弃或暂存你的修改。`);
      setPending(null);
    } finally { setLoading(false); }
  };
  return <>
    <p className="sheet-note">仅操作当前工作目录的本地 Git 分支。工作区必须干净且没有运行中的任务；不会强制切换、丢弃修改或自动提交。</p>
    {snapshot && <>
      <p className="sheet-note path">{snapshot.cwd}<br />当前：{snapshot.current || "游离 HEAD"} · {snapshot.clean ? "工作区干净" : "有未提交的修改，暂不可切换"}</p>
      <label className="form-label">搜索分支<input value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="settings-group branch-list">
        {(snapshot.branches || []).filter((branch: Item) => branch.name.toLowerCase().includes(query.toLowerCase())).map((branch: Item) => <SettingsRow key={branch.name} icon={branch.current ? "check" : "branch"} title={branch.name} detail={branch.current ? "当前" : branch.checkedOut ? "其他工作树使用中" : undefined} disabled={loading || branch.current || branch.checkedOut || !snapshot.clean} onClick={() => setPending({ name: branch.name, create: false })} />)}
      </div>
      <form className="settings-form" onSubmit={event => { event.preventDefault(); setPending({ name: name.trim(), create: true }); }}>
        <label>新分支名称<input value={name} placeholder="feat/my-change" onChange={event => setName(event.target.value)} required /></label>
        <button className="sheet-secondary" disabled={loading || !snapshot.clean || !name.trim()}>创建并切换分支</button>
      </form>
      {pending && <div className="branch-confirm" role="group" aria-label="确认分支操作">
        <p>{pending.create ? "从当前 HEAD 创建并切换到" : "切换到"} <strong>{pending.name}</strong>？此操作会改变设备上的实际工作目录，其他客户端也会看到变化。</p>
        <button className="sheet-primary" disabled={loading} onClick={() => void change()}>确认{pending.create ? "创建" : "切换"}</button>
        <button className="sheet-secondary" disabled={loading} onClick={() => setPending(null)}>取消</button>
      </div>}
    </>}
    <button className="sheet-secondary" disabled={loading} onClick={() => void refresh()}>刷新分支状态</button>
    {loading && <p className="sheet-note" role="status">正在检查 Git 状态…</p>}
    {error && <p className="sheet-error" role="alert">{error}</p>}
  </>;
}
