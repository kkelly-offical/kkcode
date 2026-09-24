import React, { useEffect, useRef, useState } from 'react';
import { downloadArtifact } from '../../../src/sdk/client.mjs';
import type { RemoteRun } from '../../../src/sdk/client.mjs';

type Item = Record<string, any>;
const states: Record<string, string> = { running: '运行中', waiting_input: '等待输入或交付确认', waiting_approval: '等待审批', paused: '已暂停', verification_failed: '验收未通过', outcome_unknown: '结果待核查', cancelled: '已取消', completed: '已验收完成' };
const eventLabels: Record<string, string> = { 'run.created': '任务已建立', 'run.claimed': '执行者已接管', 'run.transitioned': '状态已更新', 'turn.started': '开始一轮执行', 'turn.ended': '本轮已结束', 'action.prepared': '操作意图已保存', 'action.settled': '操作回执已保存', 'candidate.updated': '候选版本已更新', 'verification.recorded': '验收记录已保存', 'control.requested': '停止请求已保存', 'contract.revised': '任务契约已更新', 'graph.updated': '子任务进度已更新' };

/** Compact, session-scoped truth from the host ledger, never inferred from prose. */
export function TaskPanel({ rpc, sessionId }: { rpc: (method: string, params?: Item, options?: Item) => Promise<any>; sessionId: string }) {
  const [items, setItems] = useState<RemoteRun[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<RemoteRun | null>(null), [events, setEvents] = useState<Item[]>([]), [after, setAfter] = useState(0);
  const [artifacts, setArtifacts] = useState<Item[]>([]), [artifactCursor, setArtifactCursor] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: 'pause' | 'cancel'; run: RemoteRun } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lifetime = useRef(new AbortController());
  const selectedRef = useRef<string | null>(null), operation = useRef(false);
  const call = (method: string, params: Item = {}) => rpc(method, { sessionId, ...params }, { signal: lifetime.current.signal });
  async function run(action: () => Promise<void>, quiet = false) {
    if (operation.current) return;
    operation.current = true; setBusy(true); if (!quiet) setError('');
    try { await action(); }
    catch (cause: any) { if (!lifetime.current.signal.aborted) setError(cause.code === 'unknown_method' ? '当前设备尚不支持持久任务，请升级被控电脑。普通会话不受影响。' : cause.message); }
    finally { operation.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  }
  async function list(next?: string) {
    const page = await call('runs.list', { limit: 30, ...(next ? { cursor: next } : {}) });
    if (lifetime.current.signal.aborted) return;
    setItems(previous => next ? [...previous, ...page.items.filter((item: RemoteRun) => !previous.some(old => old.id === item.id))] : page.items);
    setCursor(page.nextCursor);
  }
  async function refresh(runId: string) {
    const value = await call('runs.get', { runId });
    if (lifetime.current.signal.aborted || selectedRef.current !== runId) return;
    setSelected(value); setItems(previous => previous.map(item => item.id === runId ? value : item));
  }
  async function inspect(item: RemoteRun) {
    selectedRef.current = item.id; setSelected(item); setEvents([]); setAfter(0); setArtifacts([]); setArtifactCursor(null); setNotice('');
    await refresh(item.id);
    const page = await call('runs.artifacts.list', { runId: item.id, limit: 20 });
    if (!lifetime.current.signal.aborted && selectedRef.current === item.id) { setArtifacts(page.items); setArtifactCursor(page.nextCursor); }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    if (sessionId) void run(() => list());
    const timer = setInterval(() => {
      if (!controller.signal.aborted && !operation.current && selectedRef.current) void run(() => refresh(selectedRef.current!), true);
    }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [sessionId]);
  if (!sessionId) return <p className="sheet-note">打开一个任务所属的会话后，可查看持久任务、验收和操作回执。普通聊天不会被自动当作委托任务。</p>;
  return <>
    <p className="sheet-note">这里显示设备账本中的真实状态。模型的“已完成”文本不会把待核查或未验收任务变为成功。</p>
    {selected ? <>
      <button disabled={busy} onClick={() => { selectedRef.current = null; setSelected(null); setConfirmation(null); setNotice(''); }}>返回任务列表</button>
      <h3>{selected.objective}</h3>
      <p role="status">{states[selected.state] || '未知状态'}{selected.lastTurn?.status === 'running' && selected.state !== 'running' ? ' · 停止请求已登记，执行器仍在收尾' : ''}</p>
      <p className="sheet-note">候选版本：{selected.candidateHash?.slice(0, 12) || '尚未生成'} · 契约 v{selected.contractVersion}</p>
      <p>验收 {selected.verification.passed}/{selected.verification.required} · 失败 {selected.verification.failed} · 未知 {selected.verification.unknown}</p>
      <p className="sheet-note">操作：成功 {selected.actionCounts.succeeded} · 失败 {selected.actionCounts.failed} · 待回执 {selected.actionCounts.prepared} · 待核查 {selected.actionCounts.unknown}</p>
      {selected.budget ? <>
        {selected.budget.localFree ? <>
          <p className="sheet-note">本地免费 · 请求名额 {selected.budget.localFree.usedRequests}/{selected.budget.localFree.maxRequests} · 累计预留 token {selected.budget.localFree.reservedTokens.toLocaleString()}/{selected.budget.localFree.maxTokens.toLocaleString()}</p>
          <p className="sheet-note">累计预留是核准的保守上界，不是实际 token 用量。仅限宿主明确批准的本机服务，不授权付费渠道。</p>
        </> : <p className="sheet-note">预算 ${selected.budget.budgetUsd.toLocaleString()} USD · 已结算 ${selected.budget.spentUsd.toLocaleString()} · 请求预留 ${selected.budget.reservedUsd.toLocaleString()}</p>}
        <p className="sheet-note">固定期限：{new Date(selected.budget.deadlineAt).toLocaleString()}{selected.budget.budgetUsd === 0 && !selected.budget.localFree ? ' · 额度为零，不会发送新的模型请求' : ''}</p>
        {selected.budget.hasUnknown && <p className="sheet-error">{selected.budget.localFree ? '部分调用结果待核查；即使美元费用为零，也不会自动重放。' : `部分调用计费待核查，保留上界 $${selected.budget.unknownUsd.toLocaleString()} USD（不是实际账单）。`}核查前不会继续发起模型请求。</p>}
      </> : <p className="sheet-note">尚无已确认的持久预算，不能据此授权新模型调用。</p>}
      {selected.state === 'outcome_unknown' && <p className="sheet-error">有操作的结果尚不能确认。请在执行电脑核查证据；重复运行可能造成重复写入或其他副作用。</p>}
      <button disabled={busy} onClick={() => void run(() => refresh(selected.id))}>刷新任务</button>
      {selected.controls.canPause && <button disabled={busy} onClick={() => setConfirmation({ kind: 'pause', run: selected })}>暂停任务</button>}
      {selected.controls.canCancel && <button disabled={busy} onClick={() => setConfirmation({ kind: 'cancel', run: selected })}>取消任务</button>}
      {confirmation && <div role="alertdialog" aria-label="确认停止任务">
        <p>确认{confirmation.kind === 'pause' ? '暂停' : '取消'}此任务？已有候选和证据会保留；停止不撤销已发生的文件修改或远端操作。进行中的操作可能需要收尾，未知结果仍须核查。</p>
        <button disabled={busy} onClick={() => void run(async () => {
          const { kind, run: observed } = confirmation;
          try {
            const value = await call(`runs.${kind}`, { runId: observed.id, expectedRevision: observed.revision, expectedOwnerEpoch: observed.ownerEpoch, confirmed: true });
            if (!lifetime.current.signal.aborted && selectedRef.current === observed.id) { setSelected(value); setNotice('停止请求已记录。请以任务状态和执行回执为准，现有文件未撤销。'); }
          } finally { if (!lifetime.current.signal.aborted) setConfirmation(null); }
        })}>确认{confirmation.kind === 'pause' ? '暂停' : '取消'}</button>
        <button disabled={busy} onClick={() => setConfirmation(null)}>继续保留任务</button>
      </div>}
      <p className="group-label">运行记录</p>
      {events.map(event => <p className="sheet-note" key={event.sequence}>{new Date(event.createdAt).toLocaleTimeString()} · {eventLabels[event.type] || '任务记录已更新'}{event.state ? ` · ${states[event.state] || event.state}` : ''}</p>)}
      <button disabled={busy} onClick={() => void run(async () => {
        const page = await call('runs.events', { runId: selected.id, after, limit: 50 });
        if (!lifetime.current.signal.aborted && selectedRef.current === selected.id) { setEvents(previous => [...previous, ...page.events]); setAfter(page.nextAfter); }
      })}>{events.length ? '读取后续记录' : '查看运行记录'}</button>
      <p className="group-label">任务证据与产物</p>
      {!artifacts.length && <p className="sheet-note">暂时没有可下载的工具或文档产物；私密契约和授权记录不会经远程接口返回。</p>}
      {artifacts.map(item => <div className="artifact-item" key={item.id}><p>{item.mime} · {item.size.toLocaleString()} bytes</p><button disabled={busy} onClick={() => void run(async () => {
        const result = await downloadArtifact({ request: (_method: string, params?: Item) => call('runs.artifacts.download', { ...params, runId: selected.id }) }, { sessionId, id: item.id, signal: lifetime.current.signal });
        if (lifetime.current.signal.aborted) return;
        const url = URL.createObjectURL(result.blob), link = document.createElement('a');
        link.href = url; link.download = `kkcode-${item.id}.bin`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>下载并校验</button></div>)}
      {artifactCursor && <button disabled={busy} onClick={() => void run(async () => {
        const page = await call('runs.artifacts.list', { runId: selected.id, cursor: artifactCursor, limit: 20 });
        if (!lifetime.current.signal.aborted && selectedRef.current === selected.id) { setArtifacts(previous => [...previous, ...page.items]); setArtifactCursor(page.nextCursor); }
      })}>更多任务产物</button>}
    </> : <>
      {!busy && !items.length && <p className="sheet-note">当前会话没有持久任务。可在执行电脑通过 kkcode runs start 确认任务范围、隔离环境和验收后启动。</p>}
      <div className="settings-group">{items.map(item => <button className="settings-row" key={item.id} disabled={busy} onClick={() => void run(() => inspect(item))}><span>{item.objective}<small>{states[item.state] || '未知状态'} · 验收 {item.verification.passed}/{item.verification.required}</small></span></button>)}</div>
      <button disabled={busy} onClick={() => void run(() => list())}>刷新列表</button>
      {cursor && <button disabled={busy} onClick={() => void run(() => list(cursor))}>更多任务</button>}
    </>}
    {notice && <p className="sheet-note" role="status">{notice}</p>}
    {error && <p className="sheet-error" role="alert">{error}</p>}
  </>;
}
