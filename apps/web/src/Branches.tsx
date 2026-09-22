import React, { useEffect, useState } from "react";
import { SettingsRow } from "./Home";

type Item = Record<string, any>;
export function BranchPanel({ rpc, sessionId, cwd, ensureSession, onChanged, onOpened }: {
  rpc: (method: string, params?: Item) => Promise<any>; sessionId: string; cwd: string;
  ensureSession: () => Promise<string>; onChanged: (snapshot: Item) => void; onOpened: (id: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Item | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [query, setQuery] = useState("");
  const [name, setName] = useState(""), [base, setBase] = useState("");
  const [parent, setParent] = useState(""), [folder, setFolder] = useState("");
  const [pending, setPending] = useState<Item | null>(null), [tab, setTab] = useState("local");
  const refresh = async () => {
    setLoading(true); setError(""); setPending(null);
    try { const value = await rpc("branches.list", sessionId ? { sessionId } : { cwd }); setSnapshot(value); setParent(old => old || value.suggestedParent || ""); }
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
        const result = await rpc(pending.method, { sessionId: id, ...pending.params, confirmed: true, stateToken: snapshot.stateToken });
        setPending(null);
        if (pending.method === "worktrees.open") { onOpened(result.sessionId); return; }
        setSnapshot(result); setName(""); setFolder("");
        if (!pending.method.startsWith("worktrees.")) onChanged(result);
      } finally { await rpc("control.release", { sessionId: id }).catch(() => {}); }
    } catch (cause: any) {
      setError(`${cause.message}。请刷新后重试；不会丢弃或暂存你的修改。`);
      setPending(null);
    } finally { setLoading(false); }
  };
  const branches = (tab === "remote" ? snapshot?.remoteBranches : snapshot?.branches) || [];
  return <>
    <p className="sheet-note">切换分支要求工作区干净；Worktree 可从已有提交创建独立目录，保留原目录未提交的修改。在 Worktree 中打开会新建对话，不改变原会话目录。不会强制切换、自动拉取、提交或推送。</p>
    {snapshot && <>
      <p className="sheet-note path">{snapshot.cwd}<br />当前：{snapshot.current || "游离 HEAD"} · {snapshot.clean ? "工作区干净" : "有未提交的修改，暂不可切换"}</p>
      <div className="git-tabs" role="group" aria-label="Git 列表类型">{[["local", "本地分支"], ["remote", "远端缓存"], ["worktrees", "Worktree"]].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setPending(null); }}>{label}</button>)}</div>
      <label className="form-label">搜索分支或工作树<input value={query} onChange={event => setQuery(event.target.value)} /></label>
      {tab === "worktrees" ? <div className="settings-group branch-list">
        {(snapshot.worktrees || []).filter((item: Item) => `${item.path} ${item.branch}`.toLowerCase().includes(query.toLowerCase())).map((item: Item) => <SettingsRow key={item.path} icon="folder" title={item.branch || "游离 HEAD"} detail={`${item.path}${item.locked ? " · 已锁定" : ""}`} disabled={loading || item.prunable} onClick={() => setPending({ method: "worktrees.open", params: { path: item.path }, label: `在 ${item.path} 新建对话` })} />)}
        {snapshot.unavailableWorktrees > 0 && <p className="sheet-note">另有 {snapshot.unavailableWorktrees} 个工作树不在此设备授权范围内。</p>}
      </div> : <div className="settings-group branch-list">
        {tab === "remote" && <p className="sheet-note">本地已有的远端引用，不会联网 fetch。选择后可据此创建分支或 Worktree。</p>}
        {branches.filter((item: Item) => item.name.toLowerCase().includes(query.toLowerCase())).map((item: Item) => <SettingsRow key={item.ref || item.name} icon={item.current ? "check" : "branch"} title={item.name} detail={[item.current ? "当前" : item.checkedOut ? "其他工作树使用中" : "", item.commit?.slice(0, 8), item.upstream, item.ahead ? `↑${item.ahead}` : "", item.behind ? `↓${item.behind}` : "", item.subject].filter(Boolean).join(" · ")} disabled={loading || (tab === "local" && (item.current || item.checkedOut || !snapshot.clean))} onClick={() => tab === "remote" ? setBase(item.name) : setPending({ method: "branches.switch", params: { name: item.name }, label: `切换到 ${item.name}` })} />)}
      </div>}
      <form className="settings-form" onSubmit={event => { event.preventDefault(); setPending({ method: tab === "worktrees" ? "worktrees.create" : "branches.create", params: { name: name.trim(), startPoint: base || undefined, ...(tab === "worktrees" ? { parent, folderName: folder.trim() } : {}) }, label: tab === "worktrees" ? `创建独立工作树 ${folder}（分支 ${name}）` : `创建并切换到 ${name}` }); }}>
        <label>起点<select aria-label="新分支起点" value={base} onChange={event => setBase(event.target.value)}><option value="">当前 HEAD</option>{[...(snapshot.branches || []), ...(snapshot.remoteBranches || [])].map((item: Item) => <option key={item.ref || item.name} value={item.name}>{item.name} · {item.commit?.slice(0, 8)}</option>)}</select></label>
        <label>新分支名称<input value={name} placeholder="feat/my-change" onChange={event => setName(event.target.value)} required /></label>
        {tab === "worktrees" && <><label>父目录<input aria-label="Worktree 父目录" value={parent} onChange={event => setParent(event.target.value)} required /></label><label>新文件夹名称<input value={folder} placeholder="my-feature" onChange={event => setFolder(event.target.value)} required /></label></>}
        <button className="sheet-secondary" disabled={loading || (tab !== "worktrees" && !snapshot.clean) || !name.trim() || (tab === "worktrees" && (!parent || !folder.trim()))}>{tab === "worktrees" ? "创建 Worktree" : "创建并切换分支"}</button>
      </form>
      {pending && <div className="branch-confirm" role="group" aria-label="确认 Git 操作">
        <p>确认{pending.label}？{pending.method.startsWith("worktrees.") ? "原对话和工作目录保持不变。" : "其他客户端也会看到分支变化。"}</p>
        <button className="sheet-primary" disabled={loading} onClick={() => void change()}>确认操作</button>
        <button className="sheet-secondary" disabled={loading} onClick={() => setPending(null)}>取消</button>
      </div>}
    </>}
    <button className="sheet-secondary" disabled={loading} onClick={() => void refresh()}>刷新 Git 状态</button>
    {loading && <p className="sheet-note" role="status">正在检查 Git 状态…</p>}
    {error && <p className="sheet-error" role="alert">{error}</p>}
  </>;
}
