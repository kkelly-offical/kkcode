import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { commandSuggestions } from "./commands.mjs";
import type { Attachment } from "./Attachments";

type Item = Record<string, any>;
export function Composer({
  prompt,
  onPrompt,
  busy,
  mode,
  commands,
  onSend,
  onStop,
  onPanel,
  summary,
  readOnly = false,
  canManage = true,
  uploading = false,
  attachments = [],
  branch = "",
}: {
  prompt: string;
  onPrompt: (text: string) => void;
  busy: boolean;
  mode: string;
  commands: Item[];
  onSend: () => void;
  onStop: () => void;
  onPanel: (panel: string) => void;
  summary: { files: number; added: number; removed: number };
  readOnly?: boolean;
  canManage?: boolean;
  uploading?: boolean;
  attachments?: Attachment[];
  branch?: string;
}) {
  const [menu, setMenu] = useState(false),
    [highlight, setHighlight] = useState(0),
    [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null),
    actionButton = useRef<HTMLButtonElement>(null),
    actions = useRef<HTMLDivElement>(null);
  const needle = prompt.slice(1).trim().toLowerCase();
  const suggestions: Item[] =
    !dismissed && /^\/[^\s]*$/.test(prompt)
      ? commandSuggestions(commands, needle)
      : [];
  useEffect(() => {
    setHighlight(0);
    setDismissed(false);
  }, [prompt]);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(160, input.current.scrollHeight)}px`;
    }
  }, [prompt]);
  useEffect(() => {
    if (!menu) return;
    actions.current?.querySelector("button")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(false);
        actionButton.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...(actions.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [menu]);
  const choose = (command: Item) => {
    onPrompt(`/${command.name} `);
    input.current?.focus();
  };
  return (
    <div className="composer-wrap">
      {summary.files > 0 && (
        <div className="session-changes">
          <Icon name="chat" size={14} />
          <span>{summary.files} 个文件</span>
          <span className="diff-stat">
            <em>+{summary.added}</em>
            <em>−{summary.removed}</em>
          </span>
        </div>
      )}
      {suggestions.length > 0 && (
        <div
          className="command-popover"
          role="listbox"
          id="slash-commands"
          aria-label="命令建议"
        >
          {suggestions.map((command, index) => (
            <button
              type="button"
              role="option"
              id={`command-${index}`}
              aria-selected={index === highlight}
              className={index === highlight ? "highlight" : ""}
              key={command.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(command)}
            >
              <Icon
                name={
                  command.name === "plan"
                    ? "settings"
                    : command.name === "ultra"
                      ? "priority"
                      : "terminal"
                }
              />
              <span>
                <b>/{command.name}</b>
                <small>{command.description}</small>
              </span>
              <em>命令</em>
            </button>
          ))}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
      {attachments.length > 0 && <button type="button" className="attachment-summary" onClick={() => onPanel("attachments")}><Icon name="attachment" size={15} /><span>{attachments.map(item => item.name).join("、")}</span><small>{attachments.length} 个附件</small></button>}
      {uploading && <p className="upload-status" role="status">附件上传中…</p>}
      <textarea
        disabled={readOnly}
          ref={input}
          aria-label="消息"
          aria-autocomplete="list"
          aria-controls={suggestions.length ? "slash-commands" : undefined}
          aria-activedescendant={
            suggestions.length ? `command-${highlight}` : undefined
          }
          placeholder={readOnly ? "只读共享会话" : busy ? "正在执行，可随时停止" : "发消息，或输入 / 命令"}
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (
              suggestions.length &&
              ["ArrowDown", "ArrowUp"].includes(event.key)
            ) {
              event.preventDefault();
              setHighlight(
                (index) =>
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    suggestions.length) %
                  suggestions.length,
              );
              return;
            }
            if (event.key === "Escape") {
              setDismissed(true);
              setMenu(false);
              return;
            }
            if (
              suggestions.length &&
              (event.key === "Tab" ||
                (event.key === "Enter" &&
                  !event.shiftKey &&
                  prompt !== `/${suggestions[highlight].name}`))
            ) {
              event.preventDefault();
              choose(suggestions[highlight]);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="composer-tools">
          {canManage && <div className="composer-actions">
            <button
              ref={actionButton}
              type="button"
              className="icon composer-plus"
              aria-label="添加与工具"
              aria-expanded={menu}
              aria-haspopup="menu"
              onClick={() => setMenu(!menu)}
            >
              <Icon name="plus" size={24} />
            </button>
            {menu && (
              <>
                <button
                  type="button"
                  className="menu-backdrop"
                  tabIndex={-1}
                  aria-label="收起工具菜单"
                  onClick={() => {
                    setMenu(false);
                    actionButton.current?.focus();
                  }}
                />
                <div
                  ref={actions}
                  className="composer-menu"
                  role="menu"
                  aria-label="添加与工具"
                >
                  {[
                    ["attachments", "attachment", "添加附件"],
                    ["mode", "shield", "执行模式"],
                    ["folders", "folder", "工作目录"],
                    ["branches", "branch", "Git 分支"],
                    ["models", "cloud", "模型与渠道"],
                    ["extensions", "extension", "MCP、Skills 与插件"],
                  ].map(([panel, icon, label]) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={panel}
                      onClick={() => {
                        setMenu(false);
                        onPanel(panel);
                      }}
                    >
                      <Icon name={icon as any} />
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>}
          <button
            type="button"
            className="mode-chip"
            disabled={!canManage}
            onClick={() => onPanel("mode")}
          >
            <Icon name="shield" size={14} />
            {mode}
            <Icon name="down" size={12} />
          </button>
          {branch && canManage && <button className="branch-chip" type="button" onClick={() => onPanel("branches")} aria-label={`当前分支 ${branch}`}><Icon name="branch" size={14} /><span>{branch}</span></button>}
          {busy ? (
            <button
              type="button"
              className="send"
              aria-label="停止"
              disabled={readOnly}
              onClick={onStop}
            >
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button
              className="send"
              aria-label="发送"
              disabled={readOnly || uploading || !prompt.trim()}
            >
              <Icon name="send" size={21} />
            </button>
          )}
        </div>
      </form>
      <small className="footnote">
        运行于你的电脑 · 操作遵循工作区权限 · KK Code 1.0.1
      </small>
    </div>
  );
}
