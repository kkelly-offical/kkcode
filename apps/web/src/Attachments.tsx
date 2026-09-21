import React, { useRef, useState } from "react";
import { Icon } from "./Icon";

export type Attachment = { id: string; name: string; mediaType: string; size: number; expiresAt?: number };
export const attachmentAccept = "image/png,image/jpeg,image/gif,image/webp,text/*,application/json,application/xml,application/yaml,.yaml,.yml,.md,.csv,.log,.ts,.tsx,.js,.jsx,.mjs,.py,.kt,.java,.go,.rs,.c,.h,.cpp,.css,.html";

export function readAttachment(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.readAsDataURL(file);
  });
}

export function attachmentMediaType(file: File) {
  if (/\.(json|jsonl)$/i.test(file.name)) return "application/json";
  if (/\.xml$/i.test(file.name)) return "application/xml";
  if (/\.ya?ml$/i.test(file.name)) return "application/yaml";
  // The device validates bytes and filenames as well; the browser hint is not a security boundary.
  return /\.(txt|md|csv|log|ts|tsx|js|jsx|mjs|py|kt|java|go|rs|c|h|cpp|css|html)$/i.test(file.name) ? "text/plain" : file.type || "application/octet-stream";
}

export function AttachmentPanel({ items, loading, onUpload, onRemove }: {
  items: Attachment[]; loading: boolean;
  onUpload: (files: File[]) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const upload = async (files: File[]) => {
    setError("");
    try { await onUpload(files); } catch (cause: any) { setError(cause.message); }
    finally { if (input.current) input.current.value = ""; }
  };
  return <>
    <p className="sheet-note">附件上传到当前设备，点击发送后才会随消息交给模型。支持图片（每个最多 4 MiB）和 UTF-8 文本（256 KiB），每条消息最多 8 个；临时附件最多保留 24 小时。不支持 PDF、可执行文件和凭据文件。</p>
    <input className="file-picker" ref={input} aria-label="选择附件" type="file" accept={attachmentAccept} multiple disabled={loading || items.length >= 8} onChange={event => void upload(Array.from(event.target.files || []))} />
    <div className="attachment-list" aria-label="待发送附件">
      {items.map(item => <div className="attachment-item" key={item.id}>
        <Icon name="attachment" /><span><b>{item.name}</b><small>{Math.max(1, Math.ceil(item.size / 1024))} KiB · 待发送</small></span>
        <button className="icon" aria-label={`移除附件 ${item.name}`} disabled={loading} onClick={async () => { try { await onRemove(item.id); } catch (cause: any) { setError(cause.message); } }}><Icon name="close" size={17} /></button>
      </div>)}
    </div>
    {loading && <p className="sheet-note" role="status">正在上传，请勿关闭此页面…</p>}
    {error && <p className="sheet-error" role="alert">{error}</p>}
  </>;
}
