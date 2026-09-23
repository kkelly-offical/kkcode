import React, { useEffect, useState } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { Icon, type IconName } from "./Icon";
import { toolPresentation } from "./transcript.mjs";
import { browserLink } from './source-links.mjs';

type Item = Record<string, any>;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!);
const markdown = new Marked({ renderer: {
  image: ({ href, text }) => `<a href="${escapeHtml(href)}">${escapeHtml(text || "查看图片链接")} ↗</a>`,
  checkbox: ({ checked }) => `<span aria-label="${checked ? "已完成" : "未完成"}">${checked ? "☑" : "☐"}</span> `,
} });
export function Markdown({ text }: { text: string }) {
  const clean = DOMPurify.sanitize(markdown.parse(text || '', { async: false }) as string,
    { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'iframe', 'video', 'audio', 'source', 'style', 'link', 'object', 'embed', 'input'], FORBID_ATTR: ['style', 'ping'] });
  const document = new DOMParser().parseFromString(clean, 'text/html');
  for (const anchor of document.querySelectorAll('a')) {
    const url = browserLink(anchor.getAttribute('href'));
    if (!url) { anchor.removeAttribute('href'); anchor.removeAttribute('target'); continue; }
    anchor.setAttribute('href', url); anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer'); anchor.setAttribute('referrerpolicy', 'no-referrer');
  }
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{
        __html: document.body.innerHTML,
      }}
    />
  );
}
export function ToolRow({ payload }: { payload: Item }) {
  const tool = toolPresentation(payload);
  return (
    <details className={`tool-row${tool.failed ? " tool-failed" : ""}`}>
      <summary>
        <Icon name={tool.icon as IconName} size={17} />
        <span className="tool-label">{tool.title}</span>
        {tool.added + tool.removed > 0 && (
          <span className="diff-stat">
            <em>+{tool.added}</em>
            <em>−{tool.removed}</em>
          </span>
        )}
        {payload.status === "running" ? (
          <i className="working" />
        ) : (
          <Icon name="chevron" size={14} />
        )}
      </summary>
      <div className="tool-body">
        {tool.mutations.map((mutation: Item, index: number) => (
          <div className="code-change" key={index}>
            <p>{mutation.filePath}</p>
            {(mutation.structuredPatch || []).map((hunk: Item, h: number) => (
              <pre className="diff-code" key={h}>
                <span className="diff-hunk">
                  @@ −{hunk.oldStart},{hunk.oldLineCount} +{hunk.newStart},
                  {hunk.newLineCount} @@
                </span>
                {(hunk.lines || []).map((line: Item, i: number) => (
                  <span className={`diff-line diff-${line.type}`} key={i}>
                    <b aria-hidden="true">
                      {line.type === "add"
                        ? "+"
                        : line.type === "remove"
                          ? "−"
                          : " "}
                    </b>
                    {line.text || " "}
                  </span>
                ))}
              </pre>
            ))}
          </div>
        ))}
        {tool.detail && <pre>{tool.detail}</pre>}
        {tool.args && tool.args !== "{}" && (
          <details className="tool-args">
            <summary>调用参数</summary>
            <pre>{tool.args}</pre>
          </details>
        )}
        {tool.durationMs != null && (
          <small>
            耗时 {(tool.durationMs / 1000).toFixed(1)} 秒 · {payload.status}
          </small>
        )}
        {!tool.detail && !tool.mutations.length && (
          <p>
            {payload.status === "running"
              ? "正在执行…"
              : "此工具没有额外输出。"}
          </p>
        )}
      </div>
    </details>
  );
}
export function ThinkingRow({ row, initiallyExpanded = false, onExpanded }: { row: Item; initiallyExpanded?: boolean; onExpanded?: (expanded: boolean) => void }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!row.done) {
      const interval = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(interval);
    }
  }, [row.done]);
  const duration =
    row.durationMs ?? (!row.done && row.timestamp ? now - row.timestamp : null);
  return (
    <details className="thinking-row" open={expanded} onToggle={event => { const open = event.currentTarget.open; setExpanded(open); onExpanded?.(open); }}>
      <summary>
        {!row.done && <i className="working" />}
        <span>
          Thinking
          {duration != null
            ? ` · ${Math.max(0, Math.floor(duration / 1000))} 秒`
            : ""}
        </span>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="thinking-content" aria-live="polite">{row.text || "模型尚未返回可展示的思考内容；收到后会在这里实时更新。部分模型不提供思考文本。"}</div>
    </details>
  );
}
function MediaPreview({ row, loadPreview }: { row: Item; loadPreview?: (reference: Item) => Promise<Item> }) {
  const [image, setImage] = useState(""), [loading, setLoading] = useState(false), [error, setError] = useState("");
  async function open() {
    if (!loadPreview || loading || image) return;
    setLoading(true); setError("");
    try {
      const value = await loadPreview(row.reference);
      if (!/^image\/(png|jpeg|webp|gif)$/.test(value.mediaType) || typeof value.data !== "string") throw new Error("设备返回了不支持的预览格式");
      setImage(`data:${value.mediaType};base64,${value.data}`);
    } catch (cause: any) { setError(cause.message); }
    finally { setLoading(false); }
  }
  return <details className="media-preview tool-row" onToggle={event => { if (event.currentTarget.open) void open(); }}>
    <summary><Icon name="attachment" size={17} /><span>图片预览{row.mediaType === "image/svg+xml" ? " · SVG 安全渲染" : ""}</span><Icon name="chevron" size={14} /></summary>
    {loading && <p className="sheet-note">正在从当前会话读取图片…</p>}
    {image && <a href={image} download="kkcode-preview"><img src={image} alt="会话图片预览" loading="lazy" /></a>}
    {error && <p className="sheet-error">{error} <button onClick={() => void open()}>重试</button></p>}
  </details>;
}
export function TranscriptRow({ row, loadPreview, onRewind, thinkingExpanded, onThinkingExpanded }: { row: Item; loadPreview?: (reference: Item) => Promise<Item>; onRewind?: (row: Item) => void; thinkingExpanded?: boolean; onThinkingExpanded?: (expanded: boolean) => void }) {
  if (row.type === 'run-summary') return <details className="tool-row run-summary">
    <summary><Icon name="chevron" size={14} /><span>{row.durationMs != null ? `已运行 ${Math.floor(row.durationMs / 1000)} 秒` : '运行过程已完成'}{row.tools ? ` · ${row.tools} 次工具调用` : ''}</span></summary>
    <div className="run-summary-body">{row.rows.map((child: Item) => <TranscriptRow key={child.id} row={child} loadPreview={loadPreview} />)}</div>
  </details>;
  if (row.type === "tool") return <ToolRow payload={row.payload} />;
  if (row.type === "media") return <MediaPreview row={row} loadPreview={loadPreview} />;
  if (row.type === "review") return <details className="tool-row review-row"><summary>{!row.done && <i className="working" />}<Icon name="shield" size={17} /><span>Auto 审查 · {row.tool} · {row.done ? ({ allow: "允许", deny: "拒绝", ask: "交给你确认" } as Item)[row.decision] || "已完成" : "进行中"}</span></summary><div className="tool-body"><p>{row.text}</p>{row.model && <small>对话模型：{row.model}</small>}</div></details>;
  if (row.type === "thinking") return <ThinkingRow row={row} initiallyExpanded={thinkingExpanded} onExpanded={onThinkingExpanded} />;
  if (row.type === "compacted")
    return (
      <div className="context-divider">
        <span>已精简上下文</span>
      </div>
    );
  return (
    <article className={`message ${row.type}`}>
      <Markdown text={row.text} />
      {row.type === "user" && row.messageId && onRewind && <button className="message-rewind" aria-label="从这条提问回退" onClick={() => onRewind(row)}><Icon name="back" size={14} />回退</button>}
    </article>
  );
}
