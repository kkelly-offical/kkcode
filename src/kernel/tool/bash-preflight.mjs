import {parseShellCommands} from '../permission/shell-analysis.mjs'
import {toolPreDispatchError} from '../core/execution-outcome.mjs'

const builtins=new WeakSet()
export function registerBashPreflights(tools) {
  for(const tool of tools)if(tool.name==='bash')builtins.add(tool)
  return tools
}

// Detect explicit top-level POSIX asynchronous lists, not opaque scripts or
// command substitutions. This is a lifecycle diagnostic, NOT an ownership or
// sandbox proof. The process owner still checks real descendants and outcomes.
function lastTopLevelBackground(command) {
  if(/\$\(|`|<</.test(command))return -1
  let quote='',depth=0,comment=false,last=-1
  for(let i=0;i<command.length;i++){
    const c=command[i],next=command[i+1]
    if(comment){if(c==='\n')comment=false;continue}
    if(quote==="'"){if(c==="'")quote='';continue}
    if(c==='\\'){i++;continue}
    if(quote){if(c===quote)quote='';continue}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue}
    if(c==='#'&&(i===0||/[\s;&|()]/.test(command[i-1]))){comment=true;continue}
    // Here-doc bodies require a full shell parser; leave these opaque rather
    // than interpreting data as an asynchronous command.
    if(c==='<'&&next==='<')return -1
    if(c==='('||c==='{'){depth++;continue}
    if(c===')'||c==='}'){depth=Math.max(0,depth-1);continue}
    if(!depth&&c==='&'&&!['&','>'].includes(next)&&!['&','>','<','|'].includes(command[i-1]))last=i
  }
  return last
}

export function hasUnjoinedPosixBackground(command,{platform=process.platform}={}) {
  // CMD's single & is sequential, not background execution. Do not impose a
  // POSIX rule on Windows. Strict OCI execution explicitly selects Linux.
  if(platform==='win32'||typeof command!=='string')return false
  const lastBackground=lastTopLevelBackground(command)
  if(lastBackground<0)return false
  const commands=parseShellCommands(command.slice(lastBackground+1)).commands
  // Explicit joining is allowed, including literal/expanded PID lists. This
  // does not prove all children settled: actual process ownership still does.
  return !commands.some(entry=>entry.words[0]==='wait'&&!entry.words.includes('-n'))
}

export function assertBashLifecycle(args,{platform=process.platform,language='en'}={}) {
  if(!hasUnjoinedPosixBackground(args?.command,{platform}))return
  const chinese=typeof language==='string'&&(language==='zh'||language.startsWith('zh-'))
  const message=chinese
    ? '本次命令未执行：Shell 的 & 会让子进程脱离本次命令的生命周期。临时测试服务应由 node --test 或其他有限测试程序负责启动、等待就绪、断言并在 finally 中关闭且等待所有子进程。独立长任务请去掉命令内的 &，使用 run_in_background: true 并设置有限 timeout，再通过 task_output 查询实际结果。并行 Shell 工作必须显式 wait 收尾；停止不等于回滚或验收通过。'
    : 'This command was not executed: shell & can leave child processes beyond this command lifecycle. For temporary test services, use node --test or another bounded test harness that starts services, waits for readiness, asserts behavior, then closes and joins every child in finally. For a standalone long task, remove shell &, use run_in_background: true with a finite timeout, and inspect its actual result with task_output. Parallel shell work must explicitly wait for completion; stopping is neither rollback nor test acceptance.'
  throw toolPreDispatchError(Object.assign(new Error(message),{code:'bash_background_requires_owner'}))
}

export function validateBashPreflight(tool,args,options={}) {
  if(builtins.has(tool))assertBashLifecycle(args,options)
}
