import React, { useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { SettingsRow } from "./Home";
import { Icon } from "./Icon";
import { AttachmentPanel, type Attachment } from "./Attachments";
import { BranchPanel } from "./Branches";
import { CommandOutput, PreferencesPanel, ThemePanel, DeviceLifecyclePanel } from "./ClientPanels";
import { MODE_OPTIONS, modeLabel } from "./modes.mjs";
import { APP_VERSION } from "./version";
import { ArtifactPanel } from './Artifacts';
import { MemoryPanel } from './Memory';
import { TaskPanel } from './Tasks';

type Item = Record<string, any>;
type Props = {
  initial: string;
  profile: Item;
  devices: Item[];
  deviceId: string;
  deviceName: string;
  connected: boolean;
  canManage?: boolean;
  gateway: boolean;
  cwd: string;
  mode: string;
  settings: Item;
  sessionId: string;
  sessions: Item[];
  commandResult: Item;
  theme: string;
  onTheme: (theme: string) => void;
  onCommand: (command: string) => Promise<any>;
  onSession: (id: string) => void;
  ensureSession: () => Promise<string>;
  onBranch: (snapshot: Item) => void;
  attachments: Attachment[];
  uploading: boolean;
  onUpload: (files: File[]) => Promise<void>;
  onRemoveAttachment: (id: string) => Promise<void>;
  rpc: (method: string, params?: Item) => Promise<any>;
  onClose: () => void;
  onCwd: (cwd: string) => void;
  onMode: (mode: string) => Promise<any>;
  onModel: (selection: { provider: string; model: string }) => Promise<any>;
  onDevice: (id: string) => void;
  onCreate: () => Promise<any>;
  onSettings: (config: Item) => void;
  onNotice: (notice: string) => void;
};
const titles: Record<string, string> = {
  settings: "设置",
  connections: "远程控制",
  profile: "个人资料",
  add: "添加连接",
  gateway: "连接其他网关",
  folders: "工作目录",
  models: "模型与渠道",
  provider: "添加渠道",
  extensions: "扩展",
  mode: "执行模式",
  new: "新对话",
  attachments: "消息附件",
  branches: "分支与 Worktree",
  command: "命令结果",
  preferences: "个人偏好",
  theme: "外观",
  sessions: "选择会话",
  lifecycle: "设备绑定与转移",
  artifacts: "会话产物与完整日志",
  memory: "记忆管理",
  tasks: "任务与验收",
};

export function SettingsOverlay(props: Props) {
  const [stack, setStack] = useState([props.initial === "permission" ? "mode" : props.initial === "keys" ? "settings" : props.initial]),
    panel = stack.at(-1)!;
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [folder, setFolder] = useState<Item | null>(null),
    [file, setFile] = useState<Item | null>(null);
  const [extensions, setExtensions] = useState<Item>({}),
    [gatewayUrl, setGatewayUrl] = useState("");
  const catalog = props.initial === "models" && props.commandResult.clientAction === "models" ? props.commandResult.catalog : null;
  const [models, setModels] = useState<Item[]>(catalog?.models || []), [modelProvider, setModelProvider] = useState(catalog ? props.commandResult.provider || '' : '');
  const providerArgs = String(props.commandResult.args || "").trim();
  const [editingProvider, setEditingProvider] = useState(props.initial === "provider" && (providerArgs === "edit" || providerArgs.startsWith("edit ")) ? providerArgs.slice(5).trim() || props.commandResult.provider || props.settings.provider?.default || "" : "");
  const [draft, setDraft] = useState({
    name: editingProvider,
    type: props.settings.provider?.[editingProvider]?.type || "openai",
    base_url: props.settings.provider?.[editingProvider]?.base_url || "",
    api_key: "",
    default_model: props.settings.provider?.[editingProvider]?.default_model || "",
  });
  const go = (name: string) => {
    setError("");
    setStack((old) => [...old, name]);
  };
  const editProvider = (name = "") => {
    const value = props.settings.provider?.[name] || {};
    setEditingProvider(name);
    setDraft({ name, type: value.type || "openai", base_url: value.base_url || "", api_key: "", default_model: value.default_model || "" });
    if (!name) setModels([]);
    go("provider");
  };
  const back = () => {
    setError("");
    if (stack.length > 1) setStack((old) => old.slice(0, -1));
    else props.onClose();
  };
  const run = async (fn: () => Promise<any>) => {
    setError("");
    setLoading(true);
    try {
      await fn();
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    if (panel === "folders") {
      setFile(null);
      void run(async () => {
        const result = await props.rpc("folders.list", {
          path: props.cwd || undefined,
        });
        if (!cancelled) setFolder(result);
      });
    }
    if (panel === "extensions")
      void run(async () => {
        const result = await props.rpc("extensions.list");
        if (!cancelled) setExtensions(result);
      });
    if (panel === "models")
      void run(async () => {
        const result = await props.rpc("settings.get");
        if (!cancelled) props.onSettings(result);
      });
    return () => {
      cancelled = true;
    };
  }, [panel]);
  const browse = (path: string) =>
    run(async () => {
      setFolder(await props.rpc("folders.list", { path }));
      setFile(null);
    });
  const logout = () =>
    run(async () => {
      const response = await fetch(
        props.gateway ? "/auth/logout" : "/api/v1/auth/logout",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) throw new Error("暂时无法退出，请重试");
      location.reload();
    });
  const account = (
    <div className="settings-group">
      <SettingsRow
        icon="account"
        title={props.profile.name || "个人资料"}
        detail={props.profile.organization}
        onClick={() => go("profile")}
      />
    </div>
  );
  const connectionList = (
    <>
      <p className="group-label">连接</p>
      <div className="settings-group">
        {props.gateway ? (
          props.devices.map((device) => (
            <div className="connection-row" key={device.id}>
              <Icon name="terminal" />
              <div>
                <b>{device.name}</b>
                <small>
                  <i className={device.online ? "online" : ""} />
                  {device.online ? "在线" : "离线"}
                </small>
              </div>
              <button
                className="switch"
                role="switch"
                aria-label={`连接 ${device.name}`}
                aria-checked={props.deviceId === device.id && props.connected}
                disabled={!device.online}
                onClick={() => {
                  props.onDevice(props.deviceId === device.id ? "" : device.id);
                }}
              >
                <span />
              </button>
            </div>
          ))
        ) : (
          <SettingsRow
            icon="terminal"
            title={props.deviceName}
            detail={props.connected ? "已配对 · 本机" : "连接中"}
          />
        )}
        {props.gateway && !props.devices.length && (
          <p className="sheet-note">
            还没有在线设备。在电脑运行 kkcode remote 后，它会出现在这里。
          </p>
        )}
        <SettingsRow icon="plus" title="添加连接" onClick={() => go("add")} />
      </div>
    </>
  );
  return (
    <Sheet
      title={panel === "provider" && editingProvider ? "编辑渠道" : titles[panel] || panel}
      onClose={props.onClose}
      onBack={stack.length > 1 ? back : undefined}
    >
      {props.canManage !== false && ['settings', 'models', 'provider', 'mode'].includes(panel) && props.settings._diagnostics?.errorCount > 0 && (
        <div className="error" role="alert" data-testid="configuration-diagnostics">
          <strong>{props.settings._diagnostics.toolsBlocked ? '权限配置需要修正，工具执行已暂停' : '电脑上的配置需要修正'}</strong>
          {(props.settings._diagnostics.errors || []).map((item: Item, index: number) => <p key={index}>{item.source}{item.field ? ` · ${item.field}` : ''}：{item.message}</p>)}
        </div>
      )}
      {props.canManage !== false && ['settings', 'models', 'provider'].includes(panel) && props.settings._diagnostics?.warningCount > 0 && <p role="status" className="hint">{props.settings._diagnostics.warning}</p>}
      {panel === 'artifacts' && <ArtifactPanel key={`${props.deviceId}:${props.sessionId}`} rpc={props.rpc} sessionId={props.sessionId} canManage={props.canManage !== false} />}
      {panel === 'memory' && props.canManage !== false && <MemoryPanel key={`${props.deviceId}:${props.sessionId}`} rpc={props.rpc} sessionId={props.sessionId} />}
      {panel === 'tasks' && <TaskPanel key={`${props.deviceId}:${props.sessionId}`} rpc={props.rpc} sessionId={props.sessionId} />}
      {["settings", "connections"].includes(panel) && (
        <>
          {account}
          {connectionList}
          {panel === "settings" && (
            <>
              <p className="group-label">工作区</p>
              <div className="settings-group">
                <SettingsRow icon="shield" title="任务与验收" disabled={!props.connected || !props.sessionId} onClick={() => go('tasks')} />
                <SettingsRow icon="attachment" title="会话产物与完整日志" disabled={!props.connected || !props.sessionId} onClick={() => go('artifacts')} />
                {props.canManage !== false && <SettingsRow icon="settings" title="记忆管理" disabled={!props.connected} onClick={() => go('memory')} />}
                <SettingsRow
                  icon="branch"
                  title="Git 分支"
                  disabled={!props.connected || props.canManage === false}
                  onClick={() => go("branches")}
                />
                <SettingsRow
                  icon="folder"
                  title="工作目录"
                  detail={props.cwd.split(/[\\/]/).at(-1)}
                  disabled={!props.connected || props.canManage === false}
                  onClick={() => go("folders")}
                />
                <SettingsRow
                  icon="settings"
                  title="模型与渠道"
                  disabled={!props.connected || props.canManage === false}
                  onClick={() => go("models")}
                />
                <SettingsRow
                  icon="extension"
                  title="MCP、Skills 与插件"
                  disabled={!props.connected || props.canManage === false}
                  onClick={() => go("extensions")}
                />
                <SettingsRow
                  icon="shield"
                  title="执行模式"
                  detail={modeLabel(props.mode)}
                  disabled={!props.connected || props.canManage === false}
                  onClick={() => go("mode")}
                />
                <SettingsRow icon="settings" title="外观" onClick={() => go("theme")} />
              </div>
            </>
          )}
          <p className="sheet-note centered">
            配置按需打开，启动时不会自动弹出。
            <br />
            KK Code {APP_VERSION}
          </p>
        </>
      )}
      {panel === "profile" && (
        <>
          <div className="profile-hero">
            <div>{(props.profile.name || "K")[0].toUpperCase()}</div>
            <h3>{props.profile.name}</h3>
            <p>{props.profile.organization}</p>
          </div>
          <p className="group-label">账户</p>
          <div className="settings-group">
            <SettingsRow
              icon="mail"
              title="电子邮件"
              detail={props.profile.email || "未提供"}
            />
            <SettingsRow
              icon="building"
              title="组织"
              detail={props.profile.organization || "个人设备"}
            />
            <SettingsRow
              icon="link"
              title="连接方式"
              detail={props.gateway ? "组织中继" : "本机配对"}
              onClick={() => go("connections")}
            />
          </div>
          <p className="group-label">设备配置</p>
          <div className="settings-group">
            <SettingsRow icon="account" title="个人偏好" disabled={!props.connected || props.canManage === false} onClick={() => go("preferences")} />
            <SettingsRow
              icon="settings"
              title="模型与渠道"
              disabled={!props.connected || props.canManage === false}
              onClick={() => go("models")}
            />
            <SettingsRow
              icon="extension"
              title="扩展"
              disabled={!props.connected || props.canManage === false}
              onClick={() => go("extensions")}
            />
            <SettingsRow icon="link" title="设备绑定与转移" disabled={props.canManage === false} onClick={() => go("lifecycle")} />
          </div>
          <button
            className="sheet-secondary danger"
            onClick={logout}
            disabled={loading}
          >
            <Icon name="logout" size={17} />
            {props.gateway ? "退出登录" : "断开配对"}
          </button>
        </>
      )}
      {panel === "add" && (
        <>
          {props.gateway && (
            <>
              <p className="sheet-note">
                在需要控制的电脑终端运行下方命令，完成组织登录后即可连接。退出终端会停止远程访问。
              </p>
              <pre className="command-example">
                kkcode remote --gateway {location.origin}
              </pre>
            </>
          )}
          {!props.gateway && (
            <p className="sheet-note">
              当前通过本机配对连接。若要跨网络访问，请使用你的组织中继网关。
            </p>
          )}
          <div className="settings-group">
            <SettingsRow
              icon="cloud"
              title="连接其他网关"
              detail="由网关引导组织登录"
              onClick={() => go("gateway")}
            />
          </div>
          <p className="sheet-note">
            SSH 连接可在 KK Code Android 客户端中添加。
          </p>
        </>
      )}
      {panel === "gateway" && (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const url = new URL(gatewayUrl);
              if (url.protocol !== "https:" || url.username || url.password)
                throw new Error("请输入不含用户名或密码的 HTTPS 网关地址");
              location.assign(url.origin);
            });
          }}
        >
          <p className="sheet-note">
            前往该网关后重新登录。当前电脑的配置不会被发送到新网关。
          </p>
          <label>
            网关地址
            <input
              required
              type="url"
              placeholder="https://remote.example.com"
              value={gatewayUrl}
              onChange={(event) => setGatewayUrl(event.target.value)}
            />
          </label>
          <button className="sheet-primary" disabled={loading}>
            前往网关
          </button>
        </form>
      )}
      {panel === "new" && (
        <>
          <div className="settings-group">
            <SettingsRow
              icon="terminal"
              title={props.deviceName}
              onClick={() => go("connections")}
            />
            <SettingsRow
              icon="folder"
              title="工作目录"
              detail={props.cwd.split(/[\\/]/).at(-1)}
              onClick={() => go("folders")}
            />
            <SettingsRow
              icon="shield"
              title="执行模式"
              detail={props.mode}
              onClick={() => go("mode")}
            />
            <SettingsRow icon="branch" title="Git 分支" disabled={!props.connected || props.canManage === false} onClick={() => go("branches")} />
          </div>
          <button
            className="sheet-primary"
            disabled={loading || !props.connected || props.canManage === false}
            onClick={() =>
              run(async () => {
                await props.onCreate();
                props.onClose();
              })
            }
          >
            开始对话
          </button>
        </>
      )}
      {panel === "folders" && folder && (
        <>
          <p className="sheet-note path">{folder.path}</p>
          <div className="folder-actions">
            <button
              onClick={() =>
                browse(folder.path.replace(/[\\/][^\\/]+$/, "") || folder.path)
              }
              disabled={loading}
            >
              上一级
            </button>
            <button
              className="sheet-primary"
              onClick={() => {
                props.onCwd(folder.path);
                stack.length > 1 ? back() : props.onClose();
              }}
            >
              选择此目录
            </button>
          </div>
          <div className="settings-group">
            {folder.entries.map((item: Item) => (
              <SettingsRow
                key={item.path}
                icon={item.directory ? "folder" : "message"}
                title={item.name}
                onClick={() =>
                  item.directory
                    ? browse(item.path)
                    : run(async () =>
                        setFile(
                          await props.rpc("files.read", { path: item.path }),
                        ),
                      )
                }
              />
            ))}
          </div>
          {file && (
            <details open>
              <summary>{file.path.split(/[\\/]/).at(-1)}</summary>
              <pre>{file.content}</pre>
            </details>
          )}
        </>
      )}
      {panel === "mode" && (
        <>
          <p className="sheet-note">
            模式同时决定执行方式和审批。Auto 使用当前对话模型审查敏感操作，审查失败或不确定时请你确认。Yolo 跳过常规确认；所有模式都遵守设备与组织的硬性安全边界。
          </p>
          <div className="settings-group">
            {MODE_OPTIONS.map((item: Item) => (
              <SettingsRow
                key={item.id}
                icon={props.mode === item.id ? "check" : "shield"}
                title={item.label || item.id}
                detail={item.desc}
                disabled={props.canManage === false || loading}
                onClick={() => void run(async () => {
                  await props.onMode(item.id);
                  stack.length > 1 ? back() : props.onClose();
                })}
              />
            ))}
          </div>
        </>
      )}
      {panel === "models" && (
        <>
          <p className="group-label">已配置渠道</p>
          <div className="settings-group">
            {Object.entries(props.settings.provider || {})
              .filter(
                ([name, value]) =>
                  !["default", "model_context", "model_thinking", "model_capabilities"].includes(name) && value !== null && typeof value === "object" && !Array.isArray(value),
              )
              .map(([name, value]: any) => (
                <SettingsRow
                  key={name}
                  icon="cloud"
                  title={name}
                  detail={value.default_model}
                  onClick={() => run(async () => { setModelProvider(name); setModels([]); const catalog = await props.rpc('models.discover', { provider: name }); setModels(catalog.models || []); })}
                />
              ))}
            <SettingsRow
              icon="plus"
              title="添加渠道"
              onClick={() => editProvider()}
            />
          </div>
          {modelProvider && <><p className="group-label">{modelProvider} · 模型目录</p><div className="settings-group">{models.map(model => <SettingsRow key={model.id} icon="cloud" title={model.id} onClick={() => run(async () => { await props.onModel({ provider: modelProvider, model: model.id }); props.onNotice('模型已切换'); props.onClose(); })} />)}</div>{!models.length && <p className="sheet-note">此渠道尚未返回模型列表，可在添加渠道时手动指定。</p>}</>}
          {modelProvider && <button className="sheet-secondary" disabled={loading} onClick={() => editProvider(modelProvider)}>编辑 {modelProvider} 渠道</button>}
          <p className="sheet-note">
            API Key 不在列表中展示。模型配置保存在连接的电脑上。
          </p>
        </>
      )}
      {panel === "provider" && (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const config = {
                provider: {
                  default: editingProvider ? props.settings.provider?.default || draft.name : draft.name,
                  [draft.name]: {
                    type: draft.type,
                    base_url: draft.base_url,
                    ...(!editingProvider || draft.api_key ? { api_key: draft.api_key } : {}),
                    ...(!editingProvider ? { api_key_env: '' } : {}),
                    default_model: draft.default_model,
                  },
                },
              };
              await props.rpc("settings.update", { config });
              setDraft({ ...draft, api_key: "" });
              props.onSettings(await props.rpc("settings.get"));
              props.onNotice("渠道已保存并立即生效");
              back();
            });
          }}
        >
          <label>
            渠道名称
            <input
              required
              value={draft.name}
              readOnly={Boolean(editingProvider)}
              pattern="[A-Za-z0-9_-]+"
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label>
            协议
            <select
              value={draft.type}
              onChange={(event) =>
                setDraft({ ...draft, type: event.target.value })
              }
            >
              <option value="openai">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses API</option>
              <option value="anthropic">Anthropic 兼容</option>
            </select>
          </label>
          <label>
            Base URL
            <input
              required
              type="url"
              value={draft.base_url}
              placeholder="https://api.example.com/v1"
              onChange={(event) =>
                setDraft({ ...draft, base_url: event.target.value })
              }
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              placeholder={editingProvider ? "留空保留现有密钥" : undefined}
              value={draft.api_key}
              onChange={(event) =>
                setDraft({ ...draft, api_key: event.target.value })
              }
            />
          </label>
          <label>
            模型
            <input
              list="discovered-models"
              required
              value={draft.default_model}
              onChange={(event) =>
                setDraft({ ...draft, default_model: event.target.value })
              }
            />
            <datalist id="discovered-models">{models.map(model => <option key={model.id} value={model.id} />)}</datalist>
          </label>
          <button className="sheet-secondary" type="button" disabled={loading || !draft.base_url} onClick={() => run(async () => { const { name, ...connection } = draft; const saved = props.settings.provider?.[editingProvider]; const params = editingProvider && !draft.api_key && saved?.type === draft.type && saved?.base_url === draft.base_url ? { provider: editingProvider } : { connection }; const result = await props.rpc('models.discover', params); setModels(result.models || []); if (!draft.default_model && result.models?.length) setDraft({ ...draft, default_model: result.models[0].id }); props.onNotice(`已从 Base URL 读取 ${result.models?.length || 0} 个模型`); })}>读取模型列表</button>
          <button className="sheet-primary" disabled={loading}>
            {loading ? "保存中…" : "保存渠道"}
          </button>
        </form>
      )}
      {panel === "extensions" && (
        <>
          <button
            className="sheet-secondary"
            disabled={loading}
            onClick={() =>
              run(async () =>
                setExtensions(await props.rpc("extensions.reload")),
              )
            }
          >
            重新加载
          </button>
          {["skills", "plugins", "mcp"].map((kind) => (
            <div key={kind}>
              <p className="group-label">{kind}</p>
              <div className="settings-group">
                {(Array.isArray(extensions[kind]) ? extensions[kind] : []).map(
                  (item: Item, index: number) => (
                    <details className="extension-detail" key={index}>
                      <summary>{item.name || item.server}</summary>
                      <p>{item.description || item.error || "可用"}</p>
                    </details>
                  ),
                )}
                {!extensions[kind]?.length && (
                  <p className="sheet-note">暂无条目</p>
                )}
              </div>
            </div>
          ))}
        </>
      )}
      {panel === "attachments" && props.canManage !== false && <AttachmentPanel items={props.attachments} loading={props.uploading} onUpload={props.onUpload} onRemove={props.onRemoveAttachment} />}
      {panel === "branches" && props.canManage !== false && <BranchPanel rpc={props.rpc} sessionId={props.sessionId} cwd={props.cwd} ensureSession={props.ensureSession} onChanged={props.onBranch} onOpened={props.onSession} />}
      {panel === "lifecycle" && props.canManage !== false && <DeviceLifecyclePanel deviceId={props.deviceId} gateway={props.gateway} name={props.deviceName} />}
      {panel === "command" && <CommandOutput result={props.commandResult} />}
      {panel === "theme" && <ThemePanel theme={props.theme} onTheme={props.onTheme} />}
      {panel === "preferences" && props.canManage !== false && <PreferencesPanel rpc={props.rpc} onSaved={() => { props.onNotice("个人偏好已保存"); stack.length > 1 ? back() : props.onClose(); }} />}
      {panel === "sessions" && <div className="settings-group">{(props.commandResult.items || props.sessions).map((item: Item) => <SettingsRow key={item.id} icon={props.sessionId === item.id ? "check" : "message"} title={item.label || item.title || item.id} detail={item.desc || item.cwd} onClick={() => props.onSession(item.id)} />)}</div>}
      {loading && (
        <p className="sheet-note" role="status">
          正在加载…
        </p>
      )}
      {error && (
        <p className="sheet-error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
