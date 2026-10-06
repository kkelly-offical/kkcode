import React, { useState } from 'react';
import { Sheet } from './Sheet';
import { Icon } from './Icon';

type Item = Record<string, any>;
export function HistoryNavigator({ messages, sessions, hasMore, loading, onLoadEarlier, onMessage, onSession, onClose, search = false }: {
  messages: Item[]; sessions: Item[]; hasMore: boolean; loading: boolean; search?: boolean;
  onLoadEarlier: () => void; onMessage: (id: string) => void; onSession: (id: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const flatten = (rows: Item[]): Item[] => rows.flatMap(row => Array.isArray(row.rows) ? flatten(row.rows) : [row]);
  const matches = flatten(messages).filter(row => ['user', 'assistant'].includes(row.type) && typeof row.text === 'string' && (!needle || row.text.toLocaleLowerCase().includes(needle))).slice(-100).reverse();
  const conversations = search && needle ? sessions.filter(item => String(item.title || '').toLocaleLowerCase().includes(needle)) : [];
  return <Sheet title={search ? '搜索项目中的对话' : '对话记录'} onClose={onClose}>
    <label className="search-field"><Icon name="search" size={18} /><input autoFocus aria-label="查找对话记录" value={query} onChange={event => setQuery(event.target.value)} placeholder="查找标题或已加载的消息" /></label>
    {conversations.length > 0 && <><p className="group-label">项目中的对话</p><div className="history-results">{conversations.map(item => <button key={item.id} onClick={() => onSession(item.id)}><strong>{item.title}</strong><small>{item.cwd}</small></button>)}</div></>}
    <p className="group-label">当前对话 · 已加载记录</p>
    <div className="history-results">{matches.map(row => {
      const offset = needle ? row.text.toLocaleLowerCase().indexOf(needle) : 0;
      const preview = row.text.slice(Math.max(0, offset - 30), Math.max(0, offset - 30) + 180);
      return <button key={row.id} onClick={() => onMessage(row.id)}><small>{row.type === 'user' ? '你' : '智能体'}{row.timestamp ? ` · ${new Date(row.timestamp).toLocaleString()}` : ''}</small><span>{preview}</span></button>;
    })}</div>
    {!matches.length && <p className="sheet-note">没有匹配的已加载消息。</p>}
    {hasMore && <button className="sheet-secondary" disabled={loading} onClick={onLoadEarlier}>{loading ? '正在加载…' : '加载更早记录后继续查找'}</button>}
    <p className="sheet-note">点击结果定位原文，不会发送消息或触发任务。</p>
  </Sheet>;
}
