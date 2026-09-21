// Public device/remote protocol surface. SSE stream endpoints, event frame
// shapes, reconnect/replay semantics and the relay `events.push` feature are
// documented in docs/remote-sse-contract.md; the constants they share
// (SSE_RETRY_MS, RELAY_FEATURE_EVENT_PUSH, SSE_CONTROL_TYPES,
// DEVICE_EVENT_TYPES, …) live in src/protocol/index.mjs and are re-exported
// here unchanged. Additive changes must keep PROTOCOL_VERSION at '1' and must
// not alter the headless JSONL schema.
export * from '../../src/protocol/index.mjs'
