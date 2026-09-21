/**
 * Session live-event transport, M26 SSE contract v1. The device serves
 * `GET /api/v1/events/stream?sessionId=<id>[&after=<seq>]` (gateway:
 * `/api/v1/devices/<id>/events/stream?...`) as text/event-stream:
 * - one frame per log row, `event:` = row.type, `data:` = the same event
 *   object `events.list` returns, `id:` = the per-session seq cursor;
 * - `event: connected` once at open, mirroring the `events.list` envelope
 *   without `events` ({running, control, approvals, ...});
 * - `event: session.state` on state/tick changes ({running, control,
 *   pendingApprovalCount}); approval bodies arrive as approval.* rows;
 * - `event: replay.gap` when the log rotated — the stream stays open and the
 *   client resyncs via `sessions.get`, exactly like the polling gap path.
 * Devices without the endpoint answer 404/HTML, which surfaces as
 * `stream_unavailable` so the caller keeps using `events.list` polling.
 */

export function eventsStreamPath({ gateway = false, deviceId = "", sessionId = "", after = 0 } = {}) {
  const base = gateway
    ? `/api/v1/devices/${encodeURIComponent(deviceId)}/events/stream`
    : "/api/v1/events/stream";
  const params = new URLSearchParams({
    sessionId: String(sessionId || ""),
    after: String(Math.max(0, Number(after) || 0)),
  });
  return `${base}?${params}`;
}

/** Incremental SSE wire parser: push decoded text, get complete frames back. */
export class EventStreamParser {
  constructor() {
    this.buffer = "";
    this.event = "";
    this.data = [];
    this.id = "";
  }
  push(chunk) {
    this.buffer += chunk;
    const frames = [];
    for (;;) {
      const boundary = this.buffer.match(/\r\n\r\n|\n\n|\r\r/);
      if (!boundary) break;
      const raw = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const frame = this.#frame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }
  end() {
    const frame = this.buffer.trim() ? this.#frame(this.buffer) : null;
    this.buffer = "";
    return frame ? [frame] : [];
  }
  #frame(raw) {
    for (const line of raw.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
      else if (field === "event") this.event = value;
      else if (field === "id") this.id = value;
    }
    if (!this.data.length) {
      this.event = "";
      return null;
    }
    const frame = { event: this.event || "message", data: this.data.join("\n"), id: this.id };
    this.event = "";
    this.data = [];
    return frame;
  }
}

export function streamUnavailable(response) {
  return Object.assign(
    new Error(`Event stream unavailable (HTTP ${response.status})`),
    { code: "stream_unavailable", status: response.status },
  );
}

/**
 * Consume one SSE connection until it closes or the signal aborts.
 * Frame dispatch follows contract v1: `connected`/`session.state` → onMeta,
 * `replay.gap` → onGap (stream continues), anything else → onEvent(row).
 * Returns "closed" when the stream ends.
 */
export async function streamSessionEvents({
  url,
  signal,
  onEvent,
  onMeta,
  onGap,
  fetchImpl = globalThis.fetch,
}) {
  const response = await fetchImpl(url, {
    headers: { Accept: "text/event-stream" },
    credentials: "include",
    signal,
  });
  if (!response.ok || !response.body) throw streamUnavailable(response);
  if (!String(response.headers.get("content-type") || "").includes("text/event-stream"))
    throw streamUnavailable(response);
  const parser = new EventStreamParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    const frames = done
      ? parser.end()
      : parser.push(decoder.decode(value, { stream: true }));
    for (const frame of frames) {
      const payload = frame.data ? JSON.parse(frame.data) : {};
      if (frame.event === "connected" || frame.event === "session.state")
        await onMeta?.(payload);
      else if (frame.event === "replay.gap") await onGap?.(payload);
      else await onEvent?.(payload);
    }
    if (done) return "closed";
  }
}
