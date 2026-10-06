import React from 'react';
import { Icon } from './Icon';
import { PixelBuddy } from './PixelStudio';
import { SubagentPanel } from './Subagents';
import { ArtifactPanel } from './Artifacts';
import { TaskPanel } from './Tasks';
import { ToolRow } from './TranscriptView';
import { toolPresentation } from './transcript.mjs';
import { todoProgressSummary, todoOwnerLabel, todoStatusLabels } from '../../../src/ui/todo-progress.mjs';

type Item = Record<string, any>;
export type ActivityTab = 'todos' | 'changes' | 'subagents' | 'tasks' | 'artifacts';
export function ActivityPanel({ tab, onTab, snapshot, items, messages, sessionId, canManage, notice, rpc, onClose }: {
  tab: ActivityTab; onTab: (tab: ActivityTab) => void; snapshot: Item | null; items: Item[]; messages: Item[];
  sessionId: string; canManage: boolean; notice: string; rpc: (method: string, params?: Item, options?: Item) => Promise<any>; onClose: () => void;
}) {
  const summary = todoProgressSummary(snapshot), changes = messages.filter(row => row.type === 'tool' && toolPresentation(row.payload).mutations.length > 0);
  const tabs: [ActivityTab, string, number | undefined][] = [['todos', '待办', summary?.total], ['changes', '变更', changes.length], ['subagents', '子代理', items.length], ['tasks', '任务', undefined], ['artifacts', '产物', undefined]];
  return <aside className="activity-panel" aria-label="会话活动">
    <header><strong>活动</strong><button className="icon" aria-label="关闭活动面板" onClick={onClose}><Icon name="close" size={18} /></button></header>
    <div className="activity-tabs" role="tablist" aria-label="活动分类">{tabs.map(([id, label, count]) => <button key={id} role="tab" aria-selected={tab === id} aria-controls={`activity-${id}`} id={`activity-tab-${id}`} onClick={() => onTab(id)}>{label}{count ? <small>{count}</small> : null}</button>)}</div>
    <div className="activity-content" role="tabpanel" id={`activity-${tab}`} aria-labelledby={`activity-tab-${tab}`} tabIndex={0}>
      {tab === 'todos' && <>{summary ? <>
        <div className="activity-progress" role="group" aria-label={summary.text}><strong>{summary.completed}<small> / {summary.total}</small></strong><span>已完成 {summary.completed} · 进行中 {summary.active}{summary.blocked > 0 ? ` · 受阻 ${summary.blocked}` : ''}</span><progress max={summary.total} value={summary.completed} aria-label="待办完成数量" /></div>
        <ul className="task-cards" aria-label="待办任务列表">{snapshot!.items.map((item: Item) => <li key={item.id} data-status={item.status}>
          <span className="task-state" aria-label={todoStatusLabels[item.status as keyof typeof todoStatusLabels]}>{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◉' : item.status === 'blocked' ? '!' : '○'}</span>
          <div><p>{item.status === 'in_progress' && item.activeForm || item.content}</p><small>负责人：{todoOwnerLabel(item, snapshot!.sessionId)}</small>{item.dependencies?.length > 0 && <small>依赖：{item.dependencies.join('、')}</small>}{item.reason && <small>{item.reason}</small>}</div>
        </li>)}</ul><p className="sheet-note">状态由代理更新；已完成不等于已验证。</p>
      </> : <p className="sheet-note">当前会话还没有待办。日常对话无需创建任务清单。</p>}</>}
      {tab === 'changes' && <>{changes.length ? changes.map(row => <ToolRow key={row.id} payload={row.payload} />) : <p className="sheet-note">当前记录中还没有文件修改。</p>}<p className="sheet-note">这里汇总工具记录中的修改，不表示完整 Git 工作区差异。</p></>}
      {tab === 'subagents' && <SubagentPanel items={items} sessionId={sessionId} canManage={canManage} notice={notice} rpc={rpc} onTasks={() => onTab('tasks')} />}
      {tab === 'tasks' && <TaskPanel key={sessionId} rpc={rpc} sessionId={sessionId} />}
      {tab === 'artifacts' && <ArtifactPanel key={sessionId} rpc={rpc} sessionId={sessionId} canManage={canManage} />}
    </div>
  </aside>;
}

export function RunBanner({ busy, phase, compacting, approvals, snapshot, messages, onStop, onPrompt, readOnly, companion }: {
  busy: boolean; phase: string; compacting: boolean; approvals: number; snapshot: Item | null; messages: Item[];
  onStop: () => void; onPrompt: () => void; readOnly: boolean;
  companion?: React.ReactNode;
}) {
  if (!busy && !approvals) return null;
  const summary = todoProgressSummary(snapshot), current = snapshot?.items?.find((item: Item) => item.status === 'in_progress');
  const tool = [...messages].reverse().find(row => row.type === 'tool' && row.payload?.status === 'running');
  const label = phase === 'stopping' ? '正在停止' : compacting ? '正在压缩上下文' : approvals ? '等待你的确认' : phase === 'waiting_children' ? '等待子代理汇报' : phase === 'finishing' ? '正在保存结果' : tool ? toolPresentation(tool.payload).title : current?.activeForm || '正在工作';
  return <section className="run-banner" aria-label="当前执行状态" data-state={phase}>
    {companion || <PixelBuddy />}<div className="run-label"><strong title={label}>{label}</strong>{current && <small>{current.content}</small>}</div>
    {summary && <div className="run-progress"><progress aria-label="当前待办完成数量" max={summary.total} value={summary.completed} /><small>已完成 {summary.completed} / {summary.total}</small></div>}
    <button onClick={onPrompt} disabled={readOnly || compacting || phase === 'stopping'}>补充要求</button>
    <button className="run-stop" disabled={readOnly || phase === 'stopping' || phase === 'finishing'} onClick={onStop}>{phase === 'stopping' ? '停止中…' : '停止'}</button>
  </section>;
}
