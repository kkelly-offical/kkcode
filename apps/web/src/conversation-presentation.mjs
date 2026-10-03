/** Collapse only completed runs with a final answer; keep active/error traces. */
export function collapseCompletedRuns(rows, busy = false) {
  const result = [];
  let pending = [], started = 0;
  function flush(last) {
    const answer = pending.findLastIndex(row => row.type === 'assistant' && row.text);
    const activity = pending.filter((row, index) => index !== answer && ['assistant', 'tool', 'thinking', 'review'].includes(row.type));
    if (answer >= 0 && pending[answer].done !== false && activity.length && !(busy && last) && !pending.some(row => ['error', 'cancelled'].includes(row.type)) && !pending.slice(answer + 1).some(row => ['tool', 'thinking', 'review'].includes(row.type))) {
      const end = Math.max(...pending.map(row => row.finishedAt || row.updatedAt || row.timestamp || 0));
      const times = pending.map(row => row.timestamp).filter(value => value > 0);
      const begin = started || (times.length ? Math.min(...times) : 0);
      result.push({ id: `run-${pending[0].turnId || pending[0].id}`, type: 'run-summary', rows: activity, durationMs: begin && end >= begin ? end - begin : null, tools: activity.filter(row => row.type === 'tool').length });
      result.push(...pending.filter((row, index) => index === answer || !activity.includes(row)));
    } else result.push(...pending);
    pending = [];
  }
  for (const row of rows) {
    if (['user', 'compacted'].includes(row.type)) { flush(false); result.push(row); started = row.timestamp || 0; }
    else pending.push(row);
  }
  flush(true);
  return result;
}

export function compactionLabel(value = {}) {
  const format = number => number >= 1000 ? `${Number((number / 1000).toFixed(1))}k` : String(Math.ceil(number));
  return Number.isFinite(value.beforeTokens) && Number.isFinite(value.afterTokens)
    ? `已压缩 · ≈ ${format(value.beforeTokens)} → ${format(value.afterTokens)}` : '已精简上下文';
}

/** Presentation only: keep available history in an expandable row. */
export function collapseCompactedHistory(rows) {
  const boundary = rows.findLastIndex(row => row.type === 'compacted');
  if (boundary < 0) return rows;
  const divider = rows[boundary], history = rows.slice(0, boundary).filter(row => row.type !== 'compacted');
  return [ ...(history.length ? [{ id: `history-${divider.id}`, type: 'compacted-history', rows: history }] : []), divider, ...rows.slice(boundary + 1) ];
}
