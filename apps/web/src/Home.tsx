import React, { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { Sheet } from "./Sheet";
import { groupSessions } from "./sessions.mjs";
import { PixelBuddy, PixelScene } from "./PixelStudio";
import { APP_VERSION } from "./version";
import { deviceLoginPath } from "../../../src/protocol/login-path.mjs";

type Item = Record<string, any>;
type HomeProps = {
  sessions?: Item[];
  name?: string;
  connected?: boolean;
  onSelect: (session: Item) => void;
  onNew: () => void;
  onSettings: () => void;
  onConnect: () => void;
  canManage?: boolean;
  onManage?: (session: Item) => void;
  projectLabel?: string;
  onProject?: () => void;
};
const sortOptions: [string, string, IconName][] = [
  ["priority", "优先级", "priority"],
  ["project", "按项目", "folder"],
  ["time", "按时间倒序排列", "clock"],
];

export function SessionHome({
  sessions = [],
  name = "未连接设备",
  connected = false,
  onSelect,
  onNew,
  onSettings,
  onConnect,
  canManage = false,
  onManage,
  projectLabel,
  onProject,
}: HomeProps) {
  const [query, setQuery] = useState(""),
    [menu, setMenu] = useState(false);
  const [sort, setSort] = useState("priority"),
    [archived, setArchived] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const menuRef = useRef<HTMLDivElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);
  const groups = groupSessions(sessions, { sort, query, archived });
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector("button")?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(false);
        menuButton.current?.focus();
      } else if (event.key === "Tab") setMenu(false);
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [
          ...(menuRef.current?.querySelectorAll("button") || []),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
        ]?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [menu]);
  const toggleGroup = (name: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  return (
    <div className="remote-home">
      <div className="remote-top">
        <button className="round" aria-label="连接管理" onClick={onConnect}>
          <Icon name="menu" />
        </button>
        <button
          className="remote-title"
          onClick={onConnect}
          aria-label={"当前设备：" + name}
        >
          <b>KK Code <span className="home-title-detail">/ 远程</span></b>
          <small>
            <i className={connected ? "online" : ""} />
            <Icon name="terminal" size={13} />
            <span>{name}</span>
          </small>
        </button>
        <button
          className="round"
          aria-label="更多"
          aria-haspopup="menu"
          aria-expanded={menu}
          ref={menuButton}
          onClick={() => setMenu(!menu)}
        >
          <Icon name="more" />
        </button>
      </div>
      {connected && onProject && <button className="home-project" onClick={onProject}><Icon name="folder" size={18} /><span>{projectLabel || '全部项目'}</span><Icon name="down" size={16} /></button>}
      {menu && (
        <>
          <button
            aria-label="收起菜单"
            tabIndex={-1}
            className="menu-backdrop"
            onClick={() => {
              setMenu(false);
              menuButton.current?.focus();
            }}
          />
          <div
            className="remote-menu"
            role="menu"
            aria-label="会话菜单"
            ref={menuRef}
          >
            {sortOptions.map(([key, label, icon]) => (
              <button
                role="menuitemradio"
                aria-checked={sort === key}
                key={key}
                onClick={() => {
                  setSort(key);
                  setMenu(false);
                  menuButton.current?.focus();
                }}
              >
                <Icon name={sort === key ? "check" : icon} size={19} />
                {label}
              </button>
            ))}
            <hr />
            <small>管理</small>
            <button
              role="menuitem"
              onClick={() => {
                setArchived(!archived);
                setMenu(false);
              }}
            >
              <Icon name="archive" size={19} />
              {archived ? "全部对话" : "已归档对话"}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(false);
                onConnect();
              }}
            >
              <Icon name="link" size={19} />
              添加连接
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(false);
                onSettings();
              }}
            >
              <Icon name="settings" size={19} />
              设置
            </button>
          </div>
        </>
      )}
      <div className="home-studio-label"><span>YOUR PIXEL WORKSPACE</span><span>{connected ? "CONNECTED" : "LET’S CONNECT"}</span></div>
      <div className="remote-session-list">
        {groups.length ? (
          groups.map(([group, items]: [string, Item[]]) => (
            <section key={group}>
              <h2>
                <button
                  aria-expanded={!collapsed.has(group)}
                  onClick={() => toggleGroup(group)}
                >
                  {group}
                  <Icon
                    name={collapsed.has(group) ? "chevron" : "down"}
                    size={13}
                  />
                </button>
              </h2>
              {!collapsed.has(group) &&
                items.map((session) => (
                  <div className="session-list-row" key={session.id}>
                  <button
                    className="remote-session"
                    onClick={() => onSelect(session)}
                  >
                    <div>
                      <span>{session.title || "新对话"}</span>
                      {String(session.status || "").startsWith("running") && (
                        <i className="working" aria-label="进行中" />
                      )}
                    </div>
                    <small>
                      <Icon name="folder" size={14} />
                      <span className="session-project">
                        {String(session.cwd || "")
                          .split(/[\\/]/)
                          .filter(Boolean)
                          .at(-1) || "工作区"}
                      </span>
                      <span className="diff-count">
                        {session.addedLines > 0 && (
                          <em>+{session.addedLines}</em>
                        )}
                        {session.removedLines > 0 && (
                          <em className="minus"> −{session.removedLines}</em>
                        )}
                      </span>
                    </small>
                  </button>
                  {canManage && <button className="icon session-more" aria-label={`管理对话 ${session.title || "新对话"}`} onClick={() => onManage?.(session)}><Icon name="more" size={19} /></button>}
                  </div>
                ))}
            </section>
          ))
        ) : (
          <div className="remote-empty">
            {query ? <Icon name="search" size={30} /> : <><PixelScene /><div className="studio-eyebrow">A LITTLE SPACE FOR BIG IDEAS</div></>}
            <h2>
              {query
                ? "没有找到相关对话"
                : archived
                  ? "没有已归档的对话"
                  : connected
                    ? "还没有对话"
                    : "你的对话，在这里继续"}
            </h2>
            <p>
              {query
                ? "试试其他关键词或项目名称。"
                : connected
                  ? "选择工作目录，开始新的聊天。"
                  : "连接一台电脑，随时回到你的工作区。"}
            </p>
            {!connected && !query && (
              <button onClick={onConnect}>添加连接</button>
            )}
          </div>
        )}
      </div>
      <div className="remote-bottom">
        <label>
          <Icon name="search" size={19} />
          <input
            aria-label="搜索聊天"
            placeholder="搜索聊天"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button onClick={onNew}>
          <Icon name="chat" size={20} />
          聊天
        </button>
      </div>
    </div>
  );
}

