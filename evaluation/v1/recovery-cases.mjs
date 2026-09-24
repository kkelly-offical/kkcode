const definitions = [
  ['暂停后的需求保留', 'pause_resume', '请记住交付必须使用UTC、禁止自动发布，当前先记录到 NOTES.md。', '现在实现 result.json，包含 timezone:"UTC", publish:false。', { timezone: 'UTC', publish: false }],
  ['协调器重建后继承同一会话', 'coordinator_restart', '用户目录不能覆盖；交付目录固定为 deliverable-v2，先记录约束。', '恢复工作，把交付约束写成 result.json。', { directory: 'deliverable-v2', overwrite: false }],
  ['取消不伪装完成', 'cancel_inflight', '先用 write 工具创建 effect-once.txt，内容仅为 once，然后继续生成说明。', '取消后不要自动重跑，核对任务终态与未决动作。', null],
  ['事件订阅断开重连不重复工具', 'detach_reattach', '用 bash 中的 Node 将 counter.txt 中的数值加一（文件不存在视为0），只能执行一次，然后继续生成说明。', '重新附着同一运行，读取 counter.txt 和历史证据，把 count 写到 result.json；不得再次增加。', { count: 1 }],
  ['模型工具结果配对跨重启', 'protocol_pair_restart', '使用工具读取事实，再在另一个回合总结；事实是赤道长度40075公里。', '恢复会话并输出 result.json。', { equatorKm: 40075 }],
  ['长历史压缩保留禁止条件', 'force_compaction', '不可变约束：不得联网、保留 original.txt；输出编号为 COMP-17。', '压缩后继续，把编号和约束写入 result.json。', { id: 'COMP-17', network: false, preserve: 'original.txt' }],
  ['压缩期间历史修订 CAS', 'compaction_history_race', '旧要求是标签A。开始压缩，但用户会更新要求。', '最新要求已变为标签B；不能提交旧摘要。', { label: 'B' }],
  ['摘要未缩减不能删除原历史', 'compaction_no_reduction', '保存四个项目事实并等待压缩结果。', '摘要更大时保留原文并正确恢复事实。', null],
  ['prepared 动作崩溃结果未知', 'kill_after_prepare', '先用 write 创建 effect-once.txt，内容仅为 once。', '恢复后先检查真实文件状态，不可凭同ID直接重试。', null],
  ['副作用成功但回执写入失败', 'receipt_write_failure', '先用 write 创建 effect-once.txt，内容仅为 once；只允许创建一次。', '回执写失败后核查现状，禁止重复不可逆动作。', null],
  ['拥有者代次阻止旧进程写回', 'owner_epoch_takeover', '第一拥有者先用 write 创建 effect-once.txt，内容仅为 once。', '拒绝旧拥有者迟到的工具结算和完成声明。', null],
  ['候选变更让旧验收失效', 'candidate_drift_after_verify', '实现完成后生成验收回执。', '验收后文件被修改，旧回执不得完成新候选。', null],
  ['摘要与原始完整产物关联', 'artifact_context_restore', '先用 bash 完整输出 large-log.txt（不要截断或 tail），长输出必须保留产物；暂不写最终答案。', '必须用 artifact_read 读取已保存输出，可用 artifact_search 定位 LAST=，在 result.json 写出 {"tail":"最后一个 LAST= 后的值"}。不要重新运行原命令。', { tail: 'ARTIFACT-9001' }],
  ['工具调用中止保持合法历史', 'abort_tool_batch', '在同一个回复中调用两个 read，分别读取 original.txt 和 package.json。', '恢复时历史工具调用/结果应保持配对，不杜撰未运行的结果。', null],
  ['实际进程 SIGKILL 后续租', 'process_sigkill_resume', '先用 write 创建 effect-once.txt，内容仅为 once。', '重新创建宿主，读取相同runId、未决动作与事件后再决定是否继续。', null]
]

export const recoveryCases = definitions.map(([title, lifecycle, first, last, expected], index) => ({
  id: `C${String(index + 1).padStart(2, '0')}`, category: 'recovery', split: index < 10 ? 'development' : 'sealed',
  title, driver: 'durable-recovery', critical: true, lifecycle,
  prompt: first, stages: [{ prompt: first }, { action: lifecycle, prompt: `${last}${expected ? '\n最终答案必须写入 result.json。' : ''}` }],
  fixtureFiles: { 'package.json': '{"private":true,"type":"module"}\n', 'original.txt': 'Preserve this original input.\n',
    ...(lifecycle === 'artifact_context_restore' ? { 'large-log.txt': `${'record: preserved tool evidence\n'.repeat(4500)}LAST=ARTIFACT-9001\n` } : {}) },
  expectedResult: expected,
  requiredEvidence: ['durableRunId', 'ownerEpoch', 'beforeEventsHash', 'afterEventsHash', 'lifecycleReceipt', 'candidateHash'],
  // These definitions intentionally have no fabricated reference completion.
  // A lifecycle driver must prove the actual transition, not write expected JSON.
  referenceFiles: null
}))
