import { AttachmentTray } from './AttachmentTray';
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { commandSuggestions } from "./commands.mjs";
import {
  configuredProviders,
  effectiveSelection,
  mergeModelIds,
  modelLabel,
  capabilityLabel,
} from "./models.mjs";
import { MODE_OPTIONS, modeLabel } from "./modes.mjs";
import type { Attachment } from "./Attachments";
import { APP_VERSION } from "./version";

type Item = Record<string, any>;
type Catalog = { loading?: boolean; error?: string; models: Item[] };
type Picker = "" | "mode" | "model";
function resizeInput(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(160, element.scrollHeight)}px`;
}

function useMenuKeys(
  open: boolean,
  container: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocus: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    container.current?.querySelector("button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        returnFocus.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [
          ...(container.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) || []),
        ];
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [open]);
}

export function Composer({
  prompt,
  onPrompt,
  busy,
  mode,
  modes,
  model = "",
  provider = "",
  settings = {},
  commands,
  onSend,
  onStop,
  stopping = false,
  compacting = false,
  stopInBanner = false,
  onPanel,
  onMode,
  onModel,
  onDiscoverModels,
  onThinking,
  summary,
  readOnly = false,
  canManage = true,
  uploading = false,
  attachments = [],
  attachmentScope,
  onUploadAttachments,
  onRemoveAttachment,
  branch = "",
}: {
  prompt: string;
  onPrompt: (text: string) => void;
  busy: boolean;
  mode: string;
  modes?: Item[];
  model?: string;
  provider?: string;
  settings?: Item;
  commands: Item[];
  onSend: () => void;
  onStop: () => void;
  stopping?: boolean;
  compacting?: boolean;
  stopInBanner?: boolean;
  onPanel: (panel: string) => void;
  onMode?: (mode: string) => void;
  onModel?: (selection: { provider: string; model: string }) => void;
  onDiscoverModels?: (provider: string) => Promise<Item>;
  onThinking?: (provider: string, model: string, value: string) => void;
  summary: { files: number; added: number; removed: number };
  readOnly?: boolean;
  canManage?: boolean;
  uploading?: boolean;
  attachments?: Attachment[];
  attachmentScope: string;
  onUploadAttachments: (files: File[]) => Promise<void>;
  onRemoveAttachment: (id: string) => Promise<void>;
  branch?: string;
}) {
  const [menu, setMenu] = useState(false),
    [highlight, setHighlight] = useState(0),
    [dismissed, setDismissed] = useState(false);
  const [picker, setPicker] = useState<Picker>(""),
    [expanded, setExpanded] = useState(""),
    [catalogs, setCatalogs] = useState<Record<string, Catalog>>({}),
    [manualDraft, setManualDraft] = useState<Record<string, string>>({});
  const input = useRef<HTMLTextAreaElement>(null),
    actionButton = useRef<HTMLButtonElement>(null),
    actions = useRef<HTMLDivElement>(null),
    modeButton = useRef<HTMLButtonElement>(null),
    modelButton = useRef<HTMLButtonElement>(null),
    pickerBody = useRef<HTMLDivElement>(null);
  const needle = prompt.slice(1).trim().toLowerCase();
  const suggestions: Item[] =
    !dismissed && /^\/[^\s]*$/.test(prompt)
      ? commandSuggestions(commands, needle)
      : [];
  const providers = configuredProviders(settings);
  const catalogScope = JSON.stringify(settings.provider || {});
  const activeCatalogScope = useRef(catalogScope), discovering = useRef(new Map<string, string>());
  activeCatalogScope.current = catalogScope;
  useEffect(() => { setCatalogs({}); discovering.current.clear(); }, [catalogScope]);
  const selection = effectiveSelection(settings, { provider, model });
  const modeOptions = modes?.length ? modes : MODE_OPTIONS;
  const pickerAnchor =
    picker === "mode"
      ? modeButton
      : modelButton;
  useEffect(() => {
    setHighlight(0);
    setDismissed(false);
  }, [prompt]);
  useLayoutEffect(() => { resizeInput(input.current); }, [prompt]);
  useEffect(() => {
    const resize = () => resizeInput(input.current);
    let width = input.current?.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.current?.clientWidth !== width) { width = input.current?.clientWidth; resize(); }
    });
    if (input.current) observer.observe(input.current);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, []);
  useMenuKeys(menu, actions, () => setMenu(false), actionButton);
  useMenuKeys(Boolean(picker), pickerBody, () => setPicker(""), pickerAnchor);
  const choose = (command: Item) => {
    onPrompt(`/${command.name} `);
    input.current?.focus();
  };
  const togglePicker = (name: Picker) => {
    if (picker === name) {
      setPicker("");
      return;
    }
    if (name === "model") {
      const target =
        selection.provider || (providers.length === 1 ? providers[0].name : "");
      setExpanded(target);
      if (target) void discover(target);
    }
    setPicker(name);
  };
  const discover = async (name: string) => {
    if (!onDiscoverModels || discovering.current.get(name) === catalogScope) return;
    const scope = catalogScope;
    discovering.current.set(name, scope);
    setCatalogs((old) => ({
      ...old,
      [name]: { loading: true, models: old[name]?.models || [] },
    }));
    try {
      const result = await onDiscoverModels(name);
      if (activeCatalogScope.current !== scope) return;
      setCatalogs((old) => ({
        ...old,
        [name]: {
          models: (result?.models || []).filter((entry: Item) => entry?.id),
          error: result?.warning || '',
        },
      }));
    } catch (cause: any) {
      if (activeCatalogScope.current !== scope) return;
      setCatalogs((old) => ({
        ...old,
        [name]: {
          models: old[name]?.models || [],
          error: cause?.message || "模型列表读取失败",
        },
      }));
    } finally { if (discovering.current.get(name) === scope) discovering.current.delete(name); }
  };
  const chooseModel = (providerName: string, id: string) => {
    setPicker("");
    modelButton.current?.focus();
    if (onModel && (selection.provider !== providerName || selection.model !== id))
      onModel({ provider: providerName, model: id });
  };
  const pickerShell = (name: Picker, label: string, children: React.ReactNode) => (
    <>
      <button
        type="button"
        className="menu-backdrop"
        tabIndex={-1}
        aria-label={`收起${label}菜单`}
        onClick={() => {
          setPicker("");
          pickerAnchor.current?.focus();
        }}
      />
      <div
        ref={pickerBody}
        className={`composer-menu chip-menu${name === "model" ? " model-menu" : ""}`}
        role="menu"
        aria-label={label}
      >
        {children}
      </div>
    </>
  );
  const optionRow = (
    item: Item,
    checked: boolean,
    onClick: () => void,
  ) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      key={item.id}
      onClick={onClick}
    >
      <Icon name="check" size={16} />
      <span>
        <b>{item.label || item.id}</b>
        {item.desc && <small>{item.desc}</small>}
      </span>
    </button>
  );
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
      <AttachmentTray scope={attachmentScope} items={attachments} disabled={readOnly || !canManage} uploading={uploading} onUpload={onUploadAttachments} onRemove={onRemoveAttachment}>
      <textarea
          rows={1}
        disabled={readOnly}
          ref={input}
          aria-label="消息"
          aria-autocomplete="list"
          aria-controls={suggestions.length ? "slash-commands" : undefined}
          aria-activedescendant={
            suggestions.length ? `command-${highlight}` : undefined
          }
          placeholder={readOnly ? "只读共享会话" : busy ? stopInBanner ? "补充要求，智能体会在安全节点读取" : "正在执行，可随时停止" : "发消息，或输入 / 命令"}
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
              setPicker("");
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
      </AttachmentTray>
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
          <div className="composer-picker">
            <button
              ref={modeButton}
              type="button"
              className="mode-chip"
              disabled={!canManage || readOnly}
              aria-label={`执行模式，当前 ${modeLabel(mode)}`}
              aria-expanded={picker === "mode"}
              aria-haspopup="menu"
              onClick={() => togglePicker("mode")}
            >
              <Icon name="shield" size={14} />
              <span>{modeLabel(mode)}</span>
              <Icon name="down" size={12} />
            </button>
            {picker === "mode" &&
              pickerShell("mode", "执行模式", (
                <>
                  {modeOptions.map((item: Item) =>
                    optionRow(item, mode === item.id, () => {
                      setPicker("");
                      modeButton.current?.focus();
                      if (onMode && mode !== item.id) onMode(item.id);
                    }),
                  )}
                  <button
                    type="button"
                    className="model-manage"
                    onClick={() => {
                      setPicker("");
                      onPanel("mode");
                    }}
                  >
                    <Icon name="settings" size={16} />
                    模式说明…
                  </button>
                </>
              ))}
          </div>
          {branch && canManage && <button className="branch-chip" type="button" onClick={() => onPanel("branches")} aria-label={`当前分支 ${branch}`}><Icon name="branch" size={14} /><span>{branch}</span></button>}
          <div className="composer-right">
          <div className="composer-model">
            <button
              ref={modelButton}
              type="button"
              className="model-chip"
              disabled={!canManage || readOnly}
              aria-label={`选择模型，当前 ${selection.model ? `${selection.provider} 的 ${selection.model}` : "未配置"}`}
              aria-expanded={picker === "model"}
              aria-haspopup="menu"
              onClick={() => togglePicker("model")}
            >
              <Icon name="cloud" size={14} />
              <span>{modelLabel(selection.model) || "选择模型"}</span>
              <Icon name="down" size={12} />
            </button>
            {picker === "model" &&
              pickerShell(
                "model",
                "选择模型",
                <>
                  {providers.map((entry) => {
                    const open = expanded === entry.name;
                    const catalog = catalogs[entry.name];
                    const origin = new Map(
                      (catalog?.models || []).map((item: Item) => [
                        item.id,
                        item.origin,
                      ]),
                    );
                    const ids = mergeModelIds(
                      [entry.defaultModel],
                      (catalog?.models || []).map((item: Item) => item.id),
                      selection.provider === entry.name ? [selection.model] : [],
                    );
                    return (
                      <div className="model-group" key={entry.name}>
                        <button
                          type="button"
                          className="model-provider"
                          aria-expanded={open}
                          onClick={() => {
                            setExpanded(open ? "" : entry.name);
                            if (!open) void discover(entry.name);
                          }}
                        >
                          <Icon name="cloud" size={17} />
                          <span className="tool-label">{entry.name}</span>
                          <small>{modelLabel(entry.defaultModel)}</small>
                          <Icon name="chevron" size={14} />
                        </button>
                        {open && (
                          <div
                            className="model-choices"
                            role="group"
                            aria-label={`${entry.name} 的模型`}
                          >
                            {ids.map((id) => (
                              <button
                                type="button"
                                role="menuitemradio"
                                aria-checked={
                                  selection.provider === entry.name &&
                                  selection.model === id
                                }
                                key={id}
                                onClick={() => chooseModel(entry.name, id)}
                              >
                                <Icon name="check" size={16} />
                                <span className="tool-label">{id}</span>
                                {capabilityLabel(catalog?.models.find(item => item.id === id)) && <small>{capabilityLabel(catalog?.models.find(item => item.id === id))}</small>}
                                {origin.get(id) === "manual" && <em>手动</em>}
                                {id === entry.defaultModel && <em>默认</em>}
                              </button>
                            ))}
                            {entry.name === (selection.provider || settings.provider?.default) && (() => {
                              const selectedModel = selection.model || entry.defaultModel;
                              const active = catalog?.models.find(item => item.id === selectedModel);
                              const runtime = active?.runtime;
                              const control = runtime?.thinking;
                              const saved = settings.provider?.[entry.name]?.model_options?.[selectedModel]?.thinking_effort;
                              const current = control?.options?.some((option: Item) => option.value === saved) ? saved : control?.selected ?? 'auto';
                              if (!runtime) return <div className="model-thinking" aria-label="思考强度"><span>思考强度</span><small>{catalog?.loading ? '正在读取模型的思考设置…' : !selectedModel ? '请先选择模型。' : !active ? '当前模型信息暂未就绪，请重新读取模型列表。' : '电脑端未提供思考设置。请确认电脑上的 KK Code / remote 为 1.0.10 或更新版本，然后重新连接。'}</small></div>;
                              return <div className="model-thinking" aria-label="思考强度">
                                {control?.kind === 'unknown' && <small>尚未确认此模型的可调思考选项，当前沿用默认设置。</small>}
                                {control?.kind === 'unsupported' && <small>此模型不支持思考调节。</small>}
                                {control?.kind === 'fixed' && <small>{control.budgetUnavailable ? '当前输出额度不足以开启可调思考。' : '此模型的思考方式由服务端固定。'}</small>}
                                {control?.kind === 'toggle' ? <div className="thinking-switch">
                                  <button type="button" disabled={busy || readOnly || !canManage || !onThinking} aria-pressed={current === 'auto'} onClick={() => { onThinking?.(entry.name, selectedModel, 'auto'); setPicker(''); }}>自动</button>
                                  <button type="button" role="switch" aria-label="思考开关" aria-checked={current === 'on'} disabled={busy || readOnly || !canManage || !onThinking} onClick={() => { onThinking?.(entry.name, selectedModel, current === 'on' ? 'off' : 'on'); setPicker(''); }}>思考 · {current === 'auto' ? '沿用默认' : current === 'on' ? '开' : '关'}</button>
                                </div> : <label>思考强度 <select aria-label="思考强度" value={current} disabled={busy || readOnly || !canManage || !onThinking} onChange={event => { onThinking?.(entry.name, selectedModel, event.target.value); setPicker(''); }}>
                                  {control?.options?.map((option: Item) => <option key={option.value} value={option.value} disabled={!option.available}>{option.label} · {option.description}</option>)}
                                </select></label>}
                                <small>上下文 {Number(runtime.context.limit).toLocaleString()}<br />输出预留 {Number(runtime.output.reserved).toLocaleString()}{runtime.output.source === 'estimated' ? '（估算）' : runtime.output.source === 'catalog' ? '（接口）' : ''}</small>
                              </div>;
                            })()}
                            {catalog?.loading && (
                              <p className="model-status" role="status">
                                正在读取模型列表…
                              </p>
                            )}
                            {catalog?.error && (
                              <>
                                <p className="model-status" role="alert">
                                  {catalog.error}
                                </p>
                                <form
                                  className="model-manual"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    const id = (
                                      manualDraft[entry.name] || ""
                                    ).trim();
                                    if (id) chooseModel(entry.name, id);
                                  }}
                                >
                                  <input
                                    aria-label={`手动输入 ${entry.name} 的模型 id`}
                                    placeholder="手动输入模型 id"
                                    value={manualDraft[entry.name] || ""}
                                    onChange={(event) =>
                                      setManualDraft((old) => ({
                                        ...old,
                                        [entry.name]: event.target.value,
                                      }))
                                    }
                                  />
                                  <button
                                    type="submit"
                                    disabled={
                                      !(manualDraft[entry.name] || "").trim()
                                    }
                                  >
                                    使用
                                  </button>
                                </form>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!providers.length && (
                    <p className="model-status">还没有配置模型渠道。</p>
                  )}
                  <button
                    type="button"
                    className="model-manage"
                    onClick={() => {
                      setPicker("");
                      onPanel("models");
                    }}
                  >
                    <Icon name="settings" size={16} />
                    管理渠道与模型…
                  </button>
                </>,
              )}
          </div>
          {busy && !stopInBanner && prompt.trim() && !stopping && !compacting && <button type="button" className="send" aria-label="发送补充要求" disabled={readOnly || uploading} onClick={onSend}><Icon name="send" size={21} /></button>}
          {busy && !stopInBanner ? (
            <button
              type="button"
              className="send"
              aria-label={stopping ? '正在停止' : '停止'}
              disabled={readOnly || stopping}
              onClick={onStop}
            >
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button
              className="send"
              aria-label={busy ? '发送补充要求' : '发送'}
              disabled={readOnly || uploading || stopping || compacting || (!prompt.trim() && !attachments.length)}
            >
              <Icon name="send" size={21} />
            </button>
          )}
          </div>
        </div>
      </form>
      <small className="footnote">
        运行于你的电脑 · 操作遵循工作区权限 · KK Code {APP_VERSION}
      </small>
    </div>
  );
}
