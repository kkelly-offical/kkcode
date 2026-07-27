import { updateMessage } from "./checker.mjs"

export function notifyUpdateToast({ promise, showToast, durationMs = 8000 } = {}) {
  if (!promise || typeof promise.then !== "function" || typeof showToast !== "function") return
  void promise
    .then((result) => {
      const message = updateMessage(result)
      if (message) showToast(message, { topic: "update", tone: "warning", durationMs })
    })
    .catch(() => {})
}
