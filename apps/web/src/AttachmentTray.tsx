import React, { useEffect, useRef, useState } from 'react';
import { Attachment, attachmentAccept } from './Attachments';
import { Icon } from './Icon';

export function AttachmentTray({ items, scope, disabled, uploading, onUpload, onRemove, children }: {
  scope: string;
  items: Attachment[]; disabled: boolean; uploading: boolean;
  onUpload: (files: File[]) => Promise<void>; onRemove: (id: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const picker = useRef<HTMLInputElement>(null), lock = useRef(false);
  const [dragging, setDragging] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<File[]>([]), [failed, setFailed] = useState<File[]>([]);
  const currentScope = useRef(scope), previousScope = useRef(scope), workScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    if (scope !== previousScope.current) {
      if (lock.current && previousScope.current.endsWith(':') && scope.startsWith(previousScope.current)) workScope.current = scope;
      else { setFailed([]); setPending([]); setError(''); }
      previousScope.current = scope;
    }
  }, [scope]);
  const upload = async (files: File[]) => {
    if (!files.length || disabled || uploading || lock.current) return;
    if (files.length + items.length > 8) { setError('每条消息最多添加 8 个附件'); return; }
    lock.current = true; workScope.current = scope; setError(''); setPending(files);
    const failures: File[] = [];
    try {
      for (const file of files) {
        try { await onUpload([file]); }
        catch (cause: any) { failures.push(file); if (workScope.current === currentScope.current) setError(`${file.name}：${cause.message}`); }
        if (workScope.current === currentScope.current) setPending(old => old.filter(item => item !== file));
      }
      if (workScope.current === currentScope.current) setFailed(old => [...old.filter(file => !files.includes(file)), ...failures]);
    } finally { lock.current = false; if (picker.current) picker.current.value = ''; }
  };
  return <div className={`attachment-composer${dragging ? ' is-dragging' : ''}`}
    onPaste={event => {
      const files = Array.from(event.clipboardData.files);
      if (!files.length || disabled) return;
      event.preventDefault(); void upload(files);
    }}
    onDragOver={event => { if (!disabled && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDrop={event => { if (disabled || !event.dataTransfer.files.length) return; event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }}>
    <input ref={picker} hidden type="file" multiple accept={attachmentAccept} aria-label="添加图片或文件" disabled={disabled || uploading} onChange={event => void upload(Array.from(event.target.files || []))} />
    {(items.length > 0 || pending.length > 0 || failed.length > 0) && <div className="composer-attachments" aria-label="待发送附件">
      {items.map(item => <div className="composer-attachment" key={item.id}>
        {item.preview ? <img src={item.preview} alt={item.name} /> : <Icon name="attachment" size={25} />}
        <span><b title={item.name}>{item.name}</b><small>{Math.max(1, Math.ceil(item.size / 1024))} KB · 待发送</small></span>
        <button type="button" className="icon" aria-label={`移除附件 ${item.name}`} disabled={disabled || uploading} onClick={() => void onRemove(item.id).catch(cause => setError(cause.message))}><Icon name="close" size={14} /></button>
      </div>)}
      {pending.map((file, i) => <div className="composer-attachment" key={`upload-${i}`} role="status"><Icon name="attachment" /><span><b>{file.name}</b><small>正在上传…</small><progress aria-label={`上传 ${file.name}`} /></span></div>)}
      {failed.filter(file => !pending.includes(file)).map((file, i) => <div className="composer-attachment failed" key={`failed-${i}`}><span><b>{file.name}</b><small>上传失败</small></span><button type="button" disabled={disabled || uploading} onClick={() => void upload([file])}>重试</button><button type="button" className="icon" aria-label={`移除失败附件 ${file.name}`} onClick={() => setFailed(old => old.filter(item => item !== file))}><Icon name="close" size={14} /></button></div>)}
    </div>}
    {children}
    <button type="button" className="composer-attach" title="添加附件，也可直接粘贴或拖入" aria-label="添加附件" disabled={disabled || uploading || items.length >= 8} onClick={() => picker.current?.click()}><Icon name="attachment" size={17} /></button>
    {error && <p className="attachment-error" role="alert">{error}</p>}
    {dragging && <div className="attachment-drop-hint">松开即可添加附件</div>}
  </div>;
}
