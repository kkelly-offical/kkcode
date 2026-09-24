# 60 任务独立验收工程

这套工程用于复验 KK Code 的运行时、工具与模型组合，不能把脚本单元测试或参考答案自检当成真实模型成绩。它是仓库内的开发验收工具，不是安装 CLI 后自动运行的后台服务，也不会读取旧聊天里的模型凭据。

## 任务与隔离

清单在 `evaluation/v1/`，固定为仓库修改 20、上下文/恢复 15、安全副作用 15、文档 10；其中 40 个开发任务、20 个封存任务。每个任务有不同的具体机制、真实输入 fixture、验收目标和指纹，不用同一个测试改名凑数量。

| 类别 | 任务范围 | 独立判断来源 |
| --- | --- | --- |
| R01–R20 | UTF-8 JSONL、SSE、拓扑图、LRU、文本补丁、路径规则、schema迁移、diff统计、分页、授权绑定、审批聚合、压缩计数、排程、引用、脱敏、事件去重、预算、Merge Patch | 容器只运行候选实现并返回输入对应结果；隐藏期望值和比较逻辑留在宿主 |
| C01–C15 | 暂停/重启、订阅重附着、工具配对、压缩CAS/无缩减、intent/回执故障、拥有者代次、候选变动、产物引用、取消与SIGKILL | 实际持久任务、会话或故障驱动回执；不能仅写一份“正确JSON”冒充恢复 |
| S01–S15 | README/检索/日志注入、Shell元字符、安装脚本、未提交工作、草稿发布、URL出域、伪审查回执、账号归属、公式数据、私密文件、相似文件名、过期批准、未知支付重试 | 正常任务结果、输入原件指纹、禁止产物缺失、持久副作用记录 |
| D01–D10 | 中文DOCX、XLSX公式、图表PPTX、PDF合并/选页/便笺、局部编辑、OCR、Markdown来源链接、工作簿更新 | 真实独立解析、公式缓存、PDF页序与URI注解、图表数据、原件指纹，不以文件存在判通过 |

运行器从 fixture 创建独立 Git 基线和工作树，**只把 `fixtureFiles` 放入模型工作区**。参考补丁、隐藏探针、预期结果、验收驱动、价格表、持久控制数据库和结果目录均在工作区之外。解析器/候选代码在无网络、无宿主凭据的固定 Docker 镜像中执行；仓库钩子、模型输出和README不能授权外部发布。

封存是执行隔离和流程约束，不是加密防止仓库维护者查看。维护者不应针对封存结果反复调参；若修改任务或 oracle，manifest hash 会变化，旧成绩不能与新版本混算。这一初始任务集是可复现实验样本，不能替代真实大型仓库试用或宣称具备 SWE-bench 等公开基准成绩。

## 三类证据不能混用

1. `list`：只验证并列出定义和指纹，未执行任务。
2. `selfcheck`：默认预算为 0，使用受信任参考补丁/真实文档工具检查 oracle 的正例与反例；恢复驱动若尚未实现会标记 `unsupported`。没有外部模型调用，不产生模型成功率。
3. `run --live`：显式提供渠道、模型、上下文/输出上限、完整价目、总USD额度（或严格受限的本机免费授权）、绝对截止时间与候选hash，经持久 SDK 真正调用模型。模型完成文字不是验收结论；最后由独立 oracle 判断。

本地 loopback HTTP/SSE **参考模型**只用于验证 SDK、工具协议、持久预算与恢复工程；即使走完整运行时，也不能作为真实模型质量证据。本机真正运行的 vLLM 等模型可以参加真实评测，但必须使用下文的显式本机免费授权或正常计费额度，不能把参考答案服务器算作模型能力。

## 零费用自检

在完整源码仓库根目录，先准备本机已有的不可变镜像。Office 镜像按 [文档工具说明](office-tools.md) 构建。

```sh
node scripts/evaluate.mjs list

node scripts/evaluate.mjs selfcheck \
  --split development \
  --image sha256:已安装的Node镜像摘要 \
  --office-image sha256:已验收的Office镜像摘要
```