export function ConversationMenu({ canManage, busy, archived, onAction }: { canManage: boolean; busy: boolean; archived: boolean; onAction: (action: string) => void }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus(); }
      else if (event.key === 'Tab') setOpen(false);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', keys);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', keys); };
  }, [open]);
  const choose = (action: string) => { setOpen(false); button.current?.focus(); onAction(action); };
  return <div className="conversation-menu" ref={root}>
    <button className="icon" aria-label="对话设置" aria-haspopup="menu" aria-expanded={open} ref={button} onClick={() => setOpen(!open)}><Icon name="more" size={20} /></button>
    {open && <div className="conversation-actions" role="menu" aria-label="对话操作">
      {!canManage && <><button role="menuitem" onClick={() => choose('subagents')}>子代理</button><button role="menuitem" onClick={() => choose('artifacts')}>会话产物</button></>}
      {canManage && <><button role="menuitem" disabled={busy || archived} onClick={() => choose('compact')}>压缩上下文</button><hr /><button role="menuitem" onClick={() => choose('rename')}>改名</button>
        <button role="menuitem" disabled={busy} onClick={() => choose('archive')}>{archived ? '恢复' : '归档'}</button>
        <button role="menuitem" className="danger" disabled={busy} onClick={() => choose('delete')}>删除</button></>}
      <hr /><button role="menuitem" onClick={() => choose('settings')}>设置</button>
    </div>}
  </div>;
}

export function SessionActions({ session, busy = false, initialAction = 'menu', onClose, onUpdate, onDelete }: {
  session: Item; busy?: boolean; onClose: () => void;
  initialAction?: string;
  onUpdate: (patch: Item) => Promise<void>; onDelete: () => Promise<void>;
}) {
  const [action, setAction] = useState(initialAction);
  const [title, setTitle] = useState(session.title || ""), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const save = async (patch: Item) => {
    setSaving(true); setError("");
    try { await onUpdate(patch); onClose(); }
    catch (cause: any) { setError(cause.message); }
    finally { setSaving(false); }
  };
  return <Sheet title={action === 'rename' ? '改名' : action === 'delete' ? '删除对话？' : '对话'} onClose={() => { if (!saving) onClose(); }} onBack={action === 'menu' ? undefined : initialAction === 'menu' ? () => setAction('menu') : onClose}>
    {action === 'menu' && <div className="session-actions-list" role="menu" aria-label="管理对话">
      <button role="menuitem" onClick={() => setAction('rename')}>改名</button>
      <button role="menuitem" disabled={busy || saving} onClick={() => void save({ archived: !session.archived })}>{session.archived ? '恢复' : '归档'}</button>
      <button role="menuitem" className="danger" disabled={busy || saving} onClick={() => setAction('delete')}>删除</button>
    </div>}
    {action === 'rename' && <form className="settings-form" onSubmit={event => { event.preventDefault(); void save({ title: title.trim(), expectedTitleRevision: session.titleRevision }); }}>
      <label>对话名称<input autoFocus value={title} maxLength={120} onChange={event => setTitle(event.target.value)} required /></label>
      <button className="sheet-primary" disabled={saving || !title.trim()}>保存名称</button>
    </form>}
    {action === 'delete' && <><p>从所有客户端的列表中删除“{session.title || '新对话'}”。不会删除工作区文件；被控电脑保留私密恢复副本。</p><button className="sheet-primary" disabled={busy || saving} onClick={async () => { setSaving(true); setError(''); try { await onDelete(); onClose(); } catch (cause: any) { setError(cause.message); } finally { setSaving(false); } }}>确认删除</button></>}
    {busy && <p className="sheet-note">任务进行中，停止后可归档或删除。</p>}
    {error && <p className="sheet-error" role="alert">{error}</p>}
  </Sheet>;
}

