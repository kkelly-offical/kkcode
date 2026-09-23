import { createHash } from 'node:crypto'

/** Bounded exact-evidence repetition detector. Changing tool output is progress;
 * merely repeating a tool name is not a reason to stop legitimate polling. */
export function createProgressGuard() {
  const history = [], warned = new Set()
  return {
    observe(results) {
      const signature = createHash('sha256').update(JSON.stringify(results.map(({ call, result }) => [call.name, call.args, result.status, result.output]))).digest('hex')
      history.push(signature); if (history.length > 18) history.shift()
      for (let period = 1; period <= 3; period++) {
        const pattern = history.slice(-period).join(':')
        let repeats = 0
        for (let end = history.length; end >= period && history.slice(end - period, end).join(':') === pattern; end -= period) repeats++
        if (repeats >= 6) return { state: 'stop', repeats, period }
        if (repeats >= 3 && !warned.has(pattern)) { warned.add(pattern); return { state: 'warn', repeats, period } }
      }
      return { state: 'progress' }
    }
  }
}
