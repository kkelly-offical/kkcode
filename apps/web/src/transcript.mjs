const textContent = (content) =>
  typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
const describe = (value) =>
  typeof value === "string"
    ? value
    : value == null
      ? ""
      : JSON.stringify(value, null, 2);

export function toolPresentation(payload = {}) {
  const name = payload.tool || "Tool",
    args = payload.args || {},
    metadata = payload.metadata || {};
  const mutations =
    metadata.mutations || (metadata.mutation ? [metadata.mutation] : []);
  const path =
    mutations[0]?.filePath ||
    args.file_path ||
    args.path ||
    args.filePath ||
    "";
  const basename = String(path).split(/[\\/]/).at(-1);
  const edit =
    /^(edit|write|patch|multiedit|notebookedit|git_apply_patch)$/.test(name);
  const read = /^(read|glob|grep|ls|list)$/.test(name);
  const failed = ["error", "blocked", "cancelled"].includes(payload.status);
  const action = failed
    ? "未完成"
    : payload.status === "running"
      ? "正在"
      : "已";
  const title = edit
    ? `${action}${name === "write" ? "写入" : "编辑"} ${basename || "文件"}`
    : name === "bash"
      ? `${action}运行 ${args.command || "命令"}`
      : read
        ? `${action}浏览 ${basename || args.pattern || name}`
        : `${name}${payload.status === "running" ? " · 运行中" : ""}`;
  return {
    title,
    icon: edit
      ? "chat"
      : name === "bash"
        ? "terminal"
        : read
          ? "folder"
          : "extension",
    edit,
    failed,
    path,
    added: mutations.reduce(
      (sum, item) => sum + (Number(item.addedLines) || 0),
      0,
    ),
    removed: mutations.reduce(
      (sum, item) => sum + (Number(item.removedLines) || 0),
      0,
    ),
    mutations,
    detail: describe(payload.output || payload.error),
    args: describe(args),
    durationMs: payload.durationMs,
  };
}

/** A single row per invocation/thinking segment; presentation never mutates event data. */
export function buildTranscript(snapshot = {}, events = []) {
  const rows = [],
    persistedTurns = new Set(),
    persistedSteps = new Set();
  for (const message of snapshot?.messages || []) {
    if (!["user", "assistant"].includes(message.role)) continue;
    const text = textContent(message.content);
    if (message.role === "user" && text) persistedTurns.add(message.turnId);
    if (message.role === "assistant" && !message.truncated)
      persistedSteps.add(`${message.turnId}:${message.step}`);
    for (const [index, block] of (Array.isArray(message.content)
      ? message.content
      : []
    ).entries())
      if (block.type === "reasoning")
        rows.push({
          id: `${message.id}-thinking-${index}`,
          type: "thinking",
          text: block.text,
          timestamp: message.createdAt,
          done: true,
        });
    if (text && !message.continuation)
      rows.push({
        id: message.id,
        type: text.includes("<compaction-summary") ? "compacted" : message.role,
        text,
        timestamp: message.createdAt,
      });
  }
  const tools = new Map();
  for (const part of snapshot?.parts || [])
    if (part.type === "tool-call") {
      const key = part.runPartId || part.id;
      const old = tools.get(key);
      if (old) Object.assign(old.payload, part);
      else {
        const row = {
          id: key,
          type: "tool",
          payload: { ...part },
          timestamp: part.createdAt,
        };
        rows.push(row);
        tools.set(key, row);
      }
    }
  rows.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let stream = null,
    thinking = null;
  const seen = new Set(),
    textTurns = new Set(),
    completedTurns = new Set();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const p = event.payload || {},
      turnId =
        event.type === "turn.result" ? p.turnId || event.turnId : event.turnId,
      step = `${turnId}:${p.step}`;
    const endThinking = () => {
      if (thinking && !thinking.done) {
        thinking.done = true;
        thinking.durationMs = Math.max(0, event.timestamp - thinking.timestamp);
      }
      thinking = null;
    };
    if (event.type === "turn.start") {
      stream = null;
      endThinking();
      if (p.prompt && !persistedTurns.has(turnId))
        rows.push({ id: `${event.id}-user`, type: "user", text: p.prompt });
    } else if (
      event.type === "stream.thinking.start" ||
      event.type === "stream.thinking.delta"
    ) {
      if (persistedSteps.has(step)) continue;
      if (!thinking) {
        thinking = {
          id: event.id,
          type: "thinking",
          text: "",
          timestamp: event.timestamp,
          done: false,
        };
        rows.push(thinking);
      }
      if (event.type.endsWith(".delta")) thinking.text += p.text || "";
      stream = null;
    } else if (event.type === "stream.text.delta") {
      endThinking();
      if (persistedSteps.has(step)) continue;
      if (!stream) {
        stream = { id: event.id, type: "assistant", text: "" };
        rows.push(stream);
      }
      stream.text += p.text || "";
      textTurns.add(turnId);
    } else if (
      ["tool.start", "tool.finish", "tool.error"].includes(event.type)
    ) {
      endThinking();
      stream = null;
      const key = p.invocationId || event.id,
        old = tools.get(key);
      const payload = {
        ...p,
        status:
          p.status ||
          (event.type === "tool.start"
            ? "running"
            : event.type === "tool.error"
              ? "error"
              : "completed"),
      };
      if (old) Object.assign(old.payload, payload);
      else {
        const row = { id: key, type: "tool", payload };
        rows.push(row);
        tools.set(key, row);
      }
    } else if (event.type === "stream.end") {
      endThinking();
      stream = null;
    } else if (
      event.type === "session.compacted" ||
      event.type === "stream.provider_compaction"
    )
      rows.push({ id: event.id, type: "compacted" });
    else if (event.type === "turn.finish" || event.type === "turn.result") {
      endThinking();
      if (
        !textTurns.has(turnId) &&
        !completedTurns.has(turnId) &&
        p.reply &&
        !(snapshot?.messages || []).some(
          (message) =>
            message.role === "assistant" && message.turnId === turnId,
        )
      )
        rows.push({ id: event.id, type: "assistant", text: p.reply });
      completedTurns.add(turnId);
      stream = null;
    } else if (event.type === "turn.failed") {
      endThinking();
      rows.push({ id: event.id, type: "error", text: p.error });
    }
  }
  return rows;
}

export function changeSummary(rows) {
  const files = new Set();
  let added = 0,
    removed = 0;
  for (const row of rows)
    if (
      row.type === "tool" &&
      !["running", "error", "blocked", "cancelled"].includes(row.payload.status)
    ) {
      const tool = toolPresentation(row.payload);
      for (const mutation of tool.mutations)
        if (mutation.filePath) files.add(mutation.filePath);
      added += tool.added;
      removed += tool.removed;
    }
  return { files: files.size, added, removed };
}
