# 1.0.5 新增 CodeQL 告警核查

最新路径修复候选`634e308`的[CodeQL35995969121](https://github.com/kkelly-offical/kkcode/actions/runs/35995969121)
三类全部通过（真实Kotlin构建保留），开放17条历史告警、无新增；最近实例均指向
该SHA。回执`codeql-634e308-open.json`。规则和历史告警未被关闭或dismiss。

统一候选`9637f55`的[CodeQL35994312383](https://github.com/kkelly-offical/kkcode/actions/runs/35994312383)
三类全部通过（含真实Kotlin构建）；开放告警的最近实例均属于该SHA，仍为17条历史
告警、无新增64及以后编号。回执`codeql-9637f55-open.json`。未关闭规则或dismiss。

最近浏览器初始化候选`17688c9`的CodeQL `35987273151`也已三类全部通过，
开放告警仍为历史17条，无新增64及以后编号；回执`codeql-17688c9-open.json`。
未关闭规则或用dismiss消警。

本记录属于未发布的 **1.0.5-preview.0**。分析对象为 `49b2cce` 的 CodeQL 扫描：
扫描执行成功，但开放告警由稳定版基线的 **17 条**增至 **25 条**，新增编号
**64–71**。扫描成功不是“零风险”证明。

最新上下文修复候选 `8e1cbc8` 的
[CodeQL复扫35983776514](https://github.com/kkelly-offical/kkcode/actions/runs/35983776514)
已完成三类扫描，Kotlin仍为真实构建；开放17条历史告警，无64及以后新增开放告警。
回执：`test-results/preview-1.0.5/codeql-8e1cbc-open.json`。这不代表历史告警无害。

以下记录逐条根因、代码处理与实际回归。前一候选 `762267a` 的
[CodeQL 复扫 35979843871](https://github.com/kkelly-offical/kkcode/actions/runs/35979843871)
三种语言任务全部完成（Kotlin 为真实手工构建）；该分支开放告警回到历史 **17 条**，
新增64–72均不在开放列表。没有关闭规则或dismiss告警，历史17条不因此视为无害。
本地回执为 `test-results/preview-1.0.5/codeql-762267a-open.json`。
随后上下文修复由上方8e1cbc独立复扫，不直接继承这个SHA的验收结果。

历史候选 `8008e58` 的
[CodeQL 复扫 35973390165](https://github.com/kkelly-offical/kkcode/actions/runs/35973390165)
三种语言任务全部完成（Kotlin 为真实手工构建）。该分支的开放告警由25条降为18条：
64–71已不在开放列表中，历史17条仍在，另新增测试fixture告警72。没有将扫描成功
冒充零告警，也没有称该候选已发行。
没有关闭规则、扩大忽略范围或用 dismissal 消除这 8 条告警。此前 17 条仅作为
历史基线记录，不据此认定它们无害；发现真实严重问题仍需处理。

## 逐项判定

| 告警 | 规则 / 位置 | 实证与处理 |
| --- | --- | --- |
| [64](https://github.com/kkelly-offical/kkcode/security/code-scanning/64) | `js/redos`；`src/config/load-config.mjs` | **真实 ReDoS**。策略环境变量键的重复组与包含 `_` 的字符类重叠。固定前缀后 `0__` 重复 1,024 次再接非法末尾字符，原正则子进程超过 500 ms 被终止；约 3 KiB 输入就可阻塞。将本就可涵盖完整后缀的重复组改为单个可选组，消除歧义回溯，保持合法键语义。真实 loader 在有截止时间的子进程中拒绝恶意键、保持 deny-all、不泄露 canary。 |
| [65](https://github.com/kkelly-offical/kkcode/security/code-scanning/65) | `js/path-injection`；`src/kernel/tool/operation-journal.mjs` | 数据流为 RPC 输入 → 产物回收状态检查 → 操作日志文件读取。原先 ASCII 字母／数字／`_`／`-` 白名单已禁止点和斜杠，**未复现路径穿越**；告警未识别完整 guard。现从白名单匹配结果构造 basename，并要求匹配与原串完全相等，也拒绝旧 `$` 锚点允许的末尾换行。合法历史文件名不变。真实已登录 RPC 的穿越、反斜杠、编码、换行、对象／数组输入均拒绝，外部 canary 不变且不返回；真实未决操作仍阻止回收。 |
| [66](https://github.com/kkelly-offical/kkcode/security/code-scanning/66) | `js/resource-exhaustion`；`src/storage/artifact-store.mjs` | HTTP / Relay 请求中的 `limit` 到 Buffer 分配。原代码已在闭包外要求安全整数且最大 **1 MiB**，因此不是无限请求大小分配；完整范围／游标／元数据校验也已存在。现把容量选择显式写为固定 **0、4 KiB、64 KiB、256 KiB、1 MiB** 桶，并在分配点重检实际读取大小。只编码已读取部分，绝不返回桶的 padding。边界、超限、Infinity、NaN、字符串输入与尾页精确字节均有回归。 |
| [67](https://github.com/kkelly-offical/kkcode/security/code-scanning/67) | `js/unvalidated-dynamic-method-call`；`test/network-hardening.test.mjs` | **测试 HTTP fixture 的真实不安全派发写法**：URL 决定普通对象上的函数名，未知／原型属性可异常。不是产品压缩接口。改为预先生成三种压缩数据的 Map；请求只选择固定数据，不动态调用方法。`constructor`、`__proto__`、`toString`、未知路径明确 404，正常三种解压仍通过。 |
| [68](https://github.com/kkelly-offical/kkcode/security/code-scanning/68) | `js/insufficient-password-hash`；`src/kernel/orchestration/run-coordinator.mjs` | 告警 source 为 `apiKeyEnv`／`api_key_env`，实际是**环境变量名称**，不是用于登录验证的密码。SHA-256 不承担密码存储功能，不应改成无意义的密码 KDF。另发现该名称摘要不能体现实际 key 值轮换：现 route identity 复用已批准路由的 HMAC `scopeHash`，只保存 provider/model/opaque scope；实际 key 轮换会改变范围，不持久化原 key。 |
| [69](https://github.com/kkelly-offical/kkcode/security/code-scanning/69) | `js/insufficient-password-hash`；`src/kernel/session/independent-review.mjs` | 不是密码验证库，但原审查 scope 对整个 provider 对象做摘要，其中可能包含 inline key，且 env 名称不反映值变化。改为在审查 try 内复用精确端点／协议／模型／实际凭据的 HMAC 路由范围，只投影不透明 scope；不再把整个 provider 配置喂给通用内容摘要。无效地址或请求异常返回 `unknown`，不会在 catch 外再次抛错，也不把凭据写进回执。 |
| [70](https://github.com/kkelly-offical/kkcode/security/code-scanning/70)、[71](https://github.com/kkelly-offical/kkcode/security/code-scanning/71) | `js/incomplete-url-substring-sanitization`；`test/office-service.test.mjs` | 原意是对 Python PDF inspector 产生的 **URI 数组**做 `Array.includes` 精确成员检查，不是 `String.includes` URL 防火墙；但缺少显式数组断言，规则无法区分，错误的字符串返回也可能让测试过宽。现先要求数组，再与两个完整预期 URI 做 `deepEqual`，不允许前后缀、不同 host/path 或额外链接混过。真实固定镜像 Markdown → PDF 的可点击链接回归通过。 |

## 凭据范围与内容指纹不能混用

本次没有将内容指纹当作账户认证。候选树、非秘密输入或回执内容的 SHA-256 仍是
内容身份标识，不是密码验证器。实际 provider 凭据使用既有 `routeBudgetScope`
协议绑定的 HMAC 范围，服务端凭据本身不输出。环境变量名只是来源配置，不应被
误称为密码，也不应单靠它判断真实凭据有没有变化。

审查回归使用合成凭据，验证同一变量的不同值、inline key 切换会变更范围，普通
timeout 配置变化不会；公开回执不包含环境变量名、合成 key 或原始异常中的 key。
所有测试均未调用真实收费模型或使用旧聊天中的凭据。

后续全量覆盖率发现独立审查不应复用只支持部分协议的“模型目录”解析器：内存
Ultra fixture 缺少路由身份，真实 Ollama 也不属于该目录协议。现由
`roleProviderEndpoint` 解析明确的推理端点，并继续用 `routeBudgetScope` 生成同一
HMAC 范围；凭据优先级与推理保持一致（inline key、非空显式 env、配置 env）。
fixture 补上保留 `.invalid` 地址与协议，不联网；真实 loopback Ollama HTTP 测试
验证无工具审查可执行，缺少／非法 URL 仍为 `unknown`。本次没有扩展严格任务
预算或模型目录本身的协议支持，也没有把缺失审查视为通过。随后独立的预算兼容修复
让严格预算与实际推理共用 `route-settings`，已补Ollama真实HTTP/NDJSON回归；
不要把这里记录的初次修复范围误读为当前预算仍不支持Ollama。该后续组合结果见
[实施账本](implementation-1.0.5.md)，仍不等于付费服务或任意兼容端点已验收。

## 历史高风险数据流复查

本轮另外核查旧告警 #20、#21、#43、#54、#55，没有把历史基线直接视为安全。
`remote/client` 原有 HTTP 与 WebSocket 禁跟随重定向，但发现一个不同的真实缺口：
登录／刷新令牌响应中的额外 `gateway` 字段可以覆盖已选网关。真实双 HTTP fixture
在修复前证实下一次刷新把合成 refresh token 发到了另一端点。现在钉住调用前的
规范网关，并只接收 access_token、refresh_token、token_type、expires_in 和原有 profile；
profile 不作为网络地址。明确 public discovery 的规范网关选择保持原有流程。

新增 `test/legacy-provider-boundaries.test.mjs` 验证：令牌响应不能改目的地，真实
WebSocket 307 不转发 bearer，模型目录跨来源分页零访问，目录缓存的密钥轮换隔离、
不保存原文 key、命中前仍检查出域策略。连同已有网关／模型／SSO／SSE 回归 32/32 通过。
目录摘要用于缓存命名空间而非密码认证，没有无意义地替换为密码 KDF，也没有为消除
SSRF 告警而禁掉用户明确配置的合法内网。静态告警的状态仍以新扫描为准。

其余历史路径告警 #30–35、#37、#39–41、#56 及文件引用 #19 也进行了入口到文件
操作的复查。发现并修复远控预览的硬链接缺口：普通工作区名字可硬链接到 `.ssh`、
KK Code 私密状态或授权范围外文件，原 `realpath` 无法识别这种别名。现在打开前、
打开的 fd／当前叶子和读后均要求单链接，非阻塞打开同时避免被替换成 FIFO 后卡住。
这是多链接拒绝，不是内容 DLP，也不能阻止有权限的本机用户自行复制敏感内容。

CLI `@` 文件引用原先会对 FIFO 调用同步全文件读取。实际子进程在旧实现中超时；
现在 fd 级确认普通文件、非阻塞打开且最多读取限额加一字节。保留显式普通文件
symlink 与原自定义引用转义语法；测试覆盖 stat/open 之间类型替换及读取时增长。
新增路径专项连同 mention／重放／身份／解绑回归 **100/100** 通过。

其余已检查链路中，规范 ASCII session ID、固定私密根、owner/share 入口鉴权、
Replay 的 nofollow／nlink／inode 检查及原子替换已提供相应边界；本轮未复现远程
越权。私密父目录被同一 OS 账号任意篡改，不是这些单独文件 helper 能完整防御的
情形。没有据此关闭告警或宣称其余路径绝无风险。

## 后续告警 72

`8008e58` 的新告警为 `test/independent-review.test.mjs` 中测试 HTTP 服务将
异常文本返回给客户端（`js/xss-through-exception`）。这是临时 loopback fixture，
不是产品服务，但回显异常的写法确实不妥。现改为固定 JSON 错误，所有响应明确
`application/json`／`nosniff`；原异常仅留在测试进程并用 `assert.ifError` 报告，
不会被静默吞掉。9/9专项通过；`762267a` 的三语言复扫已完成，72不在该分支
开放告警列表中。该结论只绑定上述候选，不预先覆盖后续代码。

## 本地回执

对应命令及本次实跑结果：

```sh
node --test test/codeql-config-journal.test.mjs
# 3/3；独立复跑实际 loader 拒绝恶意声明约 9 ms。

node --test test/artifact-store.test.mjs test/network-hardening.test.mjs
# 43/43；含固定 Buffer 桶、越界拒绝及未知压缩 fixture 路径。

node --test test/independent-review.test.mjs
# 9/9；凭据轮换／优先级、范围、无效路由、真实Ollama HTTP及完整审查证据。

node --test test/independent-review.test.mjs test/ultra-host-acceptance.test.mjs
# 22/22；保留严格Ultra的completed断言和所有不确定/候选变化拒绝路径。

node --test test/tool-artifacts.test.mjs test/device-artifacts.test.mjs
# 21/21；真实工具循环、HTTP/Relay、跨账号与撤销、分页和回收。
```

另外，协调器实际路由范围的两个专项测试通过；网络作者复跑配置策略／日志相关
组合 14 项通过。Office 使用本机固定镜像
`sha256:55f94f2ab8d5e0e26f95b01c1dad4b02405ede6f08ff441c2621b9fb57bee1ff`：

```sh
KKCODE_OFFICE_TEST_IMAGE=sha256:55f94f2ab8d5e0e26f95b01c1dad4b02405ede6f08ff441c2621b9fb57bee1ff \
node --test --test-name-pattern='Markdown export preserves' test/office-service.test.mjs
# 1/1，实际解析导出 PDF 的 URI 注解，不是模拟返回值。
```

相关 ESLint、全局 typecheck 和 `git diff --check` 通过。上述是本地功能／安全回归，
独立于上方列明的 CodeQL 复扫回执，也不替代真实浏览器或发行门禁。
后续复扫应同时核对 64–71 的实际状态与是否引入新的告警，再记录结果；不只看扫描
工作流的绿色状态或总数。
