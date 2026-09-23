import React, { useState } from 'react';
import { Sheet } from './Sheet';
import { publicContext } from '../../../src/protocol/context.mjs';

const tokens = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1, notation: 'compact' }).format(value);
export function ContextUsage({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  const context = publicContext(value);
  if (!context || context.tokens <= 0) return null;
  return <>
    <button className="context-meter" aria-label="上下文使用情况" onClick={() => setOpen(true)}>
      <span>上下文 {tokens(context.tokens)} / {tokens(context.limit)} · {context.percent}%{context.estimated ? ' · 估算' : ''}</span>
      <progress max={100} value={context.percent} aria-label="上下文占用" />
    </button>
    {open && <Sheet title="上下文使用情况" onClose={() => setOpen(false)}>
      <p>{context.tokens.toLocaleString()} / {context.limit.toLocaleString()} tokens（{context.percent}%）</p>
      <p className="sheet-note">{context.estimated ? '按完整请求估算，包含系统提示、工具声明、历史与媒体；与模型计费值可能不同。' : '根据模型端计数或最近一次响应 usage 更新。'} 这是当前上下文占用，不是累计用量。</p>
      <p className="sheet-note">输出预留：{tokens(context.outputReserved || 0)} tokens。接近预算时自动压缩；也可以使用 /compact 手动整理上下文。</p>
      <div className="settings-group">{Object.entries(context.components).map(([key, value]) => <p key={key}>{({ system: '系统提示', tools: '工具声明', messages: '历史与媒体' } as Record<string, string>)[key]}：约 {tokens(Number(value))}</p>)}</div>
    </Sheet>}
  </>;
}
