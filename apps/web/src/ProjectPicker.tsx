import React, { useState } from 'react';
import { Sheet } from './Sheet';
import { Icon } from './Icon';
import { projectPathKey, sessionProjects } from './projects.mjs';

type Item = Record<string, any>;
export function ProjectPicker({ sessions, cwd, deviceId, deviceName, onChoose, onAll, onBrowse, onClose }: {
  sessions: Item[]; cwd: string; deviceId: string; deviceName: string;
  onChoose: (path: string) => void; onBrowse: () => void; onClose: () => void;
  onAll: () => void;
}) {
  const [query, setQuery] = useState('');
  const projects = sessionProjects(sessions, cwd, deviceId).filter(item => `${item.name} ${item.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Sheet title="项目与工作区" onClose={onClose}>
    <div className="project-picker">
      <label className="search-field"><Icon name="search" size={18} /><input autoFocus aria-label="搜索项目名或完整路径" placeholder="搜索项目名或完整路径" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <p className="sheet-note">{deviceName} · 当前设备</p>
      <button className="quiet" onClick={onAll}>显示全部项目的对话</button>
      <div className="project-options">{projects.map(project => <button key={project.id} className="project-option" aria-pressed={project.key === projectPathKey(cwd)} onClick={() => onChoose(project.path)}>
        <Icon name="folder" /><span><strong>{project.name}</strong><small>{project.path}</small><small>{project.count} 个对话{project.running > 0 ? ` · ${project.running} 个进行中` : ''}</small></span>{project.key === projectPathKey(cwd) && <Icon name="check" size={17} />}
      </button>)}</div>
      {!projects.length && <p className="sheet-note">没有匹配的项目，可以选择其他文件夹。</p>}
      <button className="sheet-secondary" onClick={onBrowse}><Icon name="plus" size={16} /> 选择其他文件夹</button>
    </div>
  </Sheet>;
}
