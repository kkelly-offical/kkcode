# 受控 GitHub／GitLab 交付

[文档导航](README.md) · 适用源码：1.1.6；[发行状态](versions.md)。支持GitHub、GitLab.com及宿主明确配置的自托管GitLab。真实GitHub专用草稿PR工程往返已有记录，GitLab实测仍待资源；不能混称所有平台已验收。当前不支持跨fork交付，不自动合并、部署、修改分支保护或授予权限。

## 宿主接入

公开入口为 `@kkelly-offical/kkcode/sdk/forge`。这是可信宿主 SDK，不是将模型输入直接映射为任意 HTTP 请求的工具。

1. 由宿主读取可信连接设置并调用 `parseForgeRemote`。禁止从不受信任项目配置直接取得 API 地址后携带宿主 Token 请求。
2. `createForgeClient` 接受已批准的仓库身份及宿主 Token。HTTPS 默认开启；私网需要宿主显式选择 `allowPrivate`，云元数据地址仍不放行。本机 HTTP 仅供验收。
3. `createForgeDelivery` 固定任务 ID、仓库 ID、任务分支、目标分支及其 SHA、候选 SHA、CI 名称、审批数量和外部动作白名单。
4. 注入 `actions.prepare/settle` 持久操作适配器，以及 `authorize(intent)` 宿主授权检查。它必须验证当前授权、当前任务合同、封存候选与本地验收绑定，不能仅返回模型写出的 `approved: true`。
5. 推荐使用 `createRunForgeDelivery`：它从真实协调器读取原始验收回执，封存并逐文件校对候选 Git 提交，自动接入 `createGitPushTransport`。低层 `createForgeDelivery` 仍接受宿主自定义 `push`，但不能把任意 Shell 命令当受控推送。

Token 不进入交付契约、参数指纹、操作收据或错误正文；客户端拒绝将自身 Token 发布到远端。HTTP 不跟随认证重定向，使用有界响应及现有 DNS/SSRF 防护。

## 交付流程

`pushCandidate` → `openDraft` → `inspect` → 根据审查修改候选、重新验收并创建新契约 → `updateDraft`／`postComment` → `markReady`。

- 每个写操作必须有稳定 `actionId`，同时通过任务白名单和宿主参数绑定授权，落持久意图后再次检查授权。
- 已存在的 prepared／unknown 操作只做远端只读核查；找不到结果也不自动重新发送。新的动作 ID 不能作为绕过未知结果的自动重试策略。
- 草稿和评论带任务、仓库、动作绑定标记；只有唯一且内容、分支、候选全部吻合的结果才能确认成功。
- API 超时、代理 502、丢响应等默认按结果不确定处理，不把“客户端报错”解释成“服务端没执行”。
- GitLab 的评论和说明支持服务端斜线快捷动作，因此拒绝 `/merge` 等行，避免评论授权被扩大成合并授权。
- 评论和审查文字标为 `remote_untrusted`；它们是待处理资料，不改变权限或验收合同。
- 工厂参数、仓库、契约、checks 与调用参数均在异步边界前保留独立快照，不冻结调用者原对象；审批中改变原来的 `refspec`、标题、正文或分支，不会改变实际发送内容。

## 真实任务与 Git 快照

`createRunForgeDelivery` 要求协调器 `verifiedCandidate` 读到实际 `kk.verification-receipt.v1`、原始验收边界、当前候选代次和成功本地验收，而不是接受模型的“完成”文字。候选 HEAD 及每个文件内容、执行权限、删除项／符号链接目标必须对应；新提交的父提交固定为验收时 HEAD。默认生成不更新 HEAD、分支或暂存区的候选对象，宿主应保存返回的 `binding.candidateSha` 以恢复同一个操作。`candidateSha` 选项用于恢复这种封存提交，不是任意绕过验收的 SHA。

推送使用工作区外独立 bare 仓库：仅将固定提交可达对象导出、严格校验并导入自己的 pack，然后断开原对象目录。后续网络命令不读取工作区 Git 配置、SSH 配置、credential helper、hooks、URL rewrite 或模型环境变量；只发送固定 SHA 的普通非强制 refspec，不推标签、目标分支或子模块。Git 认证只放在短命子进程环境里，不写配置文件、命令参数或错误输出。单个 pack 128 MiB、单个 blob 64 MiB，超过限额明确失败。

域名远端要求 Git 支持 `http.curloptResolve`，并固定所有已通过 SSRF 检查的解析地址；旧 Git 缺少此能力时拒绝域名远端，不偷偷退回易受 DNS 重绑定影响的解析。可用 `git help --config` 检查该键。IP 字面地址不需要 DNS；本机测试使用回环 HTTP，生产使用 HTTPS，禁止认证重定向。此配置格式依据 [Git 官方文档](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpcurloptResolve)。

## CLI

CLI 交付只适用于已完成真实本地验收的 `runs` 任务。每个写操作，以及会携带认证令牌的只读 `inspect`，先输出精确计划和 `confirmation`，用户核对后原命令追加 `--confirm <摘要>`。不接受笼统的“全部同意”替代当前版本确认。

