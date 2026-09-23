# 1.0.4 正式版修复与发布账本

状态：代码验收完成，正在准备正式发布，尚未取得公开发布回执。用户将第二预览版请求调整为：补齐 OpenAI
Responses API 协议与全部交互修复后，发布完整正式版 `1.0.4`，Android `10008`，
保留原项目证书。未发布过 `1.0.4-preview.1`。
基线为 main `57379a1`；分支 `acceptance/1.0.4-stable`。
当前稳定 `latest` 仍为 `1.0.3`；验收后推进到 `1.0.4`，不移动任何旧标签。

## 用户反馈与已定位原因

- 空“新对话”：旧客户端先创建记录，再单独配置模型。后一步失败仍留下空记录；
  列表未区分草稿与有内容的会话。修复不删除既有历史，只增加有内容标记和显示过滤。
- SSH 的 Bad Request / Internal Server Error：真实本地 HTTP 复现确认 Fastify
  错误处理器注册在 awaited static 插件之后，既有路由仍走默认错误处理器；
  Android/SDK 又只读取 `error` 而忽略平铺 `message` 与 `code`，丢掉真正原因。
- 跨设备污染：Android 切换网关/SSH 时未重置模型、渠道、目录相关缓存；
  新机器会收到上一台机器的渠道名。异步 RPC 返回也需要设备代次校验。
- SSH 并列导航：设备条点击当前 SSH 仍会重新进入连接流程；上层添加连接重复
  提供 SSH，而下方已存在 SSH 独立入口。
- 来源链接：Android 选择文本与 Markdown 未统一可点击链接处理；需要显式
  浏览器打开策略，禁止 file/javascript/intent 等链接触发本地操作。
  新增原生点击测试又捕获 Linkify 清除 Markwon URLSpan 的冲突：明文网址可点、
  带标题的 Markdown 来源丢失。改为在独立文本中识别网址，只合并不重叠范围。
- 渠道编辑：Android 把脱敏的 API Key 填回表单并可能重新保存；现改为留空保留。
  未改地址/协议时通过已保存渠道发现，不把遮罩或空 Key 当真密钥发送。
  新建表单显式空 Key 不再借用宿主环境变量中的另一套 OpenAI 凭据。
- Thinking：Android 忽略 thinking.start，尚无 token 时的等待占位不可点击；
  展开后新增 token 的自动滚动可能打断阅读，长内容在 20k 字符后不再更新显示。
- 完成后的工具、思考、过程说明一直占据对话区：增加纯呈现层折叠，最终报告保持
  独立，活动/失败过程不冒充已成功完成；原始历史仍保留并可展开。

## 工作清单

- [x] 设备/网关提前注册错误处理器，SDK 与 Android 兼容旧平铺错误响应。
- [x] 模型发现区分渠道缺失、凭据、Base URL、404、网络不可达，提供中文操作建议。
- [x] 新建会话先校验选择；保持旧设备兼容；有内容标记与空会话显示过滤。
- [x] Android 设备切换清理状态、忽略过期 RPC、点击已连接设备不重复连接。
- [x] 网关与 SSH 添加入口分开，SSH 仍仅 Android 直连，不新增 Web SSH。
- [x] HTTP(S) 来源链接与明文网址支持浏览器打开，不自动访问远程来源。
- [x] Thinking 开始即有可展开条目，持续流式更新；已完成过程可折叠查看。
- [x] 新增 Node/JVM/原生 UI/Web 交互回归全部通过。
- [x] 完整本机发布门禁、真实 SSH 生命周期、跨平台 CI 和 CodeQL。
- [x] 同证书 APK 10008 构建、覆盖安装、更新清单验证。
- [x] Responses API 协议、配置/模型发现、流式文本/思考摘要/工具、图片与请求恢复验收。
- [ ] 合入 main、发布 npm latest / GitHub stable、公开下载与安装复核。

未勾选项目不得描述为已完成。本轮不自动升级生产网关或「KK主机 1 号位」。
候选测试中遇到的问题与实际公开发布回执在验收后追加，不沿用上一版测试数。

## Responses 实现与验收边界

新增 `openai-responses` / `protocol: responses`，配置、目录发现、CLI/Web/Android
选择器共用设备侧路由。支持 SSE/JSON、文本/图片、Function 参数与结果、思考摘要、
用量、来源，以及 `store: false` 的加密续接/assistant phase。原生状态按模型、
Base URL、凭据和可见内容指纹隔离；投影到远端时移除。流中断不执行半截工具，
首个输出前最多 5 次重试，部分输出后不重放。未实现托管工具/音视频/Background/WebSocket。

真实本地 HTTP 契约服务运行完整 Kernel → Responses → 受控 read 工具 → 回传 →
最终回答 → 后续会话，另测错误参数、交错工具、重试/取消/超时和隐私隔离。
这不是官方 OpenAI 生产账号实测，没有使用或申请新的 OpenAI API Key。
接入时发现 SDK 可选 session/provider/model 未落默认值、上下文预算使用截短预览的
问题，同时修复；CLI/headless JSONL 的既有契约仍需全量回归保持。

## 本机阶段记录（2026-09-24）

