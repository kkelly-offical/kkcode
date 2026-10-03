import React from 'react';
import { todoProgressSummary, todoStatusLabels, todoOwnerLabel, subagentProgressSummary, subagentStatusLabels } from '../../../src/ui/todo-progress.mjs';

export function TodoProgress({ snapshot, subagents = [] }: { snapshot: Record<string, any> | null, subagents?: Record<string, any>[] }) {
  const summary = todoProgressSummary(snapshot);
  const childSummary = subagentProgressSummary(subagents);
  if (!summary && !childSummary) return null;
  const title = [summary?.text, childSummary].filter(Boolean).join(' · ');
  return <details className="todo-progress">
    <summary aria-label={`${title}，待办与子代理详情`}><span aria-live="polite" aria-atomic="true">{title}</span></summary>
    <div className="todo-progress-body">
      <p className="todo-progress-note">任务状态由代理更新；已完成不等于已验证。</p>
      <ul aria-label="待办任务列表">{(snapshot?.items || []).map((item: Record<string, any>) => <li key={item.id} data-status={item.status}>
        <div><span className="todo-progress-status">{todoStatusLabels[item.status as keyof typeof todoStatusLabels]}</span><span className="todo-progress-content">{item.status === 'in_progress' && item.activeForm || item.content}</span></div>
        <small>负责人：{todoOwnerLabel(item, snapshot!.sessionId)}{item.dependencies?.length > 0 && ` · 依赖：${item.dependencies.join('、')}`}</small>
        {item.reason && <small>{item.reason}</small>}
      </li>)}</ul>
      {subagents.length > 0 && <ul aria-label="子代理状态">{subagents.map(item => <li key={item.session_id}><span>{item.subagent} · {subagentStatusLabels[item.status as keyof typeof subagentStatusLabels] || '待核查'}</span><small>{item.session_id}</small></li>)}</ul>}
    </div>
  </details>;
}
