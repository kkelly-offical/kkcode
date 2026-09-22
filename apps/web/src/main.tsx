import React, { useState, useEffect, useRef, useMemo } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./mobile.css";
import { SessionHome, ConnectionLanding } from "./Home";
import { SettingsOverlay } from "./Settings";
import { Icon } from "./Icon";
import { TranscriptRow } from "./TranscriptView";
import { Composer } from "./Composer";
import { buildTranscript, changeSummary } from "./transcript.mjs";
import { eventsStreamPath, streamSessionEvents } from "./live.mjs";
import { DeviceClient } from "../../../src/sdk/client.mjs";
import { deviceLoginPath } from "../../../src/protocol/login-path.mjs";
import { useDeviceEvents } from './DeviceEvents';
import { mcpLoadNotice } from './device-notices.mjs';
import { Approval } from "./Approval";
import { attachmentMediaType, readAttachment, type Attachment } from "./Attachments";

type Item = Record<string, any>;
function App() {
  const [small, setSmall] = useState(window.innerWidth <= 760);
  useEffect(() => {
    const resize = () => setSmall(window.innerWidth <= 760);
    window.addEventListener("resize", resize);
    resize();
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [ready, setReady] = useState(false),
    [gateway, setGateway] = useState(false);
  const [pairCode, setPairCode] = useState(""),
    [loginFlow, setLoginFlow] = useState<Item | null>(null);
  const [profile, setProfile] = useState<Item>({
    name: "Local workspace",
    organization: "Personal",
  });
  const [devices, setDevices] = useState<Item[]>([]),
    [deviceId, setDeviceId] = useState("");
  const [sessions, setSessions] = useState<Item[]>([]),
    [selected, setSelected] = useState("");
  const [session, setSession] = useState<Item | null>(null),
    [events, setEvents] = useState<Item[]>([]);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState("agent"),
    [model, setModel] = useState(""),
    [provider, setProvider] = useState(""),
    [permission, setPermission] = useState("");
  const [control, setControl] = useState<Item | null>(null);
  const [draftAttachments, setDraftAttachments] = useState<Record<string, Attachment[]>>({});
  const [uploading, setUploading] = useState(false), [branch, setBranch] = useState("");
  const [commandResult, setCommandResult] = useState<Item>({});
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("kkcode.web.theme") || "dark"; } catch { return "dark"; } });
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState(""),
    [cwd, setCwd] = useState("");
  const [settings, setSettings] = useState<Item>({});
  const [commands, setCommands] = useState<Item[]>([]),
    [approval, setApproval] = useState<Item[]>([]);
  const tail = useRef<HTMLDivElement>(null),
    cursor = useRef(0);
  const manuallyDisconnected = useRef(false);
  const livePreviewNotice = useRef(""), livePreviewLimited = useRef(false);
  const attachmentKey = `${deviceId}:${selected}`;
  const attachments = draftAttachments[attachmentKey] || [];
  const sdk = useMemo(() => new DeviceClient({ url: location.origin, gateway, deviceId: gateway ? deviceId || null : null }), [gateway, deviceId]);
  async function rpc(method: string, params: Item = {}) {
    return sdk.request<any>(method, params);
  }
  const deviceNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(deviceNoticeTimer.current), []);
  useDeviceEvents({ enabled: ready, gateway, deviceId, onEvent: async (event, signal) => {
    const message = mcpLoadNotice(event);
    if (message) {
      setNotice(message); clearTimeout(deviceNoticeTimer.current);
      deviceNoticeTimer.current = setTimeout(() => setNotice(previous => previous === message ? '' : previous), 6500);
    }
    if (['settings.updated', 'models.updated'].includes(event.type)) { const value = await rpc('settings.get'); if (!signal.aborted) setSettings(value); }
    if (event.type === 'session.status') { const result = await rpc('sessions.list'); if (!signal.aborted) setSessions(Array.isArray(result) ? result : result.sessions || []); }
  } });
  function applySelection(value: Item) {
    if (value.model !== undefined) setModel(value.model);
    if (value.providerType) setProvider(value.providerType);
    if (value.modeId) setMode(value.modeId);
    if (value.approval) setPermission(value.approval);
  }
  function applyLiveSnapshot(value: Item | null) {
    setEvents(value?.liveEvents || []);
    livePreviewLimited.current = Boolean(value?.liveTruncated && value?.running);
    if (!value?.liveTruncated) { livePreviewNotice.current = ""; return false; }
    const key = `${deviceId}:${value.id || selected}`;
    if (livePreviewNotice.current !== key) {
      livePreviewNotice.current = key;
      setNotice("当前是受容量限制的部分预览；任务完成后会同步会话记录，完整回复仍保存在设备上。");
    }
    return true;
  }
  async function selectModel(selection: Item) {
    if (!selected) { applySelection({ ...selection, providerType: selection.provider, modeId: selection.mode }); return; }
    await rpc('control.acquire', { sessionId: selected });
    try { applySelection(await rpc('sessions.configure', { sessionId: selected, ...selection })); }
    finally { await rpc('control.release', { sessionId: selected }).catch(() => {}); }
  }
  const attempt = async (fn: () => Promise<any>) => {
    try {
      return await fn();
    } catch (e: any) {
      setNotice(e.message);
    }
  };
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "auto" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document
        .querySelectorAll('meta[name="theme-color"]')
        .forEach((tag) =>
          tag.setAttribute("content", resolved === "dark" ? "#0e100f" : "#faf9f6"),
        );
    };
    apply(); media.addEventListener("change", apply);
    try { localStorage.setItem("kkcode.web.theme", theme); } catch { /* Private browsing may disable storage. */ }
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    if (!loginFlow) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    let interval = Math.max(5, loginFlow.interval || 5) * 1000;
    const expires = Date.now() + (loginFlow.expires_in || 600) * 1000;
    const poll = async () => {
      try {
        if (Date.now() >= expires) throw new Error("登录请求已过期，请重新登录");
        const response = await fetch("/auth/token", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_code: loginFlow.device_code, browser: true }) });
        const result = await response.json();
        if (stopped) return;
        if (response.ok && result.authenticated) { setProfile(result.profile); setLoginFlow(null); setReady(true); return; }
        if (result.error === "slow_down") interval += 5000;
        else if (result.error !== "authorization_pending") throw new Error("登录请求未完成或已过期，请重新登录");
      } catch (cause: any) {
        if (!stopped) { setNotice(cause.message); setLoginFlow(null); }
        return;
      }
      if (!stopped) timer = setTimeout(poll, interval);
    };
    timer = setTimeout(poll, interval);
    return () => { stopped = true; clearTimeout(timer); };
  }, [loginFlow]);
  async function refreshSessions() {
    const result = await rpc("sessions.list");
    setSessions(Array.isArray(result) ? result : result.sessions || []);
  }
  useEffect(() => {
    void (async () => {
      try {
        const discovery = await fetch("/api/v1/discovery");
        if (
          discovery.ok &&
          discovery.headers.get("content-type")?.includes("json")
        ) {
          setGateway(true);
          const p = await new DeviceClient({ url: location.origin, gateway: true }).profile<Item>().catch(() => null);
          if (p) {
            setProfile(p);
            setReady(true);
          }
          return;
        }
        const bootstrap = new URLSearchParams(location.hash.slice(1)).get(
          "bootstrap",
        );
        if (bootstrap) {
          history.replaceState(null, "", location.pathname);
          await fetch("/api/v1/auth/pair", {
              method: "POST",
              redirect: "error",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bootstrap }),
          });
        }
        const status = await rpc("status");
        setProfile(
          status.device.profile || {
            name: status.device.name,
            organization: "Local device",
          },
        );
        setCwd(status.roots[0]);
        setReady(true);
      } catch {
        setReady(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (!ready) return;
    if (gateway) {
      let stopped = false;
      const refresh = async () => { await attempt(async () => {
        const d = await sdk.listDevices<Item[]>();
        if (stopped) return;
        setDevices(d);
        setDeviceId(previous => {
          if (previous && !d.some(device => device.id === previous)) { setSelected(""); setSessions([]); setSession(null); setEvents([]); setNotice("设备权限已变更，请重新选择设备"); return ""; }
          return previous || (manuallyDisconnected.current ? '' : d.find(device => device.online)?.id || '');
        });
      }); };
      void refresh(); const timer = setInterval(refresh, 10000);
      return () => { stopped = true; clearInterval(timer); };
    }
  }, [ready, gateway]);
  useEffect(() => {
    if (!ready || (gateway && !deviceId)) return;
    let cancelled = false;
    void attempt(async () => {
      const result = await rpc("sessions.list");
      if (cancelled) return;
      setSessions(Array.isArray(result) ? result : result.sessions || []);
      const s = await rpc("status");
      if (cancelled) return;
      setCwd(s.roots[0] || '');
      const availableCommands = await rpc("commands.list");
      const config = s.shared ? {} : await rpc("settings.get");
      if (cancelled) return;
      setCommands(availableCommands); setSettings(config);
    });
    return () => { cancelled = true; };
  }, [ready, deviceId]);
  useEffect(() => {
    setEvents([]);
    setApproval([]);
    setSession(null);
    setBusy(false);
    setControl(null);
    setBranch("");
    if (!selected || !ready) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const syncSnapshot = async () => {
      const snapshot = await rpc("sessions.get", { sessionId: selected });
      if (cancelled) return;
      cursor.current = snapshot?.eventCursor || cursor.current;
      setSession(current => {
        if (!current || current.id !== snapshot?.id) return snapshot;
        const unique = (items: Item[]) => [...new Map(items.map(item => [item.id, item])).values()];
        return { ...snapshot, messages: unique([...(current.messages || []), ...(snapshot.messages || [])]), parts: unique([...(current.parts || []), ...(snapshot.parts || [])]), historyHasMore: current.historyHasMore, nextBefore: current.nextBefore };
      });
      applyLiveSnapshot(snapshot);
    };
    const watchError = (error: any) => {
      if (cancelled) return false;
      setNotice(error.message);
      if ([401, 403, 404].includes(error.status)) { setSelected(""); setSession(null); setEvents([]); setApproval([]); cancelled = true; }
      return true;
    };
    // One application path for both transports: SSE frames and events.list
    // batches carry the same event objects (M26 contract).
    const applyBatch = async (batch: Item) => {
      if (cancelled) return;
      if (batch.gap) {
        const snapshot = await rpc("sessions.get", { sessionId: selected });
        if (cancelled) return;
        cursor.current = snapshot?.eventCursor || batch.cursor || 0;
        setSession(snapshot); const limited = applyLiveSnapshot(snapshot); applySelection(snapshot || {});
        if (batch.approvals !== undefined) setApproval(batch.approvals || []);
        if (batch.running !== undefined) setBusy(Boolean(batch.running));
        if (batch.control !== undefined) setControl(batch.control || null);
        if (!limited) setNotice("实时记录已归档，已重新同步会话快照；较早消息可按需加载");
        return;
      }
      const fresh = (batch.events || []).filter((event: Item) => typeof event.seq !== "number" || event.seq > cursor.current);
      if (fresh.length) {
        cursor.current = fresh.at(-1).seq ?? cursor.current;
        setEvents((old) => [...old, ...fresh]);
        for (const event of fresh) {
          if (event.type === "turn.start") setBusy(true);
          if (
            ["turn.result", "turn.failed", "turn.finish"].includes(event.type)
          )
            setBusy(false);
        }
        if (
          fresh.some((event: Item) =>
            ["turn.result", "turn.failed"].includes(event.type),
          )
        )
          await refreshSessions();
      }
      if (batch.approvals !== undefined) setApproval(batch.approvals || []);
      if (batch.running !== undefined) setBusy(Boolean(batch.running));
      if (batch.control !== undefined) setControl(batch.control || null);
      for (const event of fresh) {
        if (event.type === 'provider.capability.notice' && event.payload?.message) {
          const message = event.payload.message; setNotice(message);
          clearTimeout(deviceNoticeTimer.current);
          deviceNoticeTimer.current = setTimeout(() => setNotice(previous => previous === message ? '' : previous), 6500);
        }
        if (event.type === 'session.configured') applySelection(event.payload);
        if (event.type === 'session.branch.changed') setBranch(event.payload.branch || '');
      }
      const turnEnded = fresh.some((event: Item) => ["turn.result", "turn.failed"].includes(event.type));
      const stopped = batch.running === false || turnEnded;
      if (stopped && (livePreviewLimited.current || turnEnded || (fresh.length && cursor.current % 1000 < fresh.length)))
        await syncSnapshot();
      // SSE delivers approval bodies as approval.* rows without the envelope's
      // approvals array; one events.list refresh keeps that array authoritative.
      if (!cancelled && fresh.some((event: Item) => String(event.type).startsWith("approval.")))
        await applyBatch(await rpc("events.list", { sessionId: selected, after: cursor.current }));
    };
    const poll = async () => {
      try {
        await applyBatch(await rpc("events.list", {
          sessionId: selected,
          after: cursor.current,
        }));
      } catch (error: any) {
        watchError(error);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    };
    const stream = async () => {
      let failures = 0;
      while (!cancelled) {
        const started = Date.now();
        try {
          await streamSessionEvents({
            url: eventsStreamPath({ gateway, deviceId, sessionId: selected, after: cursor.current }),
            signal: controller.signal,
            onEvent: (event: Item) => applyBatch({ events: [event] }).catch(watchError),
            onMeta: (meta: Item) => applyBatch(meta).catch(watchError),
            onGap: (gap: Item) => applyBatch({ gap: true, cursor: gap?.cursor }).catch(watchError),
          });
        } catch (error: any) {
          if (cancelled || controller.signal.aborted) return;
          // Devices before M26 answer 404/HTML here; polling is their transport.
          if (error.code === "stream_unavailable") break;
          if ([401, 403, 404].includes(error.status)) { watchError(error); return; }
        }
        if (cancelled) break;
        // A long-lived connection that drops resets the backoff budget.
        failures = Date.now() - started > 10000 ? 1 : failures + 1;
        if (failures > 3) {
          setNotice("实时推送连接不稳定，已回退到轮询刷新");
          break;
        }
        await pause(800 * failures);
      }
      if (!cancelled) await poll();
    };
    void attempt(async () => {
      const snapshot = await rpc("sessions.get", { sessionId: selected });
      if (cancelled) return;
      cursor.current = snapshot?.eventCursor || 0;
      setSession(snapshot);
      applyLiveSnapshot(snapshot);
      if (snapshot) { applySelection(snapshot); setCwd(snapshot.cwd || cwd); }
      setBusy(Boolean(snapshot?.running));
      await stream();
    });
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [selected, deviceId, ready, sessionRevision]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  async function createSession(): Promise<string> {
    const result = await rpc("sessions.create", { cwd });
    if (settings.provider?.default) {
      await rpc("control.acquire", { sessionId: result.id });
      try { await rpc("sessions.configure", { sessionId: result.id, mode, model: model || undefined, provider: provider || undefined, approval: permission || undefined }); }
      finally { await rpc("control.release", { sessionId: result.id }).catch(() => {}); }
    }
    await refreshSessions();
    setSelected(result.id);
    setSidebar(false);
    return result.id;
  }
  async function loadEarlierMessages() {
    if (!selected || !session?.historyHasMore || loadingHistory) return;
    const id = selected;
    setLoadingHistory(true);
    try {
      const earlier = await rpc("sessions.get", { sessionId: id, before: session.nextBefore, limit: 100 });
      setSession(current => {
        if (current?.id !== id) return current;
        const unique = (items: Item[]) => [...new Map(items.map(item => [item.id, item])).values()];
        return { ...current, messages: unique([...(earlier.messages || []), ...(current.messages || [])]), parts: unique([...(earlier.parts || []), ...(current.parts || [])]), historyHasMore: earlier.historyHasMore, nextBefore: earlier.nextBefore };
      });
    } catch (cause: any) { setNotice(cause.message); }
    finally { setLoadingHistory(false); }
  }
  async function ensureSession(): Promise<string> { return selected || await createSession(); }
  async function uploadAttachments(files: File[]) {
    if (!canManage || uploading) return;
    if (files.length + attachments.length > 8) throw new Error("每条消息最多添加 8 个附件");
    for (const file of files) {
      const mediaType = attachmentMediaType(file), limit = /^(image|audio|video)\//.test(mediaType) ? 4 * 1024 * 1024 : 256 * 1024;
      if (file.size > limit) throw new Error(`${file.name} 超过单个附件大小限制`);
    }
    setUploading(true);
    try {
      const id = await ensureSession(), key = `${deviceId}:${id}`;
      for (const file of files) {
        const attachment = await rpc("attachments.upload", { sessionId: id, name: file.name, mediaType: attachmentMediaType(file), data: await readAttachment(file) });
        setDraftAttachments(old => ({ ...old, [key]: [...(old[key] || []), attachment] }));
      }
    } finally { setUploading(false); }
  }
  async function removeAttachment(id: string) {
    await rpc("attachments.remove", { sessionId: selected, id });
    setDraftAttachments(old => ({ ...old, [attachmentKey]: (old[attachmentKey] || []).filter(item => item.id !== id) }));
  }
  async function runCommand(text: string, id = selected) {
    const sessionId = id || await ensureSession();
    await rpc("control.acquire", { sessionId });
    let accepted = false;
    try {
      const result = await rpc("commands.run", { sessionId, command: text });
      accepted = Boolean(result?.accepted);
      applySelection(result?.state || result || {});
      setCommandResult({ ...result, command: text });
      const action = result?.clientAction;
      if (action === "clear") { setSession(old => ({ ...old, messages: [], parts: [] })); setEvents([]); setNotice("已清空当前显示；历史记录仍保留"); }
      else if (["exit", "home"].includes(action)) {
        setSelected(""); setSession(null); setEvents([]); setPanel("");
        if (action === "exit") {
          manuallyDisconnected.current = true; setDeviceId(""); setSessions([]); setSettings({}); setCommands([]);
          if (!gateway) {
            const response = await fetch("/api/v1/auth/logout", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: "{}" });
            if (!response.ok) throw new Error("退出配对失败，请重试");
            setReady(false);
          }
          setNotice("已断开此客户端，设备终端仍保持运行");
        }
      } else if (action === "session") {
        setSelected(result.sessionId || result.state?.sessionId || "");
        if (result.cwd) setCwd(result.cwd);
        if (result.draft !== undefined) setPrompt(result.draft);
        setSessionRevision(value => value + 1);
        await refreshSessions(); setPanel("");
      } else if (action === "theme") {
        const value = String(result.args || "").trim();
        if (["dark", "light", "auto"].includes(value)) { setTheme(value); setNotice("外观已更新"); }
        else setPanel("theme");
      } else if (action === "paste") { if (result.args) setPrompt(String(result.args)); setPanel("attachments"); }
      else if (action === "like") setPanel("preferences");
      else if (action === "profile") setPanel(result.args?.trim() === "edit" ? "preferences" : "profile");
      else if (action === "provider") setPanel(String(result.args || "").trim() ? "provider" : "models");
      else if (action && ["models", "mode", "permission", "keys", "sessions", "extensions"].includes(action)) setPanel(action);
      else if (result?.panels?.length || result?.output?.length || (!action && !accepted)) setPanel("command");
      if (accepted) setBusy(true);
      return result;
    } finally { if (!accepted) await rpc("control.release", { sessionId }).catch(() => {}); }
  }
  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!prompt.trim() || busy || uploading || readOnly) return;
    await attempt(async () => {
      let id = selected;
      if (!id) {
        id = await createSession();
      }
      const text = prompt;
      if (text.startsWith("/")) {
        if (attachments.length) throw new Error("附件不能附加到 / 命令，请先发送普通消息或移除附件");
        setPrompt("");
        try { await runCommand(text, id); } catch (error) { setPrompt(text); throw error; }
        return;
      }
      await rpc("control.acquire", { sessionId: id });
      try { await rpc("turns.start", {
        sessionId: id,
        prompt: text,
        attachmentIds: attachments.map(item => item.id),
      }); } catch (error) { await rpc("control.release", { sessionId: id }).catch(() => {}); throw error; }
      setPrompt(""); setDraftAttachments(old => ({ ...old, [attachmentKey]: [] }));
      setBusy(true);
      setTimeout(
        () => tail.current?.scrollIntoView({ behavior: "smooth" }),
        50,
      );
    });
  }
  async function openFolders() {
    setPanel("folders");
  }
  async function openSettings() {
    setPanel("settings");
  }
  const connected =
    ready &&
    (!gateway ||
      devices.some((device) => device.id === deviceId && device.online));
  const deviceName = gateway
    ? devices.find((device) => device.id === deviceId)?.name || "未连接设备"
    : profile.name;
  const activeDevice = devices.find(device => device.id === deviceId);
  const canManage = !gateway || Boolean(activeDevice && !activeDevice.shared);
  const readOnly = !connected || Boolean(activeDevice?.shared && activeDevice.permissions?.[selected] !== 'control');
  const messages: Item[] = buildTranscript(session || {}, events);
  if (!ready)
    return (
      <ConnectionLanding
        gateway={gateway}
        notice={notice}
        pairCode={pairCode}
        setPairCode={setPairCode}
        waiting={Boolean(loginFlow)}
        userCode={loginFlow?.user_code}
        pair={() =>
          attempt(async () => {
            if (loginFlow) { window.open(deviceLoginPath(loginFlow.user_code), "_blank", "noopener"); return; }
            const r = await fetch("/api/v1/auth/pair", {
              method: "POST",
              redirect: "error",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: pairCode }),
            });
            if (!r.ok) throw new Error("配对码错误或已过期");
            location.reload();
          })
        }
        login={() =>
          attempt(async () => {
            const r = await fetch("/auth/device", {
              method: "POST",
              redirect: "error",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind: "client", name: "Web browser" }),
            });
            if (!r.ok) throw new Error("暂时无法开始登录，请稍后重试");
            const flow = await r.json();
            const loginPath = deviceLoginPath(flow.user_code);
            setLoginFlow(flow);
            window.open(loginPath, "_blank", "noopener");
          })
        }
      />
    );
  const mobileHome = small && !selected;
  return (
    <div className="app">
      <aside
        className={sidebar ? "sidebar open" : "sidebar"}
        aria-label="工作区导航"
      >
        <div className="brand">
          <div className="wordmark">
            KK<span>Code</span>
          </div>
          <button className="icon mobile" onClick={() => setSidebar(false)}>
            ×
          </button>
        </div>
        <button className="new" disabled={!connected || !canManage || uploading} onClick={() => setPanel("new")}>
          ＋ 新对话
        </button>
        <div className="section-label">工作设备</div>
        {gateway ? (
          <select
            aria-label="设备"
            value={deviceId}
            disabled={uploading}
            onChange={(e) => {
              setDeviceId(e.target.value);
              setSelected("");
              setProvider(""); setModel(""); setMode("agent"); setPermission("");
            }}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.online ? "●" : "○"} {d.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="device">
            <i />
            {profile.name}
            <span>本机</span>
          </div>
        )}
        <button
          className="workspace"
          disabled={!connected || !canManage}
          onClick={() => attempt(() => openFolders())}
        >
          ▱ {cwd.split(/[\\/]/).at(-1) || "选择工作目录"} <span>⌄</span>
        </button>
        <div className="section-label">
          对话记录 <span>{sessions.length}</span>
        </div>
        <nav>
          {sessions.map((s) => (
            <button
              className={selected === s.id ? "session active" : "session"}
              key={s.id}
              onClick={() => {
                setSelected(s.id);
                setSidebar(false);
              }}
            >
              {s.title || s.id}
            </button>
          ))}
        </nav>
        <button
          className="profile"
          aria-label="个人与设备设置"
          onClick={() => attempt(openSettings)}
        >
          <b>{(profile.name || "K")[0].toUpperCase()}</b>
          <div>
            {profile.name}
            <small>{profile.organization} · 已连接</small>
          </div>
          <span>⚙</span>
        </button>
      </aside>
      <main>
        {mobileHome ? (
          <SessionHome
            sessions={sessions}
            name={deviceName}
            connected={connected}
            onSelect={(s) => setSelected(s.id)}
            onNew={() => setPanel(connected && canManage ? "new" : "connections")}
            onSettings={() => attempt(openSettings)}
            onConnect={() => setPanel("connections")}
          />
        ) : (
          <>
            <header>
              <button
                className="round mobile chat-back"
                aria-label="返回会话列表"
                onClick={() => {
                  setSelected("");
                  setSession(null);
                  setEvents([]);
                }}
              >
                <Icon name="back" />
              </button>
              <div className="chat-title">
                <strong>
                  {sessions.find((item) => item.id === selected)?.title ||
                    session?.title ||
                    "新对话"}
                </strong>
                <button onClick={() => setPanel("connections")}>
                  {cwd.split(/[\\/]/).at(-1)} · {deviceName}
                </button>
              </div>
              <div className="chat-header-actions">
                <button
                  className="icon"
                  aria-label="新对话"
                  disabled={!connected || !canManage || uploading}
                  onClick={() => setPanel("new")}
                >
                  <Icon name="chat" size={20} />
                </button>
                <button
                  className="icon"
                  aria-label="对话设置"
                  onClick={() => setPanel("settings")}
                >
                  <Icon name="more" size={20} />
                </button>
              </div>
            </header>
            <div className="transcript">
              {session?.historyHasMore && <button className="load-history" disabled={loadingHistory} onClick={() => void loadEarlierMessages()}>{loadingHistory ? "正在加载…" : "加载更早消息"}</button>}
              {!messages.length && (
                <div className="empty">
                  <div className="spark">✳</div>
                  <h1>今天想构建什么？</h1>
                  <p>连接你的工作区，把想法变成可验证的结果。</p>
                  <div className="suggestions">
                    {[
                      "了解这个项目",
                      "帮我审查最近的修改",
                      "制定一个开发计划",
                    ].map((s) => (
                      <button key={s} onClick={() => setPrompt(s)}>
                        {s} ↗
                      </button>
                    ))}
                  </div>
                  {canManage && !settings.provider?.default && (
                    <button
                      className="setup"
                      onClick={() => attempt(openSettings)}
                    >
                      先配置一个模型渠道 →
                    </button>
                  )}
                </div>
              )}
              {messages.map((row) => (
                <TranscriptRow key={row.id} row={row} />
              ))}
              {busy &&
                !messages.some(
                  (row) => row.type === "thinking" && !row.done,
                ) && (
                  <div className="thinking">
                    <i />
                    Thinking…
                  </div>
                )}
              {approval.map(request => <Approval key={request.id} request={request} readOnly={readOnly} onResolve={answer => rpc('approvals.resolve', { id: request.id, sessionId: request.sessionId || selected, answer })} />)}
              <div ref={tail} />
            </div>
            {control && !control.yours && <div className="control-notice">另一客户端正在控制此会话。{canManage && <button onClick={() => attempt(async () => { await rpc('control.acquire', { sessionId: selected, takeover: true }); setControl({ yours: true }); })}>接管控制</button>}</div>}
            <Composer
              readOnly={readOnly}
              canManage={canManage}
              prompt={prompt}
              onPrompt={setPrompt}
              busy={busy}
              mode={mode}
              permission={permission}
              modes={commandResult.clientAction === "mode" && commandResult.items?.length ? commandResult.items : undefined}
              model={model}
              provider={provider}
              settings={settings}
              uploading={uploading}
              attachments={attachments}
              branch={branch}
              commands={commands}
              onSend={() => void send()}
              onStop={() =>
                void attempt(async () => {
                  await rpc("control.acquire", { sessionId: selected });
                  await rpc("turns.cancel", { sessionId: selected });
                })
              }
              onMode={(value) =>
                void attempt(async () => {
                  await selectModel({ mode: value });
                  setNotice(`执行模式已切换为 ${value}`);
                })
              }
              onPermission={(value) =>
                void attempt(async () => {
                  await selectModel({ approval: value });
                  setNotice("操作权限已更新");
                })
              }
              onModel={(selection) =>
                void attempt(async () => {
                  await selectModel(selection);
                  setNotice(`模型已切换为 ${selection.model}`);
                })
              }
              onDiscoverModels={(name) => rpc("models.discover", { provider: name })}
              onPanel={setPanel}
              summary={changeSummary(messages)}
            />
          </>
        )}
      </main>
      {panel && (
        <SettingsOverlay
          key={panel}
          initial={panel}
          onClose={() => setPanel("")}
          profile={profile}
          devices={devices}
          deviceId={deviceId}
          deviceName={deviceName}
          connected={connected}
          canManage={canManage}
          gateway={gateway}
          cwd={cwd}
          mode={mode}
          settings={settings}
          sessionId={selected}
          sessions={sessions}
          commandResult={commandResult}
          theme={theme}
          onTheme={setTheme}
          onCommand={runCommand}
          onSession={id => { setSelected(id); setPanel(""); }}
          ensureSession={ensureSession}
          onBranch={value => { setBranch(value.current || ''); setNotice(`已切换到 ${value.current || '新的分支'}`); }}
          attachments={attachments}
          uploading={uploading}
          onUpload={uploadAttachments}
          onRemoveAttachment={removeAttachment}
          rpc={rpc}
          onCwd={value => {
            setCwd(value);
            if (selected && value !== session?.cwd) { setSelected(""); setSession(null); setEvents([]); setNotice("工作目录已选择，下一条消息会在新对话中开始"); }
          }}
          onMode={value => selectModel({ mode: value })}
          onModel={selectModel}
          onDevice={(id) => {
            if (uploading) { setNotice("附件上传中，请稍后切换设备"); return; }
            manuallyDisconnected.current = !id;
            setDeviceId(id);
            setSelected("");
            setSession(null);
            setEvents([]);
            setSessions([]);
            setSettings({}); setCommands([]); setDraftAttachments({});
            setProvider(""); setModel(""); setMode("agent"); setPermission("");
          }}
          onCreate={createSession}
          onSettings={setSettings}
          onNotice={setNotice}
        />
      )}
      {notice && (
        <div role="status" className="toast">
          {notice}
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
