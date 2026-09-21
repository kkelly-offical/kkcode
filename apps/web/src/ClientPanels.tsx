import React, { useEffect, useState } from "react";
import { SettingsRow } from "./Home";

type Item = Record<string, any>;
export function CommandOutput({ result }: { result: Item }) {
  const clean = (value: unknown) => String(value ?? "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  return <div className="command-output">
    <p className="sheet-note">{result.command || "命令结果"}</p>
    {(result.panels || []).map((panel: Item, index: number) => <section key={index}><h3>{clean(panel.title)}</h3><pre>{clean(panel.text)}</pre></section>)}
    {(result.output || []).map((row: Item, index: number) => <pre key={index}>{clean(row.text)}</pre>)}
    {!result.panels?.length && !result.output?.length && <pre>{clean(JSON.stringify(result, null, 2))}</pre>}
  </div>;
}

export function PreferencesPanel({ rpc, onSaved }: { rpc: (method: string, params?: Item) => Promise<any>; onSaved: () => void }) {
  const [draft, setDraft] = useState<Item | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [languages, setLanguages] = useState(""), [techStack, setTechStack] = useState("");
  useEffect(() => {
    let stopped = false;
    void rpc("profile.get").then(result => { if (!stopped) { const value = result.profile || result; setDraft(value); setLanguages((value.languages || []).join(", ")); setTechStack((value.tech_stack || []).join(", ")); } }).catch(cause => { if (!stopped) setError(cause.message); });
    return () => { stopped = true; };
  }, []);
  const list = (value: string) => value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
  return <>
    <p className="sheet-note">这些偏好保存在被控电脑上，帮助 KK Code 调整回复。它们不会修改组织 SSO 的姓名、邮箱或权限。</p>
    {draft && <form className="settings-form" onSubmit={async event => {
      event.preventDefault(); setLoading(true); setError("");
      try { await rpc("profile.update", { profile: { beginner: Boolean(draft.beginner), languages: list(languages), tech_stack: list(techStack), design_style: draft.design_style || "", extra_notes: draft.extra_notes || "" } }); onSaved(); }
      catch (cause: any) { setError(cause.message); } finally { setLoading(false); }
    }}>
      <label className="checkbox-label"><input type="checkbox" checked={Boolean(draft.beginner)} onChange={event => setDraft({ ...draft, beginner: event.target.checked })} />使用更适合初学者的说明</label>
      <label>常用语言（逗号分隔）<input value={languages} onChange={event => setLanguages(event.target.value)} /></label>
      <label>技术栈（逗号分隔）<input value={techStack} onChange={event => setTechStack(event.target.value)} /></label>
      <label>设计偏好<input value={draft.design_style || ""} onChange={event => setDraft({ ...draft, design_style: event.target.value })} /></label>
      <label>补充说明<textarea rows={4} value={draft.extra_notes || ""} onChange={event => setDraft({ ...draft, extra_notes: event.target.value })} /></label>
      <button className="sheet-primary" disabled={loading}>{loading ? "保存中…" : "保存偏好"}</button>
    </form>}
    {error && <p className="sheet-error" role="alert">{error}</p>}
  </>;
}

export function ThemePanel({ theme, onTheme }: { theme: string; onTheme: (theme: string) => void }) {
  return <><p className="sheet-note">仅改变当前浏览器的外观，不影响终端或其他客户端。</p><div className="settings-group">{[["dark", "深色"], ["light", "浅色"], ["auto", "跟随系统"]].map(([value, label]) => <SettingsRow key={value} icon={theme === value ? "check" : "settings"} title={label} onClick={() => onTheme(value)} />)}</div></>;
}

export function KeysPanel() {
  return <div className="settings-group">{[["Enter", "发送消息"], ["Shift + Enter", "输入换行"], ["/", "查看命令建议"], ["↑ / ↓", "选择命令建议"], ["Tab", "补全命令／切换焦点"], ["Esc", "关闭菜单、弹层或命令建议"]].map(([key, text]) => <SettingsRow key={key} icon="terminal" title={key} detail={text} />)}</div>;
}

export function DeviceLifecyclePanel({ deviceId, gateway, name }: { deviceId: string; gateway: boolean; name: string }) {
  const id = /^[A-Za-z0-9_-]+$/.test(deviceId) ? deviceId : "<device-id>";
  return <>
    <p className="sheet-note">{name} · {gateway ? "组织中继连接" : "本机连接"}</p>
    <p className="sheet-note">解绑或转移会改变本机历史记录的账户归属，必须在被控电脑的终端完成，网页不会远程替你更换所有者。共享此设备的人也不能执行转移。</p>
    <p className="group-label">查看设备 ID 和登录状态</p><pre>kkcode remote status</pre>
    <p className="group-label">解绑当前账户</p><pre>{`kkcode remote stop\nkkcode remote unbind --confirm ${id}`}</pre>
    <p className="sheet-note">撤销旧绑定、登录凭据与共享授权；本机文件和历史保留。重新绑定会使用新的设备标识。</p>
    <p className="group-label">转移到另一个账户</p><pre>{`kkcode remote stop\nkkcode remote transfer --gateway ${location.origin} --confirm ${id} --include-history`}</pre>
    <p className="sheet-note">转移会要求重新登录，并明确将保留的本地历史交给新账户。请先备份和检查历史；不能把仍属于他人的私有内容移交给新账户。</p>
  </>;
}
