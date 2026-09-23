# KK Code 1.0.4 Preview 实施与验收记录

状态：实现与候选验收完成；用户已批准合入 main 并公开发布，正在执行发布门禁。技术版本：`1.0.4-preview.0`；稳定版 `1.0.3`
及其标签不变。下列未打勾事项不能被描述为已交付。

## 本轮范围

- [x] 完整请求上下文计量（系统、工具、历史、媒体、输出预留），修复压缩触发遗漏。
- [x] 提示词内容指纹、实例隔离、真实能力/模式描述、来源/信任标记与诊断。
- [x] 公共 SDK 类型声明、强类型 RPC 与统一实时事件传输；外部消费者验收。
- [x] Web / Android 显示当前上下文使用量、窗口上限和估算/实测来源。
- [x] 账号级 SSH 连接资料，与 Relay 设备并列管理，凭据不上传持久化存储。
- [x] SSH 受控进程与前端连接生命周期解耦：退出客户端不中断在途任务，重进恢复。
- [x] Web / Android 顶部设备切换、连接管理、独立断开/返回入口。
- [x] 会话三点菜单简化为改名、归档/恢复、删除；危险操作明确确认并多端同步。
- [x] MCP OAuth 与 ACP 适配，保持现有 MCP/CLI/headless 契约。
- [x] 受控浏览器开发能力、工具组合及操作恢复/无进展治理的验证。
- [x] README、子文档、版本与实际验收记录更新。
- [x] 全量 Node / Web / Android / 打包与跨平台验收，生成 Preview 产物。

## 安全与兼容边界

1. 原 `kkcode remote` 继续保持前台生命周期；SSH 启动的受控服务单独定义
   “断线后排空正在执行的任务”语义，不把所有远控静默改成常驻守护进程。
2. 账号只同步 SSH 名称、地址、端口、用户名及已确认主机指纹等连接资料。
   私钥、密码、模型凭据不进入账号资料、源码、日志或诊断导出。
3. 用户已选择：SSH 仅 Android 直连，Web 本轮不新增 SSH；网关只同步
   账号连接资料，不代连 SSH，也不接收 SSH 私钥或密码。
4. 删除会话不删除用户工作区文件；正在运行的会话不静默取消或删除。
5. 保留稳定 headless JSONL schema、既有 SDK 导入路径和 1.0.x 版本约束。
6. 提示词与工具说明只根据真实运行时能力生成；外部文本不升级为系统指令。

## 验收记录

开发开始基线：`8af9d29`，工作树干净。具体命令、通过/失败、平台和产物
将在运行后记录；不沿用 1.0.3 历史测试数冒充本轮结果。

### 开发中间记录（不代表发布验收完成）

- 已增加完整请求计量、每实例提示缓存/内容指纹、按需工具说明与内置工具发现。
- 已增加 SDK 严格类型消费测试；实时事件解析迁入 SDK，Web 复用。
- Web/Android 上下文展示、简单会话菜单、设备条与会话删除已接线。
- SSH 地址簿只存账号元数据，新增并发修订检查；Android 继续 SSH 直连。
- SSH 后台宿主保留在途回合，75 秒无客户端活动且无任务时退出；受认证的
  本地控制通道签发一次性重连票据。可复用兼容版本的前台 Remote 宿主，但
  目录范围必须一致，前台 Remote 的终端退出规则不变。
- 两轮 Android debug 编译及现有 JVM 单测通过；尚未完成本轮模拟器/真实 SSH 验收。
- 首轮 Node 全量 2930 测试出现 8 个失败（含父套件）：来自工具延迟发现与
  旧 usage 事件快照。已保留旧 usage 事件形状、另增 context 事件，并更新
  工具发现端到端测试；相关 13 个回归已通过，待全量重跑。
- 上述是早期中间状态；后续已补齐 MCP OAuth/ACP、浏览器开发能力与 Harness
  轨迹治理，具体证据如下。始终未公开发布。

### 本轮已执行证据

- Node 第二轮修正了旧快照/工具发现假设；第三轮 `npm test`：2943 tests、
  2941 pass、0 fail、2 skip。后续又补了 ACP stdio、辅助 Web 服务所有权等回归，
  正在跑最终 coverage/e2e/打包门禁；此处不提前写其结果。
- `npm run test:web` 通过：真实 Device API 双客户端改名/归档/恢复/回退/删除，
  上下文详情、媒体、分支/Worktree、320px 窄屏和设置层级。像素主题对比的
  154 个原控件矩形位置不变。新增 meter/设备条为本轮明确新增的功能区域。
- Android debug/JVM/测试 APK 编译通过。35 项旧+新 UI 测试一轮通过；增加
  账号 SSH 缓存测试及切换 Preview 默认渠道后，正在重跑完整 36 项。
