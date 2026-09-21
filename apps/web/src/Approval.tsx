import React, { useState } from 'react'
type Item = Record<string, any>
export function Approval({ request, onResolve, readOnly = false }: { request: Item; onResolve: (answer: any) => Promise<any>; readOnly?: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [pending, setPending] = useState(false), [error, setError] = useState('')
  const respond = async (answer: any) => { setPending(true); try { await onResolve(answer) } catch (cause: any) { setError(cause.message) } finally { setPending(false) } }
  if (readOnly) return <div className="approval">正在等待有控制权限的用户确认。</div>
  const source = request.sourceSessionId || request.request?.sourceSessionId || request.originSessionId
  return <div className="approval"><b>{request.kind === 'permission' ? '需要你的批准' : '需要你的回答'}</b>
    {source && <p className="approval-source">子代理 · {String(request.sourceLabel || request.request?.sourceLabel || source)}<small>在当前主会话处理；任意一端回答后，其他客户端的待办会同步消失。</small></p>}
    {request.kind === 'permission' ? <><p>{request.request.tool} {request.request.reason}</p><details><summary>操作详情</summary><pre>{JSON.stringify(request.request.args || request.request, null, 2)}</pre></details><button disabled={pending} onClick={() => respond('allow_once')}>允许本次</button><button disabled={pending} onClick={() => respond('deny')}>拒绝</button></> : <form onSubmit={event => { event.preventDefault(); void respond(answers) }}>
      {(request.request.questions || []).map((question: Item) => <fieldset key={question.id}><legend>{question.text || question.header || question.id}</legend>{question.description && <p>{question.description}</p>}
        {(question.options || []).map((option: Item, index: number) => { const value = option.value || option.label; return <label key={index}><input type={question.multi ? 'checkbox' : 'radio'} name={question.id} value={value} checked={question.multi ? (answers[question.id] || '').split(', ').includes(value) : answers[question.id] === value} onChange={event => { const values = new Set((answers[question.id] || '').split(', ').filter(Boolean)); if(event.target.checked) values.add(value); else values.delete(value); setAnswers({ ...answers, [question.id]: question.multi ? [...values].join(', ') : value }) }} />{option.label || value}<small>{option.description}</small></label> })}
        {(!question.options?.length || question.allowCustom) && <label>自定义回答<input aria-label={question.text || question.header || question.id} value={answers[question.id] || ''} required={!question.options?.length} onChange={event => setAnswers({ ...answers, [question.id]: event.target.value })} /></label>}
      </fieldset>)}<button disabled={pending}>提交回答</button>
    </form>}{error && <p role="alert">{error}</p>}</div>
}
