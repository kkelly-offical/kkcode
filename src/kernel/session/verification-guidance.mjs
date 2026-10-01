/** Shared model-facing guidance, not an execution grant or a check receipt. */
export function completionVerificationGuidance(language = 'en') {
  if (typeof language === 'string' && (language === 'zh' || language.startsWith('zh-'))) return [
    '完成验证只记录最后一次修改之后实际执行的检查进程，不根据输出“PASS”或退出码0的任意shell表达式推断验收通过。',
    '对已获授权的修改，优先运行项目真实的测试/构建命令，例如 npm test、npm run build、go test ./... 或 python3 -m unittest。',
    '自定义文件、文档或接口断言请在获准的工作区用 write/edit 编写真实测试，失败时必须报错，再通过 bash 运行 node --test <明确的测试文件路径> 或 python3 -m unittest <测试模块>。不要反复执行未被识别的shell条件判断。',
    '直接调用检查命令；多项依赖检查用 && 连接。通配符、输出重定向、管道、;、|| true 和单纯的cat/echo不会形成可信检查回执。',
    '长输出使用工具自动保存的归档，通过 artifact_read / artifact_search 定位错误，不要给测试加 tail/grep 管道。修复时保留原检查参数、模块列表、顺序和工作目录；失败的 && 组合须以相同顺序整体重跑。',
    '保留可复跑的验证脚本；不要在检查命令后串接删除/清理。若检查后又修改产物或测试，需再次执行真实检查，不能用清理前的成功证明清理后的状态。',
    'node --check仅证明语法，git diff --check仅证明文档差异的空白格式；它们不能证明功能或文档内容正确。按用户需求编写断言，并如实报告检查范围。只读/Plan任务不得为了验证创建或修改文件。',
    '逐条把用户要求映射到真实断言，不只检查关键词存在。文档修改需核对所属章节、相对顺序和保留对象；数据库测试需在干净隔离状态初始化并验证迁移，不能依赖先前手工运行留下的表或数据。自写测试通过仍不能替代未覆盖的要求或人工视觉复查。',
    '涉及文档修订时，分别核对接受修订后的目标内容和拒绝本轮修订后应保留的原内容；存在修订标记不代表内容可正确接受或撤销。同时检查新增段落、表格及保留格式，并实际预览交付文件。',
    '最后根据实际输入、最终产物和执行记录核对交付说明与修改日志：新增/修改/保留项、文件路径、章节位置、数量及测试结果都须有依据。旧稿说明、计划和待办完成状态不能代替最终核对；未验证的内容应明确标注。',
    '测试需临时服务时，优先让真实测试程序启动服务、等待就绪、执行断言并在 finally 中关闭服务，所有子进程关闭后以真实测试退出码结束；不要先开多个无限后台服务再用 pkill 清理。',
    '按交付说明约定的工作目录和环境实际运行启动脚本，并检查真实页面与接口；子目录构建成功不能证明从项目入口启动后可用。',
    '后台启动回执不是完成回执。超时、取消和未知效果不等于回滚或成功；出现需要所有者核查的状态应保留记录并报告阻断，不要重跑同一操作或代用户确认。'
  ].join('\n')
  return [
    'Completion records actual check processes after the latest change; a printed PASS or exit zero from an arbitrary shell expression is not a verification receipt.',
    'For authorized changes, prefer real project tests/builds, such as npm test, npm run build, go test ./... or python3 -m unittest.',
    'For custom file, document or API assertions, use write/edit in the authorized workspace to create a real test that fails on a false assertion, then request bash to run node --test <explicit-test-file> or python3 -m unittest <test-module>. Do not repeat an unrecognized shell condition.',
    'Invoke checks directly; join dependent checks with &&. Globs, output redirection, pipelines, ;, || true and plain cat/echo do not produce trusted check receipts.',
    'For long output, inspect the tool-saved archive with artifact_read / artifact_search instead of adding tail/grep pipelines. Preserve the original check arguments, module list, order and working directory during repair; rerun a failed && group as a whole in the same order.',
    'Keep rerunnable verification scripts; do not append deletion/cleanup to a check command. If artifacts or tests change after a check, run a real check again; the pre-cleanup success does not prove the post-cleanup state.',
    'node --check proves syntax only; git diff --check proves whitespace formatting of documentation changes only. Neither proves functionality or document content. Assert the user requirements and report the actual scope. Read-only/Plan tasks must not create or edit files for verification.',
    'Map each user requirement to real assertions, not just keyword presence. Document edits must verify the containing section, relative order and protected objects. Database tests must initialize and verify migrations from clean isolated state, not depend on tables or data left by manual runs. Passing self-written tests does not cover omitted requirements or replace visual review.',
    'For tracked document revisions, verify both the intended accepted content and the original content that must remain after rejecting the current edits. Revision markers alone do not prove correct acceptance or reversal. Check inserted paragraphs, tables and preserved formatting, and preview the actual deliverables.',
    'Before delivery, cross-check the report and change log against the actual inputs, final artifacts and execution records: additions, edits, preserved items, file paths, section locations, counts and test results need evidence. Old draft descriptions, plans and completed todos do not replace this final check; label anything not verified.',
    'For temporary test services, prefer a real test harness that starts the service, waits for readiness, asserts behavior, closes it in finally, joins all children and exits with the real test result. Do not launch multiple indefinite background services and clean them up with pkill.',
    'Run the delivered startup scripts from their documented working directory and environment, and check the actual page and API. A successful subproject build does not prove the project entrypoint works.',
    'A background launch receipt is not completion. Timeout, cancellation and unknown effects are neither rollback nor success. Preserve evidence and report owner-inspection blockers; do not replay the operation or acknowledge on the owner\'s behalf.'
  ].join('\n')
}
