import { DesktopWorkspaceRail, DesktopProjectBar } from '../../desktop/ui/WorkspaceChrome';
import { desktopLoginProof } from './gateway-login';
import React, { useState, useEffect, useRef, useMemo } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./mobile.css";
import "./studio.css";
import "./reading.css";
import "./pixel.css";
import "./experience.css";
import "./fonts.css";
import "../../desktop/ui/workspace.css";
import { PixelBuddy, PixelScene, StudioBar } from "./PixelStudio";
import { SessionHome, ConnectionLanding, SessionActions, ConversationMenu } from "./Home";
import { Sheet } from "./Sheet";
import { ContextUsage } from './ContextUsage';
import { useTranscriptScroll } from './useTranscriptScroll';
import { useReadingPreferences } from './ReadingPreferences';
import { TodoProgress } from './TodoProgress';
import { acceptTodoSnapshot, scopedSubagents, mergeSubagentSnapshot, mergeSubagentEvent } from '../../../src/ui/todo-progress.mjs';
import { modeLabel } from "./modes.mjs";
import { SettingsOverlay } from "./Settings";
import { Icon } from "./Icon";
import { TranscriptRow, ThinkingRow } from "./TranscriptView";
import { collapseCompletedRuns, collapseCompactedHistory, compactionLabel } from './conversation-presentation.mjs';
import { remoteErrorMessage } from './errors.mjs';
import { Composer } from "./Composer";
import { buildTranscript, changeSummary } from "./transcript.mjs";
import { DeviceClient } from "../../../src/sdk/client.mjs";
import { deviceLoginPath } from "../../../src/protocol/login-path.mjs";
import { awaitAbortable } from "../../../src/abort.mjs";
import { useDeviceEvents } from './DeviceEvents';
import { mcpLoadNotice } from './device-notices.mjs';
import { Approval } from "./Approval";
import { ActivityPanel, RunBanner, type ActivityTab } from './ActivityPanel';
import { ProjectPicker } from './ProjectPicker';
import { projectName, projectSessions } from './projects.mjs';
import { HistoryNavigator } from './HistoryNavigator';
import { initializeDesktopPreferences, persistDesktopPreferences } from './desktop';
import { attachmentMediaType, readAttachment, type Attachment } from "./Attachments";