```sh
kkcode runs forge prepare RUN_ID --repository https://github.com/ORG/REPO.git --source-branch kk/task --target-branch main --target-sha FULL_SHA --checks checks.json --token-env GITHUB_TOKEN
kkcode runs forge push RUN_ID --action-id push-001 --token-env GITHUB_TOKEN
kkcode runs forge draft RUN_ID --action-id draft-001 --title "任务说明" --body-file report.md --token-env GITHUB_TOKEN
kkcode runs forge inspect RUN_ID --number 123 --token-env GITHUB_TOKEN
# 核对输出的 repository、apiOrigin、allowPrivate、contract、number 及令牌变量名后：
kkcode runs forge inspect RUN_ID --number 123 --token-env GITHUB_TOKEN --confirm EXACT_CONFIRMATION
kkcode runs forge update RUN_ID --action-id update-001 --number 123 --title "更新说明" --body-file report.md --token-env GITHUB_TOKEN
kkcode runs forge comment RUN_ID --action-id comment-001 --number 123 --body-file review.md --token-env GITHUB_TOKEN
kkcode runs forge ready RUN_ID --action-id ready-001 --number 123 --token-env GITHUB_TOKEN
```

`checks.json` 是检查数组，例如 `[{"kind":"check_run","name":"test"}]`；GitLab job 使用 `kind:"job"`。自托管使用 `--kind github|gitlab`、必要时 `--api-base` 和宿主明确选择的 `--allow-private`。这里只引用已经存在的宿主环境变量名，不在命令行、源码、配置或示例中填写 Token。

`prepare` 不推送；后续跨进程接管会重新核验候选。此前明确暂停的任务必须经过新的 `run.delivery` 确认才能恢复交付，不恢复模型执行或重置预算。`inspect` 是两步平台只读查询：第一步正规化并展示准确仓库／API 来源、私网选择、交付契约和编号，明确提示将发送令牌；**未精确确认时不读取令牌、不联网**。仓库元数据或令牌变量名变化会使旧确认失效；本地恢复文件不能自行授予向新来源披露凭据的权力。确认后仍不接管、不写账本；`localLedgerBindingCurrent` 只说明账本绑定未变，`localCandidateRevalidated:false` 明确表示没有重新验收当前磁盘内容。

## 未知效果的独立核查

写入后断线时保留原 `action-id`。若本地候选未变，可使用原参数重进原操作，仅观察已有意图；若本地已经编辑、任务取消或原授权过期，使用独立入口：

```sh
kkcode runs forge reconcile RUN_ID --action-id draft-001 --token-env GITHUB_TOKEN
```

该入口从私密宿主目录取原参数，再与原账本意图的仓库／分支／参数指纹精确匹配；不创建意图、不请求新写授权、不发送 HTTP／Git 写入。SDK 对应 `createForgeReconciler`。已成功的不可变回执不会被再次结算或覆盖；已取消任务不会因核查而复活。原操作已应用和“当前候选可以交付”是两件事：返回 `readOnly:true`、`candidateRevalidated:false`、`requiresReverification:true`，目标分支变化另以 `targetChanged` 标识。核查失败仍为 unknown，不把 404 当成未执行。

## 验收判断

每次检查均核实目标分支与候选 SHA；目标变化返回 `FORGE_TARGET_MOVED`，需要重新集成、验收及授权新契约。

GitHub 同时读取 Check Runs、Commit Status、当前候选审批、GraphQL review threads 和平台合并状态。GitLab 读取当前 SHA 最新流水线及 jobs、审批和 discussions。分页不完整或平台权限不足不能当通过。必需 CI 清单为空也不能通过。

`ready_for_review` 表示草稿满足当前检查，`mergeable` 是最近一次观察到的可合并状态，而非自动合并承诺。状态随远端改变可能失效。`markReady` 仅撤销草稿状态；后续新增保护要求、审查或 CI 变化仍应通过 `inspect` 重新检查。

## 测试与限制

`node --test test/forge-delivery.test.mjs` 使用本机真实 HTTP 服务器与合成 Token，覆盖两平台草稿完整流程、固定 SHA、CI/审查失败、目标移动、授权撤销、写入后丢响应、未知结果不重放、GitLab quick actions、错误脱敏和真实 RunStore 重启。

`test/forge-git-transport.test.mjs` 使用真实 `git http-backend`，检查固定分支、凭据助手／hooks／URL rewrite 隔离、重定向拒绝，以及异步中修改调用者 refspec 不能改写 main。设置 `KKCODE_STRICT_TEST_IMAGE` 为本机固定摘要镜像后，`test/forge-run-delivery.test.mjs` 实际执行模型 HTTP fixture、Docker 文件工具、冻结原始 npm 测试、RunStore 回执、Git 推送和两平台草稿流程；`test/forge-cli.test.mjs` 进一步验证真实 CLI 子进程的预览、确认、跨进程接管和恢复资料。未配置镜像时这两组明确跳过，不能算严格链路通过。

本机已验证上述本地链路，尚未使用公网 GitHub/GitLab 账户进行写入。这些测试不替代真实细粒度权限、自托管版本差异或组织策略验收。生产前仍需专用授权验收仓库，不能使用生产仓库做破坏性试验。

## 官方协议来源

- [GitHub Pull Requests REST](https://docs.github.com/en/rest/pulls/pulls)、[Check Runs](https://docs.github.com/en/rest/checks/runs)、[Commit Status](https://docs.github.com/en/rest/commits/statuses)。
- [GitHub Pull Requests GraphQL](https://docs.github.com/en/graphql/reference/pulls)：reviewThreads、reviewDecision、markPullRequestReadyForReview。
- [GitLab Merge Requests](https://docs.gitlab.com/api/merge_requests/)、[Pipelines](https://docs.gitlab.com/api/pipelines/)、[Approvals](https://docs.gitlab.com/api/merge_request_approvals/)、[Discussions](https://docs.gitlab.com/api/discussions/)、[Notes](https://docs.gitlab.com/api/notes/)。