- 真实 SSH：专用 `kkcode-101-linux` 验收 VM，临时隔离安装，不覆盖已安装 CLI。
  Node 与 Android SSHJ 两条链路均完成全断线、执行中重连、无客户端时结束、历史/
  上下文恢复，最后 75 秒无活动排空退出。生产主机与网关未改动。
- 第一轮本机发布门禁：2965 项 Node（2963 通过、0 失败、2 条件跳过）、覆盖率
  83.04% 行 / 79.40% 分支 / 81.23% 函数、E2E 33、安装包 544 文件扫描与 SDK 导入。
  后续补了渠道表单原生/浏览器回归，最终数目以冻结后的门禁为准。
- 原生 41 项界面回归通过后继续补 Responses 表单与密钥保留用例；不能把尚未复跑
  的新用例计入已通过数量。同证书 10008 已能从预览 10007 覆盖安装，最终 APK
  仍需按冻结源码重新签名和校验，不沿用中途候选的摘要。
- 冻结候选补测：协议/远端 UX/CLI 表单 24 项通过，Android JVM 67 项、原生 UI
  42 项通过（包含 Markdown/裸网址浏览器 Intent、Responses 发现及空 Key 保留）。
  Web 三组验收通过，130 个控件矩形与原布局一致；协议兼容 45 项，真实 Browser 4 项。
  首轮候选 APK `10008` V2/V3 同证书验证及覆盖启动通过，非调试包；SHA-256
  `71dcb0b9d35dc74d7e8b98de1675dbbf59a31c43f17defd558babfcda36ce109`。
  证书 SHA-256 `cf75774a4d87ba1ccc4a811f271bd301076cf6beefd7432a3cb30231164be5d1`。
  `android-update.json` 对应 stable 1.0.4/10008；公开上传/下载尚待发布门禁。
- 第一候选 `aebb8d0`：四平台验收 `35888243251`、三语言 CodeQL `35888243184`
  全通过。冻结回归 Node 2966（2964 通过 / 0 失败 / 2 条件跳过），E2E 33；
  覆盖率 83.08% 行 / 79.42% 分支 / 81.21% 函数；包扫描 544 文件。
  官方 npm 生产依赖审计 0 漏洞。签名 App 的实际 UpdatePolicy 接受正式版的两个渠道。
- 后续复核补齐等待占位 → 首段 thinking 的展开状态衔接，输出正文/审批时不重复显示
  thinking 占位；Android 原生回归扩至 43 项。新协议连续性作用域由通用摘要明确为
  域分隔 HMAC，保留原 CodeQL 规则再扫描（[安全说明](security-review-1.0.4.md)）。
  上述后续代码必须经过新一轮验收，重新构建最终 APK，不使用首候选摘要公开发布。
- Android 最终复跑 JVM 67、原生 UI 43 全通过；重签与覆盖安装通过。待发布 APK
  SHA-256 更新为 `d00cd98d7c55451645a57a804c314e794211e0ef424e0d03b644b48053d89ae0`，
  与更新清单一致，生产 UpdatePolicy 的 stable/preview 均接受 10008。
  网关镜像可用非 root 用户构建/启动，隔离容器 OIDC/Relay/SSE 6 项通过。
- 额外异常流测试确认容量检查须在 SSE 分帧前执行：无换行的畸形连续流也受 16 MiB
  原始字节上限约束，不等到完整事件才检查。没有修改其他协议的 SSE 输出契约。

## 最终候选门禁

- 代码 `a019518186979099e3397cf3dda83e0b9c04dd8d`；
  [四平台完整验收](https://github.com/kkelly-offical/kkcode/actions/runs/35890249375)
  全通过（Linux Node 22/24、Windows Node 22、macOS Node 22，各自包含 Web 验收）。
- [CodeQL](https://github.com/kkelly-offical/kkcode/actions/runs/35890250353)
  Actions、JavaScript/TypeScript、真实 Android/Kotlin 构建全通过。无新增开放告警，
  17 条历史告警保留；新增 #63 经代码明确化后不再出现，未关闭任何安全规则。
- 本机最终门禁：Node 2966（2964 通过、0 失败、2 条件跳过），E2E 33；
  覆盖率 83.06% 行、79.46% 分支、81.21% 函数。545 文件包扫描和安装后 SDK 导入通过。
  Android JVM 67 / UI 43；Web 三组和 130 控件布局一致性；协议兼容 45 / Browser 4。
- 最终 Node 22 非 root 镜像内 Responses + OIDC + Relay + SSE **17/17**；
  镜像 ID `sha256:098d316f1a365e3f3ab047111596984b947471fbe3c2f86c636c7a029b9f42fb`。
  这是本机构建与隔离测试，不是公开镜像仓库上传或生产部署。
- 真实 SSH 最终复跑全部通过，签名 APK `d00cd98…d89ae0` 与清单已锁定。
  日志、APK、清单、生产 UpdatePolicy 验证在 `test-results/stable-1.0.4/`。
- 发布前只读检查 `https://coding.internal.zzheng.cn/health` 返回
  `1.0.4-preview.0`，没有升级该生产服务或「KK主机 1 号位」。

后续 main 更新只整理发行说明与回执，不修改上述已验收程序、测试或 Android 源码。
