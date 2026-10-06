import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
type Item = Record<string, any>;
const empty = { name: '', transport: 'streamable-http', url: '', command: '', args: '', auth: 'none', env: [] as Item[], headers: [] as Item[], source: '', revision: '', content: '' };

export function ExtensionsPanel({ rpc, deviceName }: { rpc: (method: string, params?: Item) => Promise<any>; deviceName: string }) {
  const api = useRef(rpc); api.current = rpc;
  const [catalog, setCatalog] = useState<Item>({}), [tab, setTab] = useState('mcp'), [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Item | null>(null), [saving, setSaving] = useState(false), [notice, setNotice] = useState('');
  const [flow, setFlow] = useState<Item | null>(null), [callback, setCallback] = useState(''), [review, setReview] = useState<Item | null>(null);
  const refresh = async () => setCatalog(await api.current('extensions.catalog'));
  const run = async (action: () => Promise<void>) => { if (saving) return; setSaving(true); setNotice(''); try { await action(); } catch (e: any) { setNotice(e.code === 'unknown_method' ? '请先升级所选设备的 KK Code，才能在应用中配置扩展。' : e.message); } finally { setSaving(false); } };
  useEffect(() => { void refresh().catch(e => setNotice(e.message)); }, []);
  useEffect(() => {
    if (!flow?.id || flow.status !== 'pending') return;
    let active = true;
    const timer = setInterval(() => { void api.current('extensions.auth.status', { id: flow.id }).then(result => { if (active) { setFlow(result); if (result.status === 'authorized') void refresh(); } }).catch(e => { if (active) { setNotice(e.message); setFlow(null); } }); }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [flow?.id, flow?.status]);
  const manage = (params: Item) => api.current('extensions.manage', params);
  const edit = (item?: Item) => setDraft(item ? { ...empty, ...item, url: '', args: (item.args || []).join('\n'), env: (item.envKeys || []).map((key: string) => ({ key, value: '' })), headers: (item.headerKeys || []).map((key: string) => ({ key, value: '' })), existing: true } : { ...empty, env: [], headers: [] });
  const rows = (Array.isArray(catalog[tab]) ? catalog[tab] : []).filter((item: Item) => `${item.name} ${item.description || ''}`.toLowerCase().includes(query.toLowerCase()));
  const fields = (kind: 'env' | 'headers', title: string) => <fieldset className="connection-fields"><legend>{title}</legend>
    {draft![kind].map((field: Item, index: number) => <div className="connection-field" key={index}>
      <input aria-label={`${title}名称 ${index + 1}`} placeholder={kind === 'env' ? '变量名' : '请求头名称'} value={field.key} onChange={e => setDraft({ ...draft, [kind]: draft![kind].map((row: Item, i: number) => i === index ? { ...row, key: e.target.value } : row) })} />
      <input aria-label={`${title}值 ${index + 1}`} type="password" autoComplete="new-password" placeholder={draft!.existing ? '留空保留已保存的值' : '私密值'} value={field.value} onChange={e => setDraft({ ...draft, [kind]: draft![kind].map((row: Item, i: number) => i === index ? { ...row, value: e.target.value } : row) })} />
      <button type="button" aria-label={`删除${title} ${index + 1}`} onClick={() => setDraft({ ...draft, [kind]: draft![kind].filter((_: Item, i: number) => i !== index) })}>×</button>
    </div>)}<button type="button" className="sheet-secondary" onClick={() => setDraft({ ...draft, [kind]: [...draft![kind], { key: '', value: '' }] })}>＋ 添加{title}</button>
  </fieldset>;
  return <div className="connections">
    <p className="sheet-note">当前设备 · {deviceName}。凭据加密保存在该设备，不会加入聊天记录。</p>
    <div className="connection-toolbar"><div role="tablist" aria-label="扩展分类">{['mcp', 'plugins', 'skills'].map(kind => <button key={kind} role="tab" aria-selected={tab === kind} onClick={() => { setTab(kind); setDraft(null); }}>{kind === 'mcp' ? 'MCP' : kind === 'plugins' ? 'Plugins' : 'Skills'}</button>)}</div><button onClick={() => edit()}>＋ 添加</button><button aria-label="刷新连接" disabled={saving} onClick={() => void run(refresh)}><Icon name="activity" size={16} /></button></div>
    {notice && <p className="sheet-error" role="alert">{notice}</p>}
    {flow && <section className="connection-auth" aria-label="浏览器授权">
      <h3>{flow.status === 'authorized' ? '连接成功' : flow.status === 'failed' ? '登录未完成，请检查服务后重试' : flow.status === 'cancelled' ? '登录已取消' : '在浏览器中完成授权'}</h3>
      {flow.status === 'pending' && <><p className="sheet-note">完成后会自动更新。手机或另一台电脑登录时，可粘贴浏览器最后显示的回调地址。</p>
        {flow.url ? <><a className="sheet-primary" href={flow.url} target="_blank" rel="noreferrer">在系统浏览器中打开</a><button onClick={() => void navigator.clipboard.writeText(flow.url).catch(() => setNotice('请右键链接复制地址。'))}>复制登录链接</button></> : <p role="status">正在准备登录…</p>}
        <label>回调地址<input type="password" autoComplete="off" value={callback} onChange={e => setCallback(e.target.value)} /></label>
        <button disabled={saving || !callback} onClick={() => void run(async () => { await api.current('extensions.auth.complete', { id: flow.id, url: callback }); setCallback(''); })}>完成登录</button>
        <button onClick={() => void run(async () => { setFlow(await api.current('extensions.auth.cancel', { id: flow.id })); setCallback(''); })}>取消登录</button></>}
    </section>}
    {review && <section className="connection-auth"><h3>检查插件权限 · {review.name}</h3><p className="sheet-note">来源：{review.source || review.lock?.source || "本机已安装插件"}{review.revision || review.lock?.revision ? ` · ${(review.revision || review.lock.revision).slice(0, 12)}` : ""}</p><p className="sheet-note">启用后，此插件可以在当前电脑执行以下能力。请核实来源后再启用。</p><ul>{(review.capabilities || review.addedCapabilities || []).map((capability: string) => <li key={capability}>{capability}</li>)}</ul><button disabled={saving} onClick={() => void run(async () => { await manage({ action: 'plugin.manage', name: review.name, operation: 'approve', confirmHash: review.contentHash }); setReview(null); await refresh(); })}>确认来源并启用</button><button disabled={saving} onClick={() => void run(async () => { await manage({ action: "plugin.manage", name: review.name, operation: "disable" }); setReview(null); await refresh(); })}>停用插件</button><button disabled={saving} onClick={() => void run(async () => { await manage({ action: "plugin.manage", name: review.name, operation: "remove" }); setReview(null); await refresh(); })}>移入已移除插件</button><button onClick={() => setReview(null)}>返回</button></section>}
    {draft ? <form className="connection-form" onSubmit={e => { e.preventDefault(); void run(async () => {
      const result = await manage(tab === 'mcp' ? { ...draft, action: 'mcp.save', args: draft.args.split('\n').filter(Boolean) } : tab === 'plugins' ? { name: draft.name, source: draft.source, revision: draft.revision, action: 'plugin.install' } : { name: draft.name, content: draft.content, action: 'skill.save' });
      setDraft(null); if (result.pendingApproval) setReview(result); await refresh();
    }); }}>
      <h3>{draft.existing ? '编辑连接' : '添加' + (tab === 'mcp' ? ' MCP 连接' : tab === 'plugins' ? '插件' : '技能')}</h3>
      <label>名称<input required value={draft.name} disabled={draft.existing} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如 design-tools" /></label>
      {tab === 'mcp' ? <>
        <label>连接方式<select value={draft.transport} onChange={e => setDraft({ ...draft, transport: e.target.value })}><option value="streamable-http">远程 HTTP</option><option value="legacy-sse">远程 SSE</option><option value="stdio">本机程序</option></select></label>
        {draft.transport === 'stdio' ? <><label>可执行程序<input required value={draft.command} placeholder="程序名称或完整路径" onChange={e => setDraft({ ...draft, command: e.target.value })} /></label><label>程序参数<textarea value={draft.args} placeholder="每行一个参数" onChange={e => setDraft({ ...draft, args: e.target.value })} /></label>{fields('env', '环境变量')}</> : <>
          <label>服务地址<input required={!draft.existing} value={draft.url} autoComplete="off" placeholder={draft.existing ? `${draft.endpoint}（留空保留完整地址）` : 'https://example.com/mcp'} onChange={e => setDraft({ ...draft, url: e.target.value })} /></label>
          <label>登录方式<select value={draft.auth} onChange={e => setDraft({ ...draft, auth: e.target.value })}><option value="none">无需登录 / 请求头凭据</option><option value="oauth">浏览器授权 OAuth</option></select></label>{fields('headers', '请求头')}</>}
      </> : tab === 'plugins' ? <><label>插件来源<input required value={draft.source} placeholder="npm:包名@版本 或 HTTPS Git 仓库" onChange={e => setDraft({ ...draft, source: e.target.value })} /></label>{draft.source.startsWith('https://') && <label>固定版本<input required value={draft.revision} placeholder="仓库的完整提交编号" onChange={e => setDraft({ ...draft, revision: e.target.value })} /></label>}</> : <label>SKILL.md 内容<textarea required rows={12} value={draft.content} placeholder={'---\nname: my-skill\ndescription: 技能说明\n---\n技能正文'} onChange={e => setDraft({ ...draft, content: e.target.value })} /></label>}
      {tab === 'skills' && <label>或选择 SKILL.md 文件<input type="file" accept=".md,text/markdown,text/plain" onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 256 * 1024) { setNotice('技能文件最多 256 KiB'); return; } void file.text().then(content => { const name = content.match(/^name:\s*["']?([A-Za-z0-9_-]+)/m)?.[1]; setDraft({ ...draft, content, name: draft.name || name || '' }); }).catch(() => setNotice('无法读取技能文件。')); }} /></label>}
      <div className="connection-toolbar"><button className="sheet-primary" disabled={saving}>{saving ? '正在保存…' : '保存到当前设备'}</button><button type="button" disabled={saving} onClick={() => setDraft(null)}>取消</button></div>
    </form> : <><input className="connection-search" aria-label="搜索扩展" placeholder="搜索名称、工具或来源" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="connection-list">{rows.map((item: Item, index: number) => <div className="connection-row" key={`${item.name}-${index}`}>
        <div className="connection-symbol">{String(item.name || '?').slice(0, 1).toUpperCase()}</div><div className="connection-description"><strong>{item.name}</strong><small>{item.description || item.endpoint || (item.ok ? '已连接' : item.enabled === false ? '已停用' : item.reason === 'auth_required' ? '需要登录' : '等待连接')}</small></div>
        <div className="connection-actions">{tab === 'mcp' ? <>{item.transport !== 'stdio' && <button disabled={saving} onClick={() => void run(async () => { setFlow(await api.current('extensions.auth.start', { name: item.name })); })}>登录</button>}{item.transport !== "stdio" && item.ok && <button disabled={saving} onClick={() => void run(async () => { await api.current("extensions.auth.logout", { name: item.name }); await refresh(); })}>退出登录</button>}{item.configurable && <button onClick={() => edit(item)}>配置</button>}{item.managed && <><button role="switch" aria-label={`${item.enabled === false ? '启用' : '停用'} ${item.name}`} aria-checked={item.enabled !== false} disabled={saving} onClick={() => void run(async () => { await manage({ action: 'mcp.toggle', name: item.name, enabled: item.enabled === false }); await refresh(); })}>{item.enabled === false ? '启用' : '已启用'}</button></>}</> : tab === 'plugins' ? <button disabled={saving} onClick={() => void run(async () => { setReview(await manage({ action: 'plugin.manage', name: item.name, operation: 'inspect' })); })}>管理</button> : <span className="sheet-note">对话中可用</span>}</div>
      </div>)}{!rows.length && <p className="sheet-note">暂无扩展，可从上方添加。</p>}</div></>}
  </div>;
}
