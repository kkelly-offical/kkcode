import React, { useEffect, useState } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { Icon, type IconName } from "./Icon";
import { toolPresentation } from "./transcript.mjs";

type Item = Record<string, any>;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!);
const markdown = new Marked({ renderer: {
  image: ({ href, text }) => `<a href="${escapeHtml(href)}">${escapeHtml(text || "查看图片链接")} ↗</a>`,
  checkbox: ({ checked }) => `<span aria-label="${checked ? "已完成" : "未完成"}">${checked ? "☑" : "☐"}</span> `,
} });
export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(
          markdown.parse(text || "", { async: false }) as string,
          // Remote transcript content must not silently contact third-party media hosts.
          { USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "iframe", "video", "audio", "source", "style", "link", "object", "embed", "input"], FORBID_ATTR: ["style", "ping"] },
        ),
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
export function ThinkingRow({ row }: { row: Item }) {
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
    <details className="thinking-row">
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
      <div>{row.text || "正在思考…"}</div>
    </details>
  );
}
export function TranscriptRow({ row }: { row: Item }) {
  if (row.type === "tool") return <ToolRow payload={row.payload} />;
  if (row.type === "thinking") return <ThinkingRow row={row} />;
  if (row.type === "compacted")
    return (
      <div className="context-divider">
        <span>已精简上下文</span>
      </div>
    );
  return (
    <article className={`message ${row.type}`}>
      <Markdown text={row.text} />
    </article>
  );
}
