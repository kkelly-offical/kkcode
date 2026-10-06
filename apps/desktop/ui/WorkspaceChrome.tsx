import React from 'react';
import { Icon } from '../../web/src/Icon';

export function DesktopWorkspaceRail({ project, session, onProject, onNew, onPanel, onActivity }: {
  project: string; session: boolean; onProject: () => void; onNew: () => void;
  onPanel: (panel: string) => void; onActivity: (tab: 'changes' | 'todos') => void;
}) {
  return <nav className="desktop-workspace-rail" aria-label="桌面工作区">
    <button className="desktop-mark" title="项目与工作区" aria-label="桌面项目" onClick={onProject}>K</button>
    <button title={project || '选择项目'} aria-label="切换工程项目" onClick={onProject}><Icon name="folder" size={21} /><span>项目</span></button>
    <button title="新对话" aria-label="桌面新对话" onClick={onNew}><Icon name="chat" size={21} /><span>对话</span></button>
    <button title="当前任务" aria-label="桌面任务" disabled={!session} onClick={() => onActivity('todos')}><Icon name="check" size={21} /><span>任务</span></button>
    <button title="文件变更" aria-label="桌面变更" disabled={!session} onClick={() => onActivity('changes')}><Icon name="branch" size={21} /><span>变更</span></button>
    <button title="会话产物" aria-label="桌面产物" disabled={!session} onClick={() => onPanel('artifacts')}><Icon name="archive" size={21} /><span>产物</span></button>
    <div className="desktop-rail-spacer" />
    <button title="连接与扩展" aria-label="桌面连接与扩展" onClick={() => onPanel('extensions')}><Icon name="extension" size={21} /><span>扩展</span></button>
    <button title="设置" aria-label="桌面设置" onClick={() => onPanel('settings')}><Icon name="settings" size={21} /><span>设置</span></button>
  </nav>;
}
export function DesktopProjectBar({ path, branch, onProject }: { path: string; branch: string; onProject: () => void }) {
  return <div className="desktop-project-bar"><button onClick={onProject} title={path}><Icon name="folder" size={14} /><span>{path || '选择工程项目'}</span><Icon name="chevron" size={12} /></button>{branch && <span className="desktop-branch"><Icon name="branch" size={13} />{branch}</span>}<span className="desktop-workspace-label">工程工作台</span></div>;
}
