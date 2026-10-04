import React, { useEffect, useState } from 'react';
import { subagentStatusLabels, subagentProgressSummary } from '../../../src/ui/todo-progress.mjs';

type Item = Record<string, any>;
export const childActivity = (item: Item) => !['running', 'pending'].includes(item.status)
  ? subagentStatusLabels[item.status as keyof typeof subagentStatusLabels] || '待核查'
  : ({ thinking: '正在思考', stopping: '正在停止', writing: '正在输出', tool: `使用工具 · ${item.activity?.tool || '执行中'}`, approval: '等待你的确认', waiting_children: '等待协作结果', finishing: '正在保存结果' } as Item)[item.activity?.phase] || '正在执行';

export function SubagentPanel({ items, sessionId, canManage, notice, rpc, onTasks }: {
  items: Item[]; sessionId: string; canManage: boolean; notice?: string; rpc: (method: string, params?: Item) => Promise<any>; onTasks: () => void;
}) {
  const [error, setError] = useState(''), [stopping, setStopping] = useState(''), [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  async function stop(id: string) {
    setStopping(id); setError('');
    try { await rpc('control.acquire', { sessionId }); await rpc('subagents.interrupt', { sessionId, childSessionId: id }); }
    catch (cause) { setError((cause as Error).message); }
    finally { setStopping(''); }
  }
  return <div className="subagent-panel">
    <p className="subagent-summary">{subagentProgressSummary(items) || '协作工作台'}</p>
    <p className="sheet-note">子代理完成后会自动汇报给主代理。这里显示当前会话的执行状态与实际模型设置。</p>
    {(notice || error) && <p role="status" className="error">{error || notice}</p>}
    {!items.length && <p className="subagent-empty">当前会话还没有派发子代理。</p>}
    {items.map(item => {
      const active = ['running', 'pending'].includes(item.status), runtime = item.runtime || {}, context = item.context;
      const limit = context?.limit || runtime.context_limit, elapsed = Math.max(0, Math.floor(((item.settled_at || now) - (item.started_at || now)) / 1000));
      return <article className="subagent-card" key={item.session_id} data-status={item.status}>
        <header><strong>{item.description || item.subagent}</strong><span>{subagentStatusLabels[item.status as keyof typeof subagentStatusLabels] || '待核查'}</span></header>
        <small>{item.subagent} · {childActivity(item)} · {elapsed}s</small>
        <p className="subagent-model">{[item.provider, item.model].filter(Boolean).join(' / ') || '模型信息尚未同步'}</p>
        {runtime.thinking && <p>思考 · {runtime.thinking}</p>}
        {limit > 0 && <small>上下文 {context?.tokens != null ? Number(context.tokens).toLocaleString() : '—'} / {Number(limit).toLocaleString()}{runtime.output_reserved > 0 && ` · 输出预留 ${Number(runtime.output_reserved).toLocaleString()}`}</small>}
        {context && <progress aria-label={`${item.description || item.subagent}上下文`} max="100" value={context.percent || 0} />}
        {canManage && active && <button disabled={Boolean(stopping)} onClick={() => void stop(item.session_id)}>{stopping === item.session_id ? '正在停止…' : '停止此子代理'}</button>}
      </article>;
    })}
    <button className="settings-row" onClick={onTasks}>持久任务与交付记录 →</button>
  </div>;
}