export function SettingsRow({
  icon,
  title,
  detail,
  onClick,
  disabled = false,
}: {
  icon: IconName;
  title: string;
  detail?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Icon name={icon} />
      <span className="row-label">{title}</span>
      {detail && <span className="row-detail">{detail}</span>}
      {onClick && <Icon name="chevron" size={16} />}
    </>
  );
  return onClick ? (
    <button
      className="settings-row"
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {content}
    </button>
  ) : (
    <div className="settings-row">{content}</div>
  );
}

export function ConnectionLanding({
  gateway,
  notice,
  pairCode,
  setPairCode,
  pair,
  login,
  waiting,
  userCode,
}: {
  gateway: boolean;
  notice: string;
  pairCode: string;
  setPairCode: (value: string) => void;
  pair: () => void;
  login: () => void;
  waiting: boolean;
  userCode?: string;
}) {
  const [panel, setPanel] = useState("");
  return (
    <div className="connection-landing">
      <SessionHome
        onSelect={() => {}}
        onNew={() => setPanel("connect")}
        onConnect={() => setPanel("connect")}
        onSettings={() => setPanel("settings")}
      />
      {panel && (
        <Sheet
          title={panel === "settings" ? "远程控制" : "添加连接"}
          onClose={() => setPanel("")}
          onBack={panel === "connect" ? () => setPanel("settings") : undefined}
        >
          {panel === "settings" ? (
            <>
              <p className="group-label">账户与连接</p>
              <div className="settings-group">
                <SettingsRow
                  icon="account"
                  title="个人资料"
                  detail="未登录"
                  onClick={() => setPanel("connect")}
                />
                <SettingsRow
                  icon="plus"
                  title="添加连接"
                  onClick={() => setPanel("connect")}
                />
              </div>
              <p className="sheet-note centered">KK Code {APP_VERSION}</p>
            </>
          ) : (
            <>
              <div className="connection-story"><PixelBuddy /><div><b>连接你的工作台</b><small>熟悉的项目，随时接着写。</small></div></div>
              <div className="connection-steps" aria-label="连接步骤"><span className={!waiting ? "active" : ""}>01 · {gateway ? "组织登录" : "设备配对"}</span><span className={waiting ? "active" : ""}>02 · 确认连接</span><span>03 · 开始创作</span></div>
              <p className="sheet-note">
                {gateway
                  ? "由网关引导至组织登录。模型配置与文件保留在你的电脑。"
                  : "输入电脑终端显示的一次性配对码，连接当前设备。"}
              </p>
              {gateway ? (
                <button className="sheet-primary" onClick={login}>
                  {waiting ? "重新打开组织登录" : "继续组织登录"}
                </button>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    pair();
                  }}
                >
                  <label className="form-label">
                    配对码
                    <input
                      className="pair-input"
                      aria-label="配对码"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{8}"
                      maxLength={8}
                      value={pairCode}
                      onChange={(event) =>
                        setPairCode(event.target.value.replace(/\D/g, ""))
                      }
                      placeholder="8 位配对码"
                      required
                    />
                  </label>
                  <button
                    className="sheet-primary"
                    disabled={pairCode.length !== 8}
                  >
                    连接设备
                  </button>
                </form>
              )}
              {waiting && (
                <div className="sheet-note" role="status">
                  登录码：{userCode}。完成组织登录并批准连接后会自动继续。
                  {userCode && <p><a href={deviceLoginPath(userCode)} target="_blank" rel="noopener noreferrer">若登录页未打开，点击此处继续</a></p>}
                </div>
              )}
            </>
          )}
          {notice && (
            <p role="alert" className="sheet-error">
              {notice}
            </p>
          )}
        </Sheet>
      )}
    </div>
  );
}