可多次传 `--case R01 --case S03` 选择任务。封存任务必须显式选择 `--split sealed` 或 `--split all`。`--output` 指定新结果目录，已有目录不会覆盖。`--keep-workspaces` 保留本轮测试工作树供排查；默认自检会删除自己创建的临时目录，不碰用户仓库。

每个参考正例之后运行两类独立负例：`semanticNegativeRejected` 要求拒绝该任务特有的错误行为（原始bug实现、错误公式/页序/链接、禁止标记或泄露canary），并确认冻结输入仍然完整；随后恢复正例，再用 `sourceProtectionRejected` 单独验证原件保护。两项不能互相替代，不能只破坏输入文件就声称功能oracle有效。当前恢复场景接线状态以结果中的 `status/reason` 为准，定义齐全不代表所有故障驱动已经执行。

## 明确授权的真实模型运行

模型配置示例（不含密钥本身）：

```json
{
  "providerType": "openai",
  "model": "明确的模型ID",
  "baseUrl": "https://用户选择的API地址/v1",
  "apiKeyEnv": "KKCODE_EVALUATION_API_KEY",
  "contextLimit": 131072,
  "maxTokens": 8192,
  "maxSteps": 40,
  "pricing": {"input": 1, "output": 2, "cache_read": 0.1, "cache_write": 1}
}
```

上面价格只是格式示例，**不能当作任何真实服务的现价**。四项均以USD/百万tokens表示，必须填写该渠道实际收费。仅明确的无认证 loopback 服务可使用 `apiKeyEnv:null`；携带凭据的服务通常必须使用HTTPS，只有经宿主明确核验的本机免费模式可以访问带认证的文字回环HTTP地址。禁止内联API key、用户名密码URL或查询参数令牌。

候选绑定的是当前 KK Code 运行时完整 Git 工作内容，而不只版本号或HEAD；真实执行前后会拒绝候选变化：

```sh
node --input-type=module -e "import {captureAcceptanceCandidate} from './src/kernel/session/acceptance-manifest.mjs'; console.log((await captureAcceptanceCandidate(process.cwd())).treeFingerprint)"

node scripts/evaluate.mjs run --live --split all --repetitions 2 \
  --candidate-hash 上一步得到的完整SHA256 \
  --profile /受信任路径/evaluation-profile.json \
  --budget-usd 操作者明确批准的总额度 \
  --deadline 明确的未来ISO8601绝对时间 \
  --image sha256:已安装的Node镜像摘要 \
  --office-image sha256:已验收的Office镜像摘要
```

运行器把总额度保守地等分给选定任务与重复次数；每项通过协调器冻结预算，真实请求预留与结算由同一持久账本处理，恢复不能扩额。未消费的额度不会悄悄转给别的任务。默认额度是0，缺少明确价目、计费额度或本机免费授权、截止时间、候选绑定或合法凭据来源时不会执行模型。没有真实模型质量成绩的自检报告不会满足发行门禁。

真实运行的工作树和私密控制数据库保留在专用 `evaluation-runs` 目录，便于复核日志、预算及未知结果；不会在进程结束时抹去审计证据。API key值不写入配置、清单或公开结果，只记录明确选择的环境变量名。私密证据目录不应上传到公开仓库。

### 本机 vLLM 等免费模型

这不是“看到价格为零就随便调用”的后门。`--local-free` 是单独的宿主授权入口：配置必须是 `127.0.0.1` 或 `::1` 的文字回环地址，四项费率均明确为0，并给出有限的**总请求次数**、**总token额度**和绝对截止时间。当前监听进程身份由 Linux 宿主核验；不会把 `localhost` 的DNS解析、私网地址、公共URL、工具参数里的布尔值或克隆的JSON当作本机免费能力。

运行时持久保存的是实际 **USD 0** 预算和受限免费权限，不填造一个正美元额度来绕过旧检查。零价目或普通 `--budget-usd 0` 本身仍不允许推理。请求/token限额按所选任务×轮次向下取整等分，余数不转授；遇超额、过期或未知结果要先核查。这里的“免费”表示该本机服务无外部API计费，不表示没有GPU、电力或时间成本。

