import React, { useState } from 'react';
import { pixelBuddySvg, pixelStudioSvg } from '../../../src/ui/pixel-art.mjs';
import { Icon, type IconName } from './Icon';
import { Sheet } from './Sheet';

export function PixelBuddy({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`pixel-buddy ${className}`} dangerouslySetInnerHTML={{ __html: pixelBuddySvg }} />;
}
export function PixelScene() {
  return <div className="pixel-scene" aria-hidden="true" dangerouslySetInnerHTML={{ __html: pixelStudioSvg }} />;
}

const palettes = [['mint', '薄荷', '#a4d8b5'], ['amber', '琥珀', '#edc78b'], ['iris', '鸢尾', '#b8b3e0']];
function saved(key: string, fallback: string) {
  try { return localStorage.getItem(`kkcode.studio.${key}`) || fallback; } catch { return fallback; }
}
function persist(key: string, value: string) {
  try { localStorage.setItem(`kkcode.studio.${key}`, value); } catch { /* Appearance still works without storage. */ }
}

export function StudioBar({ waiting = false, busy, stopping, approval, readOnly, connected, selected, canManage, onPanel, onPrompt }: {
  waiting?: boolean; busy: boolean; stopping: boolean; approval: boolean; readOnly: boolean;
  connected: boolean; selected: boolean; canManage: boolean;
  onPanel: (panel: string) => void; onPrompt: (prompt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(() => saved('palette', 'mint'));
  const [motion, setMotion] = useState(() => saved('motion', 'on') !== 'off');
  const [compact, setCompact] = useState(() => saved('compact', 'off') === 'on');
  const tone = palettes.find(item => item[0] === palette) || palettes[0];
  const state = !connected ? 'offline' : stopping ? 'stopping' : approval ? 'approval' : waiting ? 'waiting' : busy ? 'working' : readOnly ? 'readonly' : 'idle';
  const label = { offline: '等待连接', stopping: '正在停止', approval: '等待你的确认', working: '正在工作', waiting: '等待伙伴的汇报', readonly: '只读陪伴', idle: '准备好，一起开工' }[state];
  const shortcuts: [string, IconName, string][] = [
    ...(canManage ? [['attachments', 'attachment', '附件']] as [string, IconName, string][] : []),
    ['subagents', 'priority', '子代理'], ['artifacts', 'folder', '产物'],
    ...(canManage ? [['memory', 'archive', '记忆']] as [string, IconName, string][] : []),
  ];
  return <>
    <div className="studio-bar" data-state={state} data-motion={motion ? 'on' : 'off'} style={{ '--buddy-main': tone[2] } as React.CSSProperties}>
      <button className={`studio-companion${compact ? ' compact' : ''}`} aria-label="像素伙伴" onClick={() => setOpen(true)} title="像素伙伴与工作提示">
        {!compact && <PixelBuddy />}<span><small>KIKI / CODE COMPANION</small><span data-companion-status aria-live="polite" aria-atomic="true">{label}</span></span><Icon name="down" size={12} />
      </button>
      <div className="studio-shortcuts" role="group" aria-label="会话快捷工具">
        {shortcuts.map(([panel, icon, title]) => <button key={panel} disabled={!connected || !selected} aria-label={`打开${title}`} title={title} onClick={() => onPanel(panel)}><Icon name={icon} size={15} /><span>{title}</span></button>)}
      </div>
    </div>
    {open && <Sheet title="像素伙伴" onClose={() => setOpen(false)}>
      <div className="companion-intro" style={{ '--buddy-main': tone[2] } as React.CSSProperties}><PixelBuddy /><div><b>你好，我是 KIKI。</b><p>陪你专注，也帮你找到下一步。</p></div></div>
      <p className="group-label">从这里开始</p>
      <div className="settings-group">
        {['梳理项目结构，说明主要模块与入口。', '审查当前改动，优先指出缺陷和验证缺口。', '根据当前目标，制定可执行的开发计划。'].map((prompt, i) => <button className="settings-row" key={prompt} disabled={readOnly || !connected || !selected} onClick={() => { onPrompt(prompt); setOpen(false); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')?.focus()); }}><Icon name={(['folder', 'search', 'priority'] as IconName[])[i]} /><span className="row-label">{['了解项目', '审查改动', '规划下一步'][i]}</span><Icon name="chevron" size={14} /></button>)}
      </div>
      <p className="sheet-note">提示会填入输入框，由你确认后发送。</p>
      <p className="group-label">伙伴外观</p>
      <div className="companion-palettes" role="group" aria-label="伙伴配色">{palettes.map(([id, name, color]) => <button key={id} aria-pressed={palette === id} onClick={() => { setPalette(id); persist('palette', id); }}><i style={{ background: color }} />{name}</button>)}</div>
      <label className="companion-toggle"><input type="checkbox" checked={motion} onChange={event => { setMotion(event.target.checked); persist('motion', event.target.checked ? 'on' : 'off'); }} />轻微动态 <small>遵循系统的减少动态效果设置</small></label>
      <label className="companion-toggle"><input type="checkbox" checked={compact} onChange={event => { setCompact(event.target.checked); persist('compact', event.target.checked ? 'on' : 'off'); }} />收起玩偶，保留状态</label>
    </Sheet>}
  </>;
}
