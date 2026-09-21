/** A late answer cannot turn a cancelled prompt into permission to continue. */
export async function awaitPromptAnswer(ask, signal, cancelledAnswer) {
  if (signal?.aborted) return cancelledAnswer
  if (!signal) return ask()
  let abort
  const cancelled = new Promise(resolve => { abort = () => resolve(cancelledAnswer); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([Promise.resolve().then(() => signal.aborted ? cancelledAnswer : ask()), cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
