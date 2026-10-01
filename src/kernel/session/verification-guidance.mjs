/** Shared model-facing guidance, not an execution grant or a check receipt. */
export function completionVerificationGuidance(language = 'en') {
  if (typeof language === 'string' && (language === 'zh' || language.startsWith('zh-'))) return [
    '完成验证只记录最后一次修改之后实际执行的检查进程，不根据输出“PASS”或退出码0的任意shell表达式推断验收通过。',
    '对已获授权的修改，优先运行项目真实的测试/构建命令，例如 npm test、npm run build、go test ./... 或 python3 -m unittest。',
    '自定义文件、文档或接口断言请在获准的工作区用 write/edit 编写真实测试，失败时必须报错，再通过 bash 运行 node --test <明确的测试文件路径> 或 python3 -m unittest <测试模块>。不要反复执行未被识别的shell条件判断。',
    '直接调用检查命令；多项依赖检查用 && 连接。通配符、输出重定向、管道、;、|| true 和单纯的cat/echo不会形成可信检查回执。',
    'node --check仅证明语法，git diff --check仅证明文档差异的空白格式；它们不能证明功能或文档内容正确。按用户需求编写断言，并如实报告检查范围。只读/Plan任务不得为了验证创建或修改文件。',
    '测试需临时服务时，优先让真实测试程序启动服务、等待就绪、执行断言并在 finally 中关闭服务，所有子进程关闭后以真实测试退出码结束；不要先开多个无限后台服务再用 pkill 清理。',
    '后台启动回执不是完成回执。超时、取消和未知效果不等于回滚或成功；出现需要所有者核查的状态应保留记录并报告阻断，不要重跑同一操作或代用户确认。'
  ].join('\n')
  return [
    'Completion records actual check processes after the latest change; a printed PASS or exit zero from an arbitrary shell expression is not a verification receipt.',
    'For authorized changes, prefer real project tests/builds, such as npm test, npm run build, go test ./... or python3 -m unittest.',
    'For custom file, document or API assertions, use write/edit in the authorized workspace to create a real test that fails on a false assertion, then request bash to run node --test <explicit-test-file> or python3 -m unittest <test-module>. Do not repeat an unrecognized shell condition.',
    'Invoke checks directly; join dependent checks with &&. Globs, output redirection, pipelines, ;, || true and plain cat/echo do not produce trusted check receipts.',
    'node --check proves syntax only; git diff --check proves whitespace formatting of documentation changes only. Neither proves functionality or document content. Assert the user requirements and report the actual scope. Read-only/Plan tasks must not create or edit files for verification.',
    'For temporary test services, prefer a real test harness that starts the service, waits for readiness, asserts behavior, closes it in finally, joins all children and exits with the real test result. Do not launch multiple indefinite background services and clean them up with pkill.',
    'A background launch receipt is not completion. Timeout, cancellation and unknown effects are neither rollback nor success. Preserve evidence and report owner-inspection blockers; do not replay the operation or acknowledge on the owner\'s behalf.'
  ].join('\n')
}
