import React from 'react';
export function TaskProgress({ summary, label }: { summary: { total: number; completed: number; active: number; blocked: number; cancelled: number }; label: string }) {
  return <div className="task-progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={summary.total} aria-valuenow={summary.completed} aria-valuetext={`已完成 ${summary.completed}，进行中 ${summary.active}，受阻 ${summary.blocked}，共 ${summary.total} 项`}>
    {(['completed', 'active', 'blocked', 'cancelled'] as const).map(status => summary[status] > 0 && <span key={status} data-status={status} style={{ width: `${summary[status] / summary.total * 100}%` }} />)}
  </div>;
}