type Item = Record<string, any>;
function App() {
  const desktopApp = Boolean(window.kkcodeDesktop || window.kkcodeDesktopLogin);
  const reading = useReadingPreferences();
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
  const [todos, setTodos] = useState<{ identity: string, snapshot: Item | null } | null>(null);
  const [subagents, setSubagents] = useState<{ identity: string, items: Item[] } | null>(null);
  const [subagentNotice, setSubagentNotice] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState("agent"),
    [model, setModel] = useState(""),
    [provider, setProvider] = useState("");
  const [managedAction, setManagedAction] = useState('menu');
  const [managedSession, setManagedSession] = useState<Item | null>(null), [rewindTarget, setRewindTarget] = useState<Item | null>(null);
  const [rewinding, setRewinding] = useState(false), [showArchived, setShowArchived] = useState(false);
  const [control, setControl] = useState<Item | null>(null);
  const [draftAttachments, setDraftAttachments] = useState<Record<string, Attachment[]>>({});
  const [uploading, setUploading] = useState(false), [branch, setBranch] = useState("");
  const [commandResult, setCommandResult] = useState<Item>({});
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("kkcode.web.theme") || "dark"; } catch { return "dark"; } });
  useEffect(() => { void persistDesktopPreferences(); }, [reading.reading]);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [sidebar, setSidebar] = useState(false);
  const [stopping, setStopping] = useState(false), [turnPhase, setTurnPhase] = useState('idle');
  const [turnOperation, setTurnOperation] = useState('');
  const activeExecution = useRef(''), stopRequested = useRef('');
  const pendingSend = useRef<Item | null>(null), stopInFlight = useRef<Promise<void> | null>(null);
  const steeringInFlight = useRef(false);
  const settledExecutions = useRef(new Set<string>());
  const viewIdentity = useRef({ gateway, deviceId, selected });
  viewIdentity.current = { gateway, deviceId, selected };
  const todoIdentity = `${gateway ? 'gateway' : 'local'}:${deviceId}:${selected}`;
  function currentView(id: string, device = deviceId) { return viewIdentity.current.gateway === gateway && viewIdentity.current.deviceId === device && viewIdentity.current.selected === id; }
  function observeTodos(value: Item | null | undefined) {
    if (!currentView(selected)) return;
    const identity = todoIdentity;
    setTodos(previous => ({ identity, snapshot: acceptTodoSnapshot(previous?.identity === identity ? previous.snapshot : null, value, selected) }));
  }
  function acknowledgeSend(token: Item) {
    if (token.acknowledged || !currentView(token.sessionId, token.deviceId)) return;
    token.acknowledged = true;
    setPrompt(old => old === token.text ? '' : old);
    const key = `${token.deviceId}:${token.sessionId}`, consumed = new Set(token.attachmentIds || []);
    setDraftAttachments(old => ({ ...old, [key]: (old[key] || []).filter(item => !consumed.has(item.id)) }));
  }
  function observeTurn(meta: Item) {
    if (meta.running === undefined) return;
    const pending = pendingSend.current;
    if (!meta.running && pending && pending.deviceId === deviceId && pending.sessionId === selected && !settledExecutions.current.has(pending.id)) return;
    const execution = meta.turnState?.executionId || '';
    if (meta.running && execution && settledExecutions.current.has(execution)) return;
    if (execution) activeExecution.current = execution;
    setBusy(Boolean(meta.running));
    setTurnOperation(meta.turnState?.operation || '');
    if (!meta.running) { activeExecution.current = ''; stopRequested.current = ''; setStopping(false); setTurnPhase('idle'); }
    else {
      const isStopping = meta.turnState?.phase === 'stopping' || Boolean(stopRequested.current && (!execution || stopRequested.current === execution));
      setStopping(isStopping); setTurnPhase(isStopping ? 'stopping' : meta.turnState?.phase || 'running');
    }
  }
  function settleExecution(id: string) {
    const pending = pendingSend.current;
    if (id && pending?.id === id) { pending.terminal = true; pending.finish?.({ accepted: Boolean(pending.acknowledged), settled: true }); pendingSend.current = null; }
    if (id) { settledExecutions.current.add(id); if (settledExecutions.current.size > 64) settledExecutions.current.delete(settledExecutions.current.values().next().value!); }
    if (id && activeExecution.current && activeExecution.current !== id) return;
    activeExecution.current = ''; stopRequested.current = ''; stopInFlight.current = null; setBusy(false); setStopping(false); setTurnPhase('idle'); setTurnOperation('');
  }
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [activityTab, setActivityTab] = useState<ActivityTab>('todos');
  const [activityChoice, setActivityChoice] = useState<boolean | null>(null);
  const [historyPanel, setHistoryPanel] = useState<'history' | 'search' | ''>('');
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState('');
  useEffect(() => { setProjectFilter(''); setHistoryPanel(''); setProjectsOpen(false); }, [gateway, deviceId]);
  useEffect(() => { setThinkingExpanded(false); }, [selected, busy]);
  const [panel, setPanel] = useState(""),
    [cwd, setCwd] = useState("");
  const [settings, setSettings] = useState<Item>({});
  const [commands, setCommands] = useState<Item[]>([]),
    [approval, setApproval] = useState<Item[]>([]);
  const cursor = useRef(0);
  const scroll = useTranscriptScroll(`${gateway}:${deviceId}:${selected}`, ready && session?.id === selected);
  const manuallyDisconnected = useRef(false);
  const livePreviewNotice = useRef(""), livePreviewLimited = useRef(false);
  const attachmentKey = `${deviceId}:${selected}`;
  const attachments = draftAttachments[attachmentKey] || [];
  const sdk = useMemo(() => new DeviceClient({ url: location.origin, gateway, deviceId: gateway ? deviceId || null : null }), [gateway, deviceId]);
  async function rpc(method: string, params: Item = {}, options: Item = {}) {
    try { return await sdk.request<any>(method, params, options); }
    catch (error: any) { throw Object.assign(new Error(remoteErrorMessage(error)), { code: error.code, status: error.status }); }
  }
  function releaseControl(sessionId: string, lease: Item, options: Item = {}) {
    return rpc('control.release', { sessionId, ...(lease?.leaseId ? { leaseId: lease.leaseId } : {}) }, options);
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
    if (event.type === 'session.status') { const result = await rpc('sessions.list'); if (!signal.aborted) { setSessions(Array.isArray(result) ? result : result.sessions || []); if (event.deleted && event.sessionId === selected) { setSelected(''); setSession(null); setEvents([]); setBusy(false); setApproval([]); } } }
  } });
  function applySelection(value: Item) {
    if (!Object.hasOwn(value, 'context') && (value.model !== undefined && value.model !== model || value.providerType && value.providerType !== provider)) setSession(previous => previous ? { ...previous, context: null } : previous);
    if (value.model !== undefined) setModel(value.model);
    if (value.providerType) setProvider(value.providerType);
    if (value.modeId) setMode(value.modeId === "agent-auto" ? "auto" : value.modeId);
  }
  function applyLiveSnapshot(value: Item | null) {
    observeTodos(value?.todos);
    if (currentView(selected)) setSubagents({ identity: todoIdentity, items: scopedSubagents(value?.subagents, selected) });
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
    const lease = await rpc('control.acquire', { sessionId: selected });
    try { applySelection(await rpc('sessions.configure', { sessionId: selected, ...selection })); }
    finally { await releaseControl(selected, lease).catch(() => {}); }
  }
  const attempt = async (fn: () => Promise<any>) => {
    try {
      return await fn();
    } catch (e: any) {
      setNotice(remoteErrorMessage(e));
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
          tag.setAttribute("content", resolved === "dark" ? "#101714" : "#f5f1e7"),
        );
    };
    apply(); media.addEventListener("change", apply);
    try { localStorage.setItem("kkcode.web.theme", theme); } catch { /* Private browsing may disable storage. */ }
    void persistDesktopPreferences();
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
        const response = await fetch("/auth/token", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_code: loginFlow.device_code, browser: true, ...(loginFlow.verifier ? { code_verifier: loginFlow.verifier } : {}) }) });
        const result = await response.json();
        if (stopped) return;
        if (response.ok && result.authenticated) { if (loginFlow.state) await window.kkcodeDesktopLogin?.finish(loginFlow.state); setProfile(result.profile); setLoginFlow(null); setReady(true); return; }
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
  async function updateSessionMetadata(target: Item, patch: Item) {
    await rpc("sessions.update", { sessionId: target.id, ...patch });
    await refreshSessions();
    if (selected === target.id) setSession(old => old ? { ...old, ...patch } : old);
    setNotice(patch.archived === true ? "对话已归档，可从已归档对话中恢复" : patch.archived === false ? "对话已恢复" : "对话已改名");
  }
  async function deleteConversation(target: Item) {
    await rpc('sessions.delete', { sessionId: target.id, confirmed: true });
    if (selected === target.id) { setSelected(''); setSession(null); setEvents([]); setApproval([]); setBusy(false); }
    await refreshSessions();
    setNotice('对话已删除，工作区文件未改变；恢复副本保存在被控电脑的私密目录。');
  }
  async function rewindConversation() {
    if (!rewindTarget || !selected || rewinding) return;
    setRewinding(true);
    try {
      const lease = await rpc("control.acquire", { sessionId: selected });
      try {
        const result = await rpc("sessions.rewind", { sessionId: selected, messageId: rewindTarget.messageId, expectedLastMessageId: session?.messages?.at(-1)?.id, confirmed: true });
        if (!result.ok) throw new Error("没有可回退的提问");
        setPrompt(result.prompt || ""); setEvents([]); setRewindTarget(null);
        setSessionRevision(value => value + 1); await refreshSessions();
        setNotice("对话已回退，提问已恢复到输入框；工作区文件保持不变");
      } finally { await releaseControl(selected, lease).catch(() => {}); }
    } catch (cause: any) { setNotice(cause.message); }
    finally { setRewinding(false); }
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
      setCommands(availableCommands.filter((item: Item) => !["keys", "permission"].includes(item.name))); setSettings(config);
    });
    return () => { cancelled = true; };
  }, [ready, deviceId]);
  useEffect(() => {
    setEvents([]);
    setTodos(null);
    setSubagents(null);
    setApproval([]);
    setSession(null);
    const pending = pendingSend.current?.deviceId === deviceId && pendingSend.current?.sessionId === selected ? pendingSend.current : null;
    if (!pending) { pendingSend.current = null; stopInFlight.current = null; }
    setBusy(Boolean(pending));
    setStopping(false); setTurnPhase(pending ? 'starting' : 'idle'); activeExecution.current = pending?.id || ''; stopRequested.current = '';
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
      if (cancelled || snapshot?.eventCursor < cursor.current) return;
      cursor.current = snapshot?.eventCursor || cursor.current;
      setSession(current => {
        if (!current || current.id !== snapshot?.id || current.historyRevision !== snapshot?.historyRevision) return snapshot;
        const unique = (items: Item[]) => [...new Map(items.map(item => [item.id, item])).values()];
        return { ...snapshot, messages: unique([...(current.messages || []), ...(snapshot.messages || [])]), parts: unique([...(current.parts || []), ...(snapshot.parts || [])]), historyHasMore: current.historyHasMore, nextBefore: current.nextBefore };
      });
      applyLiveSnapshot(snapshot);
    };
    const watchError = (error: any) => {
      if (cancelled) return false;
      setNotice(remoteErrorMessage(error));
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
        observeTurn(batch);
        if (batch.control !== undefined) setControl(batch.control || null);
        if (!limited) setNotice("实时记录已归档，已重新同步会话快照；较早消息可按需加载");
        return;
      }
      const fresh = (batch.events || []).filter((event: Item) => typeof event.seq !== "number" || event.seq > cursor.current);
      if (fresh.some((event: Item) => event.type === 'session.deleted')) { setSelected(''); setSession(null); setEvents([]); setBusy(false); setApproval([]); await refreshSessions(); return; }
      if (fresh.some((event: Item) => event.type === "session.rewound")) {
        const snapshot = await rpc("sessions.get", { sessionId: selected });
        if (cancelled) return;
        cursor.current = snapshot?.eventCursor || batch.cursor || 0;
        setSession(snapshot); applyLiveSnapshot(snapshot); setApproval([]); observeTurn(snapshot || {});
        await refreshSessions(); return;
      }
      if (fresh.length) {
        cursor.current = fresh.at(-1).seq ?? cursor.current;
        setEvents((old) => [...old, ...fresh]);
        for (const event of fresh) {
          if (event.type === 'todo.updated' && event.sessionId === selected) observeTodos(event.payload?.snapshot);
          if (['subagent.delegated', 'subagent.settled', 'subagent.progress'].includes(event.type)) setSubagents(previous => ({ identity: todoIdentity, items: mergeSubagentEvent(previous?.identity === todoIdentity ? previous.items : [], event, selected) }));
          if (['session.context.updated', 'turn.usage.update'].includes(event.type) && event.payload?.context) setSession(previous => previous ? { ...previous, context: event.payload.context } : previous);
          if (event.type === 'turn.waiting.children') setTurnPhase('waiting_children');
          if (event.type === 'turn.step.start') setTurnPhase('running');
          const execution = event.payload?.executionId || '';
          if (['turn.preparing', 'turn.start', 'turn.stopping', 'session.compacting'].includes(event.type)) {
            if (execution) activeExecution.current = execution;
            const pending = pendingSend.current;
            if (['turn.start', 'session.compacting'].includes(event.type) && pending && pending.id === execution) acknowledgeSend(pending);
            if (event.payload?.operation) setTurnOperation(event.payload.operation);
            setBusy(true);
            const halted = event.type === 'turn.stopping' || Boolean(stopRequested.current && stopRequested.current === execution);
            setStopping(halted); setTurnPhase(halted ? 'stopping' : event.type === 'turn.preparing' ? 'starting' : event.type === 'session.compacting' ? 'compacting' : 'running');
          }
          if (event.type === 'session.compacted') setSession(previous => previous ? { ...previous, lastCompaction: event.payload } : previous);
          if (['turn.failed', 'turn.cancelled'].includes(event.type) && event.payload?.operation === 'compact') setPrompt(old => old || '/compact');
          if (event.type === 'turn.finish' && event.payload?.settling && (!execution || execution === activeExecution.current)) setTurnPhase(stopRequested.current ? 'stopping' : 'finishing');
          if (['turn.result', 'turn.failed', 'turn.cancelled'].includes(event.type) || event.type === 'turn.finish' && !event.payload?.settling) settleExecution(execution);
        }
        if (
          fresh.some((event: Item) =>
            ["turn.result", "turn.failed", "turn.cancelled"].includes(event.type),
          )
        )
          await refreshSessions();
      }
      if (batch.approvals !== undefined) setApproval(batch.approvals || []);
      observeTurn(batch);
      if (batch.control !== undefined) setControl(batch.control || null);
      for (const event of fresh) {
        if (event.type === 'provider.capability.notice' && event.payload?.message) {
          const message = event.payload.message; setNotice(message);
          clearTimeout(deviceNoticeTimer.current);
          deviceNoticeTimer.current = setTimeout(() => setNotice(previous => previous === message ? '' : previous), 6500);
        }
        if (event.type === 'session.configured') applySelection(event.payload);
        if (event.type === 'session.branch.changed') setBranch(event.payload.branch || '');
        if (["session.updated", "session.title.updated"].includes(event.type)) { setSession(old => old ? { ...old, ...event.payload } : old); await refreshSessions(); }
      }
      const turnEnded = fresh.some((event: Item) => ["turn.result", "turn.failed", "turn.cancelled"].includes(event.type));
      const childSettled = fresh.some((event: Item) => event.type === 'task.settled' && event.sessionId === selected && event.payload?.subSessionId);
      const stopped = batch.running === false || turnEnded;
      if (childSettled || stopped && (livePreviewLimited.current || turnEnded || (fresh.length && cursor.current % 1000 < fresh.length)))
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
          await sdk.stream(selected, {
            after: cursor.current,
            signal: controller.signal,
            onEvent: async (event: Item) => { await applyBatch({ events: [event] }).catch(watchError); },
            onMeta: async (meta: Item) => { await applyBatch(meta).catch(watchError); },
            onGap: async (gap: Item) => { await applyBatch({ gap: true, cursor: gap?.cursor }).catch(watchError); },
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
      if (snapshot) { applySelection(snapshot); setCwd(snapshot.cwd || cwd); setProjectFilter(snapshot.cwd || ''); }
      observeTurn(snapshot || {});
      await stream();
    });
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [selected, deviceId, gateway, ready, sessionRevision]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  async function createSession(): Promise<string> {
    const previousView = viewIdentity.current;
    const result = await rpc("sessions.create", { cwd, mode, model: model || undefined, provider: provider || undefined });
    if (!result.modeId && settings.provider?.default) {
      const lease = await rpc("control.acquire", { sessionId: result.id });
      try { await rpc("sessions.configure", { sessionId: result.id, mode, model: model || undefined, provider: provider || undefined }); }
      finally { await releaseControl(result.id, lease).catch(() => {}); }
    }
    if (viewIdentity.current.deviceId !== previousView.deviceId || viewIdentity.current.selected !== previousView.selected) return result.id;
    if (result.modeId) applySelection(result);
    await refreshSessions();
    if (viewIdentity.current.deviceId !== previousView.deviceId || viewIdentity.current.selected !== previousView.selected) return result.id;
    if (pendingSend.current?.deviceId === deviceId && !pendingSend.current.sessionId) pendingSend.current.sessionId = result.id;
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
      const mediaType = attachmentMediaType(file), limit = /^(image|audio|video)\/|^application\/(pdf|vnd.openxmlformats-officedocument)/.test(mediaType) ? 4 * 1024 * 1024 : 256 * 1024;
      if (file.size > limit) throw new Error(`${file.name} 超过单个附件大小限制`);
    }
    setUploading(true);
    try {
      const id = await ensureSession(), key = `${deviceId}:${id}`;
      for (const file of files) {
        const mediaType = attachmentMediaType(file), data = await readAttachment(file);
        const attachment = await rpc("attachments.upload", { sessionId: id, name: file.name, mediaType, data });
        if (mediaType.startsWith("image/")) attachment.preview = `data:${mediaType};base64,${data}`;
        setDraftAttachments(old => ({ ...old, [key]: [...(old[key] || []), attachment] }));
      }
    } finally { setUploading(false); }
  }
  async function removeAttachment(id: string) {
    await rpc("attachments.remove", { sessionId: selected, id });
    setDraftAttachments(old => ({ ...old, [attachmentKey]: (old[attachmentKey] || []).filter(item => item.id !== id) }));
  }
  async function runCommand(text: string, id = selected, token?: Item) {
    const sessionId = id || await ensureSession();
    const lease = await rpc("control.acquire", { sessionId });
    let accepted = false;
    try {
      if (token?.cancelled) return { accepted: false };
      const request = rpc("commands.run", { sessionId, command: text, ...(token ? { executionId: token.id } : {}) }, token ? { id: token.id } : {});
      if (token) token.start = request;
      const result = await request;
      accepted = Boolean(result?.accepted);
      if (!currentView(sessionId) || token?.terminal) return result;
      if (accepted && token) acknowledgeSend(token);
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
      else if (action === "permission") setPanel("mode");
      else if (action === "keys") setNotice("此客户端支持原生文本输入和无障碍导航；终端快捷键只在 CLI 中提供");
      else if (action && ["models", "mode", "sessions", "extensions"].includes(action)) setPanel(action);
      else if (result?.panels?.length || result?.output?.length || (!action && !accepted)) setPanel("command");
      if (accepted && !settledExecutions.current.has(result.executionId || result.turnId)) setBusy(true);
      return result;
    } finally { if (!accepted) await releaseControl(sessionId, lease).catch(() => {}); }
  }
  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if ((!prompt.trim() && !attachments.length) || pendingSend.current || uploading || readOnly) return;
    const text = prompt;
    if (busy) {
      if (steeringInFlight.current) return;
      if (stopping || turnPhase === 'finishing') { setNotice('当前任务正在收尾；请保留补充要求，稍后发送。'); return; }
      if (turnOperation === 'compact') { setNotice('正在压缩上下文，请等待完成或停止后再发送。'); return; }
      if (attachments.length || text.startsWith('/')) { setNotice('执行期间可发送文字补充要求；附件和命令请在本轮结束后发送。'); return; }
      const id = selected, device = deviceId, executionId = activeExecution.current;
      steeringInFlight.current = true;
      try {
        await rpc('control.acquire', {sessionId: id});
        if (!currentView(id, device) || activeExecution.current !== executionId) return;
        await rpc('turns.steer', {sessionId: id, executionId, prompt: text});
        if (currentView(id, device)) { setPrompt(old => old === text ? '' : old); setNotice('补充要求已保存，智能体将在安全执行节点读取。'); }
      } catch (cause: any) { if (currentView(id, device)) setNotice(cause.message); }
      finally { steeringInFlight.current = false; }
      return;
    }
    const token: Item = { id: crypto.randomUUID(), sessionId: selected, deviceId, text, attachmentIds: attachments.map(item => item.id), cancelled: false, start: null, terminal: false };
    token.finished = new Promise(resolve => { token.finish = resolve; });
    pendingSend.current = token;
    const compact = /^\/compact\s*$/.test(text);
    if (!text.startsWith('/') || compact) { activeExecution.current = token.id; setBusy(true); setTurnPhase('starting'); setTurnOperation(compact ? 'compact' : ''); }
    let accepted = false;
    try {
      let id = selected;
      if (!id) {
        id = await createSession();
      }
      token.sessionId = id;
      if (token.cancelled || viewIdentity.current.deviceId !== deviceId || (viewIdentity.current.selected !== id && viewIdentity.current.selected !== selected)) return;
      if (text.startsWith("/")) {
        if (attachments.length) throw new Error("附件不能附加到 / 命令，请先发送普通消息或移除附件");
        if (!compact) setPrompt(old => old === text ? '' : old);
        const result = await runCommand(text, id, token);
        accepted = Boolean(result?.accepted);
        if (accepted && compact && currentView(id) && !token.terminal) setTurnPhase(token.cancelled ? 'stopping' : 'compacting');
        return;
      }
      const lease = await rpc("control.acquire", { sessionId: id });
      if (token.cancelled) { await releaseControl(id, lease).catch(() => {}); return; }
      try { token.start = rpc("turns.start", {
        sessionId: id,
        prompt: text.trim() ? text : "请分析附件。",
        attachmentIds: attachments.map(item => item.id),
        executionId: token.id,
      }, { id: token.id });
      const result = await token.start;
      accepted = result.accepted !== false;
      if (!accepted) return;
      } catch (error) { if (!token.terminal) await releaseControl(id, lease).catch(() => {}); throw error; }
      if (!currentView(id) || token.terminal) return;
      acknowledgeSend(token);
      if (!settledExecutions.current.has(token.id)) { setBusy(true); setTurnPhase(token.cancelled ? 'stopping' : 'running'); }
      scroll.latest();
    } catch (cause: any) {
      if (!token.terminal && currentView(token.sessionId)) {
        if (text.startsWith('/')) setPrompt(old => old || text);
        setNotice(cause.message);
      }
    }
    finally {
      if (pendingSend.current === token) pendingSend.current = null;
      if (!accepted && currentView(token.sessionId)) settleExecution(token.id);
    }
  }
  async function stopTurn() {
    if (stopInFlight.current || !busy || readOnly) return;
    const id = selected, device = deviceId, pending = pendingSend.current;
    const executionId = activeExecution.current || pending?.id || '';
    if (pending) pending.cancelled = true;
    stopRequested.current = executionId; setStopping(true); setTurnPhase('stopping');
    const operation = (async () => {
      try {
        if (!id) return;
        const options = { signal: AbortSignal.timeout(15000) };
        const lease = await rpc('control.acquire', { sessionId: id }, options);
        const cancel = () => rpc('turns.cancel', { sessionId: id, ...(executionId ? { executionId } : {}) }, options);
        let result = await cancel();
        // A stop can overtake the start RPC on the wire. Keep the same opaque
        // execution ID and recheck after that exact start is acknowledged.
        if (!result.cancelled && pending?.start) {
          const started = await awaitAbortable(Promise.race([pending.start, pending.finished]), options.signal);
          if (started.settled) result = { running: false, cancelled: true };
          else if (started.accepted !== false) result = await cancel();
        }
        if (result.running === false) await releaseControl(id, lease, options).catch(() => {});
        if (currentView(id, device) && (!activeExecution.current || activeExecution.current === executionId)) { observeTurn(result); if (!result.running && !pendingSend.current) settleExecution(executionId); }
      } catch (cause: any) {
        if (currentView(id, device) && !settledExecutions.current.has(executionId)) { stopRequested.current = ''; setStopping(false); setTurnPhase('running'); setNotice(`停止尚未确认，任务可能仍在运行。${cause.message} 可再次点击停止。`); }
      }
    })();
    stopInFlight.current = operation;
    try { await operation; } finally { if (stopInFlight.current === operation) stopInFlight.current = null; }
  }
  async function openFolders() {
    setPanel("folders");
  }
  async function browseProject() {
    setProjectsOpen(false);
    if (window.kkcodeDesktop) {
      const path = await window.kkcodeDesktop.openFolder();
      if (path) chooseProject(path);
    } else await openFolders();
  }
  useEffect(() => {
    if (!ready || !window.kkcodeDesktop) return;
    let disposed = false;
    const readProject = () => {
      const project = new URLSearchParams(location.hash.slice(1)).get('project');
      if (!project) return;
      history.replaceState(null, '', location.pathname + location.search);
      if (uploading) { setNotice('附件上传中，请稍后切换项目'); return; }
      void rpc('folders.list', { path: project }).then(value => { if (!disposed) chooseProject(value.path); }).catch(error => { if (!disposed) setNotice(remoteErrorMessage(error)); });
    };
    readProject(); window.addEventListener('hashchange', readProject);
    return () => { disposed = true; window.removeEventListener('hashchange', readProject); };
  }, [ready, uploading]);
  async function openSettings() {
    setPanel("settings");
  }
  const connected =
    ready &&
    (!gateway ||
      devices.some((device) => device.id === deviceId && device.online));
  const childItems = subagents?.identity === todoIdentity ? subagents.items : [];
  const childrenActive = childItems.some(item => ['running', 'pending'].includes(item.status));
  useEffect(() => {
    if (!ready || !connected || !selected) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let refreshing = false;
    async function refresh() {
      clearTimeout(timer);
      if (document.hidden || refreshing || controller.signal.aborted) return;
      refreshing = true;
      try {
        const value = await sdk.request<any>('sessions.get', { sessionId: selected, view: 'subagents' }, { signal: controller.signal });
        if (controller.signal.aborted || !currentView(selected)) return;
        setSubagents(previous => ({ identity: todoIdentity, items: mergeSubagentSnapshot(previous?.identity === todoIdentity ? previous.items : [], value.subagents, selected) }));
        setSubagentNotice(Object.hasOwn(value, 'messages') ? '升级被控电脑后可使用自动汇报和完整模型详情' : '');
      } catch {
        if (!controller.signal.aborted && currentView(selected)) setSubagentNotice('子代理状态暂未同步，连接恢复后自动更新');
      }
      finally { refreshing = false; }
      if (!controller.signal.aborted && !document.hidden && (busy || childrenActive || panel === 'subagents' || activityTab === 'subagents' && activityChoice !== false)) timer = setTimeout(refresh, 2000);
    }
    const visible = () => { if (!document.hidden) void refresh(); else clearTimeout(timer); };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [sdk, ready, connected, selected, todoIdentity, busy, childrenActive, panel === 'subagents', activityTab === 'subagents', activityChoice]);
  const deviceName = gateway
    ? devices.find((device) => device.id === deviceId)?.name || "未连接设备"
    : profile.name;
  const activeDevice = devices.find(device => device.id === deviceId);
  const canManage = !gateway || Boolean(activeDevice && !activeDevice.shared);
  useEffect(() => {
    const newConversation = () => { if (connected && canManage && !uploading) setPanel('new'); };
    const searchConversations = () => { if (connected) setHistoryPanel('search'); };
    window.addEventListener('kkcode:new-conversation', newConversation);
    window.addEventListener('kkcode:search-conversations', searchConversations);
    return () => { window.removeEventListener('kkcode:new-conversation', newConversation); window.removeEventListener('kkcode:search-conversations', searchConversations); };
  }, [connected, canManage, uploading]);
  const readOnly = !connected || Boolean(activeDevice?.shared && activeDevice.permissions?.[selected] !== 'control');
  const messages: Item[] = buildTranscript(session || {}, events);
  const todoSnapshot = todos?.identity === todoIdentity ? todos.snapshot : null;
  const workspaceSessions: Item[] = projectSessions(sessions, projectFilter);
  const activityOpen = Boolean(selected) && (activityChoice ?? (!small && Boolean(todoSnapshot?.items?.length || childItems.length || changeSummary(messages).files)));
  const hasRunBanner = busy || approval.length > 0;
  const openActivity = (tab: ActivityTab) => { setActivityTab(tab); setActivityChoice(true); };
  const openPanel = (value: string) => {
    if (selected && ['subagents', 'tasks', 'artifacts'].includes(value)) openActivity(value as ActivityTab);
    else setPanel(value);
  };
  function chooseProject(path: string) {
    if (uploading) { setNotice('附件上传中，请稍后切换项目'); return; }
    setProjectsOpen(false); setCwd(path); setProjectFilter(path); setSelected(''); setSession(null); setEvents([]); setSidebar(false);
  }
  const companion = <StudioBar waiting={turnPhase === 'waiting_children'} busy={busy} stopping={stopping} approval={approval.length > 0} readOnly={readOnly || Boolean(session?.archived)} connected={connected} selected={Boolean(selected)} canManage={canManage} onPanel={openPanel} onPrompt={value => setPrompt(previous => previous ? `${previous}\n\n${value}` : value)} />;
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
            const proof = await desktopLoginProof();
            const r = await fetch("/auth/device", {
              method: "POST",
              redirect: "error",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind: "client", name: window.kkcodeDesktopLogin ? "KK Code Windows" : "Web browser", ...(proof ? { native: proof.native } : {}) }),
            });
            if (!r.ok) throw new Error("暂时无法开始登录，请稍后重试");
            const flow = await r.json();
            const loginPath = deviceLoginPath(flow.user_code);
            setLoginFlow({ ...flow, ...(proof ? { state: proof.state, verifier: proof.verifier } : {}) });
            window.open(loginPath, "_blank", "noopener");
          })
        }
      />
    );
  const mobileHome = small && !selected;
  return (
    <div className={`app experience${desktopApp ? ' desktop-workbench' : ' web-entry'}${activityOpen && !small ? ' with-activity' : ''}`} style={reading.style}>
      {desktopApp && <DesktopWorkspaceRail project={cwd} session={Boolean(selected)} onProject={() => setProjectsOpen(true)} onNew={() => setPanel("new")} onPanel={setPanel} onActivity={openActivity} />}
      <aside
        className={sidebar ? "sidebar open" : "sidebar"}
        aria-label="工作区导航"
      >
        <div className="brand">
          <PixelBuddy className="brand-mark" /><div><div className="wordmark">KK<span>Code</span></div><div className="brand-subtitle">PIXEL STUDIO</div></div>
          <button className="icon mobile" onClick={() => setSidebar(false)}>
            ×
          </button>
        </div>
        <button className="new" disabled={!connected || !canManage || uploading} onClick={() => setPanel("new")}>
          <Icon name="plus" size={17} /> 新对话
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
              setProvider(""); setModel(""); setMode("agent");
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
          onClick={() => setProjectsOpen(true)}
          aria-label="选择项目与工作区"
          title={cwd}
        >
          <Icon name="folder" size={18} /> {projectFilter ? projectName(projectFilter) : "全部项目"} <span>⌄</span>
        </button>
        <button className="sidebar-search" onClick={() => setHistoryPanel('search')}><Icon name="search" size={16} /><span>搜索项目中的对话</span></button>
        <div className="studio-nav" role="group" aria-label="工作区快捷入口"><button onClick={() => attempt(openSettings)}><Icon name="settings" size={17} />设置</button><button disabled={!connected || !canManage} onClick={() => setPanel("models")}><Icon name="cloud" size={17} />模型</button><button disabled={!connected || !canManage} onClick={() => setPanel("extensions")}><Icon name="extension" size={17} />扩展</button></div>
        <div className="section-label">
          {showArchived ? "已归档对话" : "对话记录"} <button className="icon" aria-label={showArchived ? "查看活跃对话" : "查看已归档对话"} onClick={() => setShowArchived(value => !value)}><Icon name="archive" size={15} /></button>
        </div>
        <nav>
          {workspaceSessions.filter(s => Boolean(s.archived) === showArchived).map((s) => (
            <div className="session-list-row" key={s.id}>
            <button
              className={selected === s.id ? "session active" : "session"}
              aria-label={s.title || s.id}
              onClick={() => {
                setSelected(s.id);
                setSidebar(false);
              }}
            >
              <span>{s.title || s.id}</span><small>{String(s.status || '').startsWith('running') ? '进行中' : s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : ''}</small>
            </button>
            {canManage && <button className="icon session-more" aria-label={`管理对话 ${s.title || "新对话"}`} onClick={() => { setManagedAction('menu'); setManagedSession(s); }}><Icon name="more" size={17} /></button>}
            </div>
          ))}
        </nav>
        <div className="sidebar-studio-note"><span>MAKE SOMETHING GREAT</span><i /></div>
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
        {desktopApp && !small && <DesktopProjectBar path={cwd} branch={branch} onProject={() => setProjectsOpen(true)} />}
        {mobileHome ? (
          <SessionHome
            sessions={workspaceSessions}
            name={deviceName}
            connected={connected}
            onSelect={(s) => setSelected(s.id)}
            onNew={() => setPanel(connected && canManage ? "new" : "connections")}
            onSettings={() => attempt(openSettings)}
            onConnect={() => setPanel("connections")}
            canManage={canManage}
            projectLabel={projectFilter ? projectName(projectFilter) : '全部项目'}
            onProject={() => setProjectsOpen(true)}
            onManage={value => { setManagedAction('menu'); setManagedSession(value); }}
          />
        ) : (
          <>
            <header className="chat-header">
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
                <button aria-label={`切换设备，当前 ${deviceName}`} title={cwd ? `${cwd} · ${deviceName}` : deviceName} onClick={() => setPanel("connections")}>
                  {cwd.split(/[\\/]/).at(-1)} · {deviceName}
                </button>
              </div>
              <div className="chat-header-actions">
                <button className="icon" aria-label="对话记录" disabled={!selected} onClick={() => setHistoryPanel('history')}><Icon name="clock" size={19} /></button>
                <button className="icon" aria-label="会话活动" aria-pressed={activityOpen} disabled={!selected} onClick={() => setActivityChoice(!activityOpen)}><Icon name="activity" size={20} /></button>
                <button
                  className="icon"
                  aria-label="新对话"
                  disabled={!connected || !canManage || uploading}
                  onClick={() => setPanel("new")}
                >
                  <Icon name="chat" size={20} />
                </button>
                <ConversationMenu key={todoIdentity} canManage={canManage} busy={busy} archived={Boolean(session?.archived)} onAction={action => {
                  if (['subagents', 'artifacts', 'settings'].includes(action)) { openPanel(action); return; }
                  if (action === 'compact') { void attempt(() => runCommand('/compact')); return; }
                  const current = sessions.find(item => item.id === selected) || session;
                  if (!current) return;
                  if (action === 'archive') void attempt(() => updateSessionMetadata(current, { archived: !current.archived }));
                  else { setManagedAction(action); setManagedSession(current); }
                }} />
              </div>
            </header>
            <RunBanner busy={busy} phase={turnPhase} compacting={turnOperation === 'compact'} approvals={approval.length} snapshot={todoSnapshot} messages={messages} onStop={() => void stopTurn()} readOnly={readOnly} companion={companion} />
            <div className="transcript-region">
            <div className="transcript" ref={scroll.viewport} tabIndex={0} role="region" aria-label="对话内容">
              <div className="transcript-content" ref={scroll.content}>
              {session?.historyHasMore && <button className="load-history" disabled={loadingHistory} onClick={() => void loadEarlierMessages()}>{loadingHistory ? "正在加载…" : "加载更早消息"}</button>}
              {!messages.length && !busy && !approval.length && (
                <div className="empty">
                  <PixelScene /><div className="studio-eyebrow">YOUR IDEAS. A LITTLE PIXEL MAGIC.</div>
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
              {collapseCompactedHistory(collapseCompletedRuns(messages, busy)).map((item: Item) => { const row = item.type === 'compacted' ? { ...item, label: compactionLabel(item.compaction) } : item; return (
                <TranscriptRow key={row.id} row={row} active={busy && !['stopping', 'finishing'].includes(turnPhase)} stopping={stopping} thinkingExpanded={row.done === false && thinkingExpanded} onThinkingExpanded={setThinkingExpanded} loadPreview={ref => rpc("media.preview", { sessionId: selected, ...ref })} onRewind={canManage && !busy && !session?.archived ? target => setRewindTarget(target) : undefined} onResume={row.type === 'cancelled' && !busy && canManage && !session?.archived ? () => { setPrompt(old => old || '请从中断处继续。先核查已有结果和已执行的操作，不要重复已完成的改动。'); document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')?.focus(); } : undefined} />
              ); })}
              {busy && turnOperation !== 'compact' && !['finishing', 'waiting_children'].includes(turnPhase) && !approval.length &&
                !messages.some(
                  (row) => ['thinking', 'assistant', 'review'].includes(row.type) && row.done === false || row.type === 'tool' && row.payload?.status === 'running',
                ) && (
                  <ThinkingRow key={`waiting-${selected}`} row={{ id: 'waiting-thinking', text: '', done: false }} active={!['stopping', 'finishing'].includes(turnPhase)} stopping={stopping} initiallyExpanded={thinkingExpanded} onExpanded={setThinkingExpanded} />
                )}
              {approval.map(request => <Approval key={request.id} request={request} readOnly={readOnly} onResolve={answer => rpc('approvals.resolve', { id: request.id, sessionId: request.sessionId || selected, answer })} />)}
              </div>
            </div>
            {scroll.away && <button className="back-to-latest" onClick={() => { scroll.viewport.current?.focus({ preventScroll: true }); scroll.latest(); }}>↓ 回到最新</button>}
            {scroll.canReturn && <button className="back-to-reading" onClick={scroll.returnToReading}>返回刚才的位置</button>}
            </div>
            {control && !control.yours && <div className="control-notice">另一客户端正在控制此会话。{canManage && <button onClick={() => attempt(async () => { await rpc('control.acquire', { sessionId: selected, takeover: true }); setControl({ yours: true }); })}>接管控制</button>}</div>}
            {busy && turnOperation === 'compact' && <div className="compact-progress" role="status">{stopping ? '正在停止压缩…' : turnPhase === 'starting' ? '正在提交压缩…' : '正在压缩上下文…'}</div>}
            {!activityOpen && <TodoProgress onSubagents={() => openActivity('subagents')} key={todoIdentity} snapshot={todoSnapshot} subagents={childItems} />}
            {busy && ['stopping', 'finishing'].includes(turnPhase) && <div className="stop-progress" role="status">{stopping ? '正在停止并保存已有结果；已执行的文件改动不会撤销。' : '正在保存本轮结果…'}</div>}
            <div className="conversation-status">
              {!hasRunBanner && companion}
              <ContextUsage value={session?.context} />
            </div>
            <Composer
              key={`${gateway}:${deviceId}`}
              readOnly={readOnly || Boolean(session?.archived)}
              canManage={canManage}
              prompt={prompt}
              onPrompt={setPrompt}
              busy={busy}
              compacting={turnOperation === 'compact'}
              stopping={stopping}
              stopInBanner={!small && hasRunBanner}
              mode={mode}
              modes={commandResult.clientAction === "mode" && commandResult.items?.length ? commandResult.items : undefined}
              model={model}
              provider={provider}
              settings={settings}
              uploading={uploading}
              attachments={attachments}
              attachmentScope={attachmentKey}
              onUploadAttachments={uploadAttachments}
              onRemoveAttachment={removeAttachment}
              branch={branch}
              commands={commands}
              onSend={() => void send()}
              onStop={() => void stopTurn()}
              onMode={(value) =>
                void attempt(async () => {
                  await selectModel({ mode: value });
                  setNotice(`执行模式已切换为 ${modeLabel(value)}`);
                })
              }
              onModel={(selection) =>
                void attempt(async () => {
                  await selectModel(selection);
                  setNotice(`模型已切换为 ${selection.model}`);
                })
              }
              onDiscoverModels={(name) => rpc("models.discover", { provider: name, refresh: true })}
              onThinking={(name, id, value) => void attempt(async () => {
                const result = await rpc('settings.update', { config: { provider: { [name]: { model_options: { [id]: { thinking_effort: value } } } } } });
                setSettings(result.config); setNotice('思考强度已更新');
              })}
              onPanel={openPanel}
              summary={changeSummary(messages)}
            />
          </>
        )}
      </main>
      {activityOpen && (small ? <Sheet title="会话活动" onClose={() => setActivityChoice(false)}><ActivityPanel key={todoIdentity} tab={activityTab} onTab={setActivityTab} snapshot={todoSnapshot} items={childItems} messages={messages} sessionId={selected} canManage={canManage} notice={subagentNotice} rpc={rpc} onClose={() => setActivityChoice(false)} /></Sheet> : <ActivityPanel key={todoIdentity} tab={activityTab} onTab={setActivityTab} snapshot={todoSnapshot} items={childItems} messages={messages} sessionId={selected} canManage={canManage} notice={subagentNotice} rpc={rpc} onClose={() => setActivityChoice(false)} />)}
      {projectsOpen && <ProjectPicker sessions={sessions} cwd={projectFilter} deviceId={deviceId} deviceName={deviceName} onChoose={chooseProject} onAll={() => { setProjectFilter(''); setProjectsOpen(false); }} onBrowse={() => void attempt(browseProject)} onClose={() => setProjectsOpen(false)} />}
      {historyPanel && <HistoryNavigator key={`${todoIdentity}:${historyPanel}`} messages={messages} sessions={workspaceSessions} search={historyPanel === 'search'} hasMore={Boolean(session?.historyHasMore)} loading={loadingHistory} onLoadEarlier={() => void loadEarlierMessages()} onClose={() => setHistoryPanel('')} onSession={id => { setSelected(id); setHistoryPanel(''); }} onMessage={id => { setHistoryPanel(''); requestAnimationFrame(() => { if (!scroll.reveal(id)) setNotice('此记录尚未加载，请先加载更早消息。'); }); }} />}
      {panel && (
        <SettingsOverlay
          key={panel}
          initial={panel}
          subagents={childItems}
          subagentNotice={subagentNotice}
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
          reading={reading.reading}
          onReading={reading.updateReading}
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
            setProjectFilter(value);
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
            setProvider(""); setModel(""); setMode("agent");
          }}
          onCreate={createSession}
          onSettings={setSettings}
          onNotice={setNotice}
        />
      )}
      {managedSession && <SessionActions initialAction={managedAction} session={sessions.find(item => item.id === managedSession.id) || managedSession} busy={Boolean(managedSession.id === selected ? busy : String(managedSession.status).startsWith("running"))} onClose={() => setManagedSession(null)} onUpdate={patch => updateSessionMetadata(managedSession, patch)} onDelete={() => deleteConversation(managedSession)} />}
      {rewindTarget && <Sheet title="回退对话" onClose={() => { if (!rewinding) setRewindTarget(null); }}>
        <p className="sheet-note">撤回{rewindTarget.messageId ? "这条提问及其后的全部" : "上一轮"}对话，并恢复提问草稿。设备会保存回退前的备份。此操作会同步到其他客户端，<strong>不会撤销任何文件或 Git 修改</strong>。</p>
        {rewindTarget.text && <blockquote>{rewindTarget.text.slice(0, 300)}</blockquote>}
        <button className="sheet-primary" disabled={rewinding || busy} onClick={() => void rewindConversation()}>确认回退对话</button>
        <button className="sheet-secondary" disabled={rewinding} onClick={() => setRewindTarget(null)}>取消</button>
      </Sheet>}
      {notice && (
        <div role="status" className="toast">
          {notice}
        </div>
      )}
    </div>
  );
}
void initializeDesktopPreferences().finally(() => createRoot(document.getElementById("root")!).render(<App />));