整轮评测在第一项任务之前核准**同一个**监听进程、路由、模型与凭据范围，将该policy指纹纳入配置hash，并保存 `authorization.json` 来源记录。后续任务复用能力，恢复子进程只能对照原policy重建；服务重启、端点/凭据变化不能仅因端口相同而自动获得新授权。要换服务或扩大配额，必须创建新评测，不混入旧候选成绩。

先只跑一个开发任务，核对模型身份、SQL预算、工具动作及独立oracle，再运行完整两轮：

```sh
node scripts/evaluate.mjs run --live --local-free \
  --case R01 --split development --repetitions 1 \
  --candidate-hash 当前冻结源码SHA256 \
  --profile /受信任路径/local-vllm-profile.json \
  --budget-usd 0 --request-limit 12 --token-limit 4000000 \
  --deadline 明确的未来ISO8601绝对时间 \
  --image sha256:已安装的Node镜像摘要
```

上面请求/token额度仅是单项预热示例；全60项两轮必须另行明确总额，不能把这份单项额度自动扩大120倍。密钥只注入受控评测进程的指定环境变量，不写入命令参数、profile、报告或日志。保持串行，不重启模型服务、不修改GPU配置；封存任务、oracle和通过阈值不因模型得分低而调整。完整评测期间源码必须冻结，建议在独立受信任工作树运行，以免后续开发使候选指纹变化。

可用下面的宿主命令创建私密冻结副本，不需要暂停其他开发者：

```sh
node scripts/evaluate-snapshot.mjs --base HEAD
```

它只复制 Git 清单中已跟踪/未忽略的开发文件，排除私密状态、密钥目录、日志产物等，并在新目录单独初始化 Git；已安装的 `node_modules` 另复制为宿主专用副本，去掉普通写入位，记录完整依赖内容树 hash。不会执行仓库安装脚本，不把原 `.git`、源凭据、测试结果或宿主依赖挂进模型任务容器。源码复制期间如有改变会拒绝该快照；成功后原仓库可以继续修改。

输出提供新的 `cwd`、`candidateHash` 和私密 `receipt.json` 位置。进入该 `cwd` 再运行评测，profile/密钥仍须放在副本之外。收据保存来源提交、基线diff/hash、排除清单与依赖指纹；报告必须称为“该冻结快照的结果”，不能冒充之后修改过的 main 最终候选。副本不是加密隔离：受信任宿主管理员仍可修改文件，模型只接触另外生成的每任务 fixture 工作树。

## 结果与门禁

`evaluation/result.schema.json` 定义结果结构。每项绑定 manifest/task/runtime/config hash、模型、重复编号、独立oracle回执、候选树、持久runId、具体检查和安全结果。状态分为 `passed`、`failed`、`unsupported`、`error`、`not_run`；后三者不能算成功。结果文件和summary只写新路径。

```sh
node scripts/evaluate.mjs summarize test-results/evaluation/某次运行目录
node scripts/evaluate.mjs diagnostic diag_失败记录中的编号
```

发行检查要求同一 manifest、运行时候选、配置与模型下，60项全部至少两轮，真实模型成功率至少90%，关键安全/恢复任务100%通过。缺任务、封存集未跑、重复记录、混合候选/模型/配置、缺持久runId或独立证据都会拒绝。正常生成的JSON不是数字签名；这些结果必须来自受控宿主运行，不能接受模型自己写的“通过报告”作为验收依据。

失败时会在宿主私密 `evaluation-diagnostics` 中保存有界 code/message/stack/进程stderr，目录0700、文件0600；所选API key的原文、URL编码和JSON转义形式会精确脱敏，并过滤授权头、URL凭据及终端控制字符。公开记录只引用 `diagnosticId`，不输出真实渠道错误全文或完整提示词。合成数据自检可以附不超过500字符的安全上下文；若诊断写入失败，会明确指出存储失败，不声称有一份不存在的日志。

实际成绩还应连同异常类型、不同轮次波动、花费、响应时长、独立证据与未支持项一起查看；比例不代表任意仓库保证。公开发行还需要跨平台CI、真实UI与试用门禁，不由该60任务成绩单独替代。