- 官方 ACP 客户端驱动真实内核完成创建/加载、编辑审批、流状态、模式和取消；
  真实 CLI stdio 测试确认 stdout 只有协议，并拒绝未信任的编辑器 MCP 启动。
- MCP OAuth 使用官方 SDK 本地 HTTP 服务实测 PKCE、错误 state/issuer、令牌加密、
  自动刷新、超时/取消；issuer 不匹配时不交换授权码。加密仓库测试覆盖并发更新、
  多 namespace 同时初始化及篡改拒绝。
- Browser 真 Chromium：默认拒绝 WebSocket；显式开发模式同源 echo/HMR 路径成功，
  跨私网来源/metadata 被拒，390px 真实 PNG 截图和有界诊断通过。
- `scripts/lab-ha-smoke.mjs`：两个独立候选网关进程 + 真实 PostgreSQL 临时数据库；
  SSH 地址簿跨节点读取、并发 revision 200/409、凭据字段拒绝；DB 连接中断、
  网关 SIGKILL/重启、跨节点单次 refresh 与撤销通过。仅清理本次临时数据库/进程。
- `scripts/ssh-lifecycle-smoke.mjs`：独立 QA VM `192.168.122.8`，临时安装 npm 包，
  不覆盖已有安装，不动示范机 `192.168.122.111`。真实 SSH 隧道全部关闭后回合继续；
  重连观察 running，断开等待完成，再重连读回完整结果与 context。Android 原生
  SSHJ 重复此流程通过；随后 75 秒无任务/无活动，后台宿主确实退出。
  模型是明确的慢响应测试服务，不冒充真实 Qwen 推理质量验收。
- `node scripts/harness-benchmark.mjs 300`：300 离线回合，0 监听器增长；同一当前
  注册表对照，eager 40 工具/完整手册输入估计 27302 tokens，默认 deferred 15
  工具/紧凑手册 8994 tokens，P50 75ms / P95 93ms（Linux、Node 24.15.0）。
  不包括真实模型网络延迟，不能用来宣称击败任何竞品。
- APK 10007 已用原发布证书生成/校验 v2+v3；候选最终重建、覆盖安装和更新清单
  的散列将在全部源码收尾后写入，不能把中间 APK 的散列当成最终产物。

### 发现与修正过程

- 上下文遗漏 `messagesTransform`，已改为按实际送出的插件转换后请求计量。
- 原完成验证会隐式执行项目脚本，现自动收尾只看任务状态，命令走正常工具审批。
- 删除最初只检查直接子任务，现递归阻挡活动后代/后台工作并备份删除整个会话树。
- SSH 辅助 Web 服务失败/关闭不应关闭前台 Remote 内核，已拆开服务所有权。
- SSH 握手原 readLine 无界，现逐字符限制 4 KiB；客户端选择切换与资料同步补世代/
  账号检查，防止迟到响应覆盖另一设备/账号状态。
- Preview 的更新测试不能假设初始渠道永远是 stable；测试现显式切换，未放宽验收。
- Node 浏览器兼容 fetch 会忽略 Host 覆盖，真实 SSH 测试改用 SDK 可注入的 Node
  HTTP 传输保留目标 Host；服务端 Host/Origin 校验不削弱。
- macOS 首轮失败是测试夹具 `/var` 与 `/private/var` 别名比较，已对临时目录先
  realpath，保留真实文件身份断言，未削弱运行时权限。Linux 两个 Node 版本通过；
  新提交正在重跑整个跨平台矩阵。首轮 JS/Actions/Kotlin CodeQL 全部通过。
- 补充原生 ViewModel 验收：真实 SSH 配对令牌失效后，自动重建连接并恢复同一
  正在运行的会话，直至收到完成结果；不把仅手动重连当成 App 自动恢复。
- 本机 SSH 凭据绑定具体主机/端口/用户/指纹，防止地址簿变更导致旧密码自动用于
  新目标。并发地址簿同步保留期间新建/编辑的本机记录；显式移除串行处理。
- 操作恢复区分“调用前已拒绝”和“执行后结果未知”：缺引擎、授权未完成等可在
  配置修好后重试；MCP 传输断开不再误当成已经确认没有副作用的错误结果。
- 无认证本地模型夹具需要显式 `api_key_env: ""`；错误配置曾导致验收失败，
  修正夹具并重跑通过，未放行明文凭据。模型配置错误在 UI 改为可读的 422 提示。

### 交付边界

- 本轮 Linux 发布门禁、Windows/macOS 专用分支 CI、最终签名 APK/容器验收已完成。
- 公共 npm preview / GitHub prerelease、main 合并以及生产网关升级均尚未执行。
- 生产 SSO 租户策略、实体手机 OEM 行为、停电/OS 杀进程恢复仍不是本次夹具测试
  能证明的事项。MCP OAuth 不含 Web/App 回调代理；ACP 不含全部 IDE 可选能力。

