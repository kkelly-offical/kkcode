import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { commandSuggestions } from "./commands.mjs";
import {
  configuredProviders,
  effectiveSelection,
  mergeModelIds,
  modelLabel,
} from "./models.mjs";
import { MODE_OPTIONS, PERMISSION_OPTIONS, permissionLabel } from "./modes.mjs";
import type { Attachment } from "./Attachments";
import { APP_VERSION } from "./version";

type Item = Record<string, any>;
type Catalog = { loading?: boolean; error?: string; models: Item[] };
type Picker = "" | "mode" | "permission" | "model";

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
  permission = "",
  modes,
  model = "",
  provider = "",
  settings = {},
  commands,
  onSend,
  onStop,
  onPanel,
  onMode,
  onPermission,
  onModel,
  onDiscoverModels,
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
  permission?: string;
  modes?: Item[];
  model?: string;
  provider?: string;
  settings?: Item;
  commands: Item[];
  onSend: () => void;
  onStop: () => void;
  onPanel: (panel: string) => void;
  onMode?: (mode: string) => void;
  onPermission?: (permission: string) => void;
  onModel?: (selection: { provider: string; model: string }) => void;
  onDiscoverModels?: (provider: string) => Promise<Item>;
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
  const [picker, setPicker] = useState<Picker>(""),
    [expanded, setExpanded] = useState(""),
    [catalogs, setCatalogs] = useState<Record<string, Catalog>>({}),
    [manualDraft, setManualDraft] = useState<Record<string, string>>({});
  const input = useRef<HTMLTextAreaElement>(null),
    actionButton = useRef<HTMLButtonElement>(null),
    actions = useRef<HTMLDivElement>(null),
    modeButton = useRef<HTMLButtonElement>(null),
    permissionButton = useRef<HTMLButtonElement>(null),
    modelButton = useRef<HTMLButtonElement>(null),
    pickerBody = useRef<HTMLDivElement>(null);
  const needle = prompt.slice(1).trim().toLowerCase();
  const suggestions: Item[] =
    !dismissed && /^\/[^\s]*$/.test(prompt)
      ? commandSuggestions(commands, needle)
      : [];
  const providers = configuredProviders(settings);
  const selection = effectiveSelection(settings, { provider, model });
  const modeOptions = modes?.length ? modes : MODE_OPTIONS;
  const pickerAnchor =
    picker === "mode"
      ? modeButton
      : picker === "permission"
        ? permissionButton
        : modelButton;
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
    const known = catalogs[name];
    if (!onDiscoverModels || known?.loading || known?.models.length) return;
    setCatalogs((old) => ({
      ...old,
      [name]: { loading: true, models: old[name]?.models || [] },
    }));
    try {
      const result = await onDiscoverModels(name);
      setCatalogs((old) => ({
        ...old,
        [name]: {
          models: (result?.models || []).filter((entry: Item) => entry?.id),
        },
      }));
    } catch (cause: any) {
      setCatalogs((old) => ({
        ...old,
        [name]: {
          models: old[name]?.models || [],
          error: cause?.message || "模型列表读取失败",
        },
      }));
    }
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
              aria-label={`执行模式，当前 ${mode}`}
              aria-expanded={picker === "mode"}
              aria-haspopup="menu"
              onClick={() => togglePicker("mode")}
            >
              <Icon name="shield" size={14} />
              <span>{mode}</span>
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
          <div className="composer-picker">
            <button
              ref={permissionButton}
              type="button"
              className="mode-chip"
              disabled={!canManage || readOnly}
              aria-label={`操作权限，当前 ${permissionLabel(permission)}`}
              aria-expanded={picker === "permission"}
              aria-haspopup="menu"
              onClick={() => togglePicker("permission")}
            >
              <Icon name="lock" size={14} />
              <span>{permissionLabel(permission)}</span>
              <Icon name="down" size={12} />
            </button>
            {picker === "permission" &&
              pickerShell("permission", "操作权限", (
                <>
                  {PERMISSION_OPTIONS.map((item) =>
                    optionRow(item, (permission || "manual") === item.id, () => {
                      setPicker("");
                      permissionButton.current?.focus();
                      if (onPermission && permission !== item.id)
                        onPermission(item.id);
                    }),
                  )}
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
                                {origin.get(id) === "manual" && <em>手动</em>}
                                {id === entry.defaultModel && <em>默认</em>}
                              </button>
                            ))}
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
        </div>
      </form>
      <small className="footnote">
        运行于你的电脑 · 操作遵循工作区权限 · KK Code {APP_VERSION}
      </small>
    </div>
  );
}
