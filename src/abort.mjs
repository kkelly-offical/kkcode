export function isCancellation(error, signal) {
  // A provider may use its own AbortController for a timeout. When a caller
  // signal is available, only that signal identifies a user/parent stop.
  if (signal) return signal.aborted
  return Boolean(error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.errorClass === 'aborted')
}

/** Stop waiting for shared, read-only preparation without cancelling its owner.
 * Both outcomes remain observed, including a rejection after cancellation. */
export function awaitAbortable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || new DOMException('Cancelled', 'AbortError')) }
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
