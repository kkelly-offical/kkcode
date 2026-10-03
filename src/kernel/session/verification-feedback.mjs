import { isToolNotStarted } from '../core/execution-outcome.mjs'
import { completionRepairGuidance, evaluateCompletionEvidence } from './completion-evidence.mjs'

/** Early private guidance from canonical foreground receipts. This does not
 * validate task completion, modify tool output, execute checks, or grant access.
 * Keep final/background/owner-inspection validation in the ordinary loop. */
export function createVerificationFeedback({cwd = process.cwd(), language = 'en'} = {}) {
  const notified = new Set()
  let notices = 0
  return {
    observe(events, sinceIndex) {
      if (notices >= 8 || !Array.isArray(events) || !Number.isSafeInteger(sinceIndex) || sinceIndex < 0 || sinceIndex >= events.length) return ''
      const eligible = new Set()
      for (let index = sinceIndex; index < events.length; index++) {
        const event = events[index]
        if (event?.name === 'bash' && ['completed', 'error'].includes(event.status) && !isToolNotStarted(event) &&
            event.metadata?.started !== false && !event.metadata?.backgroundTask) eligible.add(index)
      }
      if (!eligible.size) return ''
      const verification = evaluateCompletionEvidence({toolEvents: events, cwd, language})
      const failures = verification.failures.filter(failure =>
        ['failed_check', 'unverified_check'].includes(failure.kind) && eligible.has(failure.index) &&
        !notified.has(`${failure.kind}:${failure.id}`))
      if (!failures.length) return ''
      const guidance = completionRepairGuidance({verification: {...verification, failures}, toolEvents: events, cwd, language})
      if (!guidance) return ''
      notices++
      for (const failure of failures) notified.add(`${failure.kind}:${failure.id}`)
      const chinese = language === 'zh' || language.startsWith('zh-')
      return (chinese
        ? '[检查反馈] 刚才的检查失败，或其独立退出状态未被核实。先核对实际错误并完成必要修改，再补齐下列匹配检查。查看长输出请用已归档结果的 artifact_read / artifact_search；不要用管道或文件重定向缩短输出。这条提示不是任务验收结论。'
        : '[VERIFICATION FEEDBACK] A check just failed or its individual exit status was not verified. Inspect the actual failure, finish the necessary changes, then repair the matching checks below. Read long archived output with artifact_read / artifact_search; do not use pipelines or file redirects to shorten output. This guidance is not a task acceptance verdict.') + '\n\n' + guidance
    }
  }
}