### 最终候选门禁（已完成，不代表公开发布）

代码验收分支：`acceptance/1.0.4-preview.0`。最终验收提交 `a9cdb77`（生产实现
`9350b97`，另含 SDK nullable 类型及跨平台夹具修正）；main
仍为 `8af9d29`，没有合并或更新公开 npm/GitHub 标签。

| 验收 | 当前结果 |
| --- | --- |
| `npm run release:verify` | 本机通过：lint、导入环、内核/Web 类型、Web 构建、秘密扫描、coverage、e2e、全新目录 npm 安装 |
| Node coverage | 2947 tests，2945 pass，0 fail，2 平台条件 skip；行 82.99%，分支 79.36%，函数 80.98% |
| 单独 e2e 复跑 | 33 / 33，包括 headless JSONL 契约 |
| Web 三组验收 | 真实双客户端 + 功能契约 + 154 控件主题几何检查通过 |
| 跨平台 CI | macOS Node 22、Windows Node 22、Linux Node 22/24：全部通过 |
| Android JVM | 61 项，0 失败 |
| Android 原生 UI / HTTP | 36 项通过；另有真实 SSH + ViewModel 自动配对恢复集成通过 |
| 正式签名 APK | `10007`，v2/v3、原项目证书、不可调试、覆盖安装/启动通过 |
| 真实 SSH | 关闭所有连接时继续执行；原生自动重新配对恢复同会话；最终 75 秒排空退出；测试模型服务已停止 |
| 双网关 + PostgreSQL | 地址簿 CAS、故障恢复、跨节点刷新/撤销通过；专用数据库已清理 |
| 生产依赖审计 | 官方 npm registry，0 漏洞；本机镜像 registry 无 audit 接口，未把它的 404 算作通过 |
| npm 不可变产物校验 | 539 个文件，独立安装后秘密扫描通过 |
| 容器 | `kkcode-gateway:1.0.4-preview.0` 构建与版本入口检查通过；未推镜像仓库或部署生产 |

APK SHA-256：`6036dcd054b0856fde11042f142afddea6231f285fa6e551c71754a6af7c44ea`。
证书 SHA-256：`cf75774a4d87ba1ccc4a811f271bd301076cf6beefd7432a3cb30231164be5d1`。
更新清单 `android-update.json` 已生成，GitHub 更新源尚未有这份候选公开资产。

[9350b97 的三语言 CodeQL](https://github.com/kkelly-offical/kkcode/actions/runs/35861249850)
已全部成功（Kotlin 为真实构建）。候选与 main 的开放告警编号完全相同，共 17 项：
19、20、21、30–35、37、39–41、43、54–56。它们沿用
[历史逐类复核](security-review-1.0.2.md)，没有关闭查询、排除生产目录或批量 dismiss。
“扫描执行成功”不是“零告警”，也不是生产安全认证。

[上一轮跨平台](https://github.com/kkelly-offical/kkcode/actions/runs/35861249529)
的 macOS、Linux 22/24 已通过；Windows 发布门禁通过，最后 Web 的检出文件
字节断言被全局 autocrlf 转成 CRLF。现仅在专用临时仓库固定 autocrlf/eol，
不修改用户设置、不跳过字节检查。

最终 `a9cdb77` 的 [四平台矩阵 35862885455](https://github.com/kkelly-offical/kkcode/actions/runs/35862885455)
全部成功；同提交的 [三语言 CodeQL 35862887053](https://github.com/kkelly-offical/kkcode/actions/runs/35862887053)
全部成功。SDK 严格消费、完整安装包扫描与 Web 三组验收均在矩阵执行。
后续本次提交仅补文档回执，不改变已验收的运行时代码/构建配置。

本机交付目录：`test-results/preview-1.0.4/`，包含
`kkelly-offical-kkcode-1.0.4-preview.0.tgz`、`kkcode-android-1.0.4-preview.0.apk`
和 `android-update.json`；APK 散列/证书如上。容器标签是本机
`kkcode-gateway:1.0.4-preview.0`。安装包内的验收记录对应打包时刻，完整收尾回执
以本仓库为准。以上记录为候选验收时的状态；当时没有创建版本标签、发布
npm/GitHub Release、合并 main 或部署生产。

### 公开发布授权（2026-09-23）

用户已明确批准「推送发布 preview」。本轮将已验收代码合入 main，再运行 main
验证/CodeQL 和 tag 发布门禁。npm 仅推进 `preview`；GitHub 标记为 prerelease，
不移动稳定 `latest` / `v1.0.3`。APK 使用已验收的 `10007` 与原项目证书。
不部署生产网关，不升级示范主机。发布成功后在本节补记实际提交、Actions、
公开产物与下载复核结果；本授权记录不是已发布回执。
