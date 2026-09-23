# KK Code 1.0.4 Preview 0

技术版本 `1.0.4-preview.0`，Android versionCode `10007`。
本版使用 npm `preview` 渠道和 GitHub 预发布；稳定版仍是 `1.0.3`。
实际测试、产物和发布回执以 [实施账本](implementation-1.0.4.md) 为准。

## 安装与更新

```sh
npm install -g @kkelly-offical/kkcode@1.0.4-preview.0
kkcode --version
```

也可用 `@preview` 跟随预览渠道。Android 在更新设置中选择 Preview，或从
[本版 Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.4-preview.0)
下载 `kkcode-android-1.0.4-preview.0.apk`；同证书覆盖安装，无需卸载，
但仍需 Android 系统确认。Release 同时提供 `android-update.json`、校验值与 SBOM。

## 对话和设备

- Web 与 Android 在输入框上方显示当前上下文 tokens、窗口上限、百分比；
  点击查看来源及输出预留。它不是累计账单。旧设备没有计量数据时不伪造百分比。
- 会话三点菜单只有改名、归档/恢复、删除。名称输入与删除确认按需出现。
  回退仍在消息上，文件/Git 回滚不是删除或回退对话的一部分。
- 删除需要确认，正在执行的主回合、子任务、后台任务不能被静默删除。
  完成后的子会话随主会话一起移出索引；原工作区文件不变。被控电脑私密状态中的
  `trash/sessions/` 保留恢复 JSON，包含主会话及子会话；不是不可恢复的安全擦除。
  当前没有恢复按钮或自动清空回收副本，请由设备所有者备份/管理这些本地文件。
- 多台设备时，顶部显示可横向滚动的设备条。切换设备不会取消另一台机器的任务。
  连接设置仍收在菜单中，启动不弹大表单。

## Android SSH 与企业网关

用户已选定：**SSH 仅 Android 直连，Web 本轮不增加 SSH，也不由网关代连。**

Android 的网关设备与 SSH 连接并列。SSH 名称、主机、端口、用户、已确认指纹、
目录范围可以跟随账号同步；密码和私钥仅在手机 Android Keystore 保护的本地
凭据库保存（可不记住），不会上传网关。其他手机首次连接仍需要自己的凭据。

被控电脑至少安装本版才能使用新的 SSH 后台宿主。App 的 SSH 连接通过
`kkcode ssh-host --json --home-only --port 18271` 启动/复用宿主，不再依赖 SSH PTY。
客户端关闭后，在途回合、排队/后台任务继续；重连签发新的单次配对票据，读取同一
本地历史及进行中状态。无任务且 75 秒没有客户端活动后退出，不是永久守护进程。
手工 `kkcode remote` 仍是前台生命周期，关闭它的终端就停止 Remote。

流程、账号隔离、旧网关降级和明确的限制见 [SSH 与账号设备](ssh-account-devices.md)。

## 内核、SDK 与 Harness

- 请求预算包括系统提示、工具 schema、经过插件转换的历史、媒体和输出预留。
  压缩后仍超限时在发请求前说明原因；不会把不完整估算假装成服务端实测。
- 每个内核拥有自己的提示词缓存；同名 Agent/Skill/工具内容变化会更新指纹。
  去掉虚构的模型知识截止日和过时的 Remote/模式描述。
- 可选工具按需发现；`tool_search` 同时提供详细使用说明。关闭发现开关可恢复
  完整声明列表，不会改变权限。
- `tool_batch` 是最多 8 项的声明式串行组合，不是任意代码沙箱。每项仍经过
  schema、模式、Skill、Agent 范围、审批、审计与恢复检查；失败即停止，非原子事务。
- 有副作用的工具执行前记录私密操作日志。中断后的未知结果不会盲目重放，
  需要检查实际状态并由设备所有者显式确认。不是分布式 exactly-once 保证。
- 相同工具序列且结果不变的循环先提示、持续无进展则暂停；变化中的进度输出
  不因工具名重复而被误判。自动收尾不再绕过审批执行项目脚本。
- SDK 提供严格 TypeScript 内核入口和全部 RPC 方法映射；Web 复用 SDK SSE，
  保留轮询及旧 `request()` 入口。CLI/headless JSONL 原有用量结构保持不变。

用法与诊断见 [上下文、提示与 Harness](context-and-harness.md)、[SDK](sdk-guide.md)。

## 协议与浏览器

- MCP HTTP/SSE OAuth：官方 SDK、PKCE、state/issuer 校验、加密本地凭据和刷新；
  `kkcode mcp auth --server NAME` / `kkcode mcp logout --server NAME`。
- `kkcode acp`：ACP v1 stdio，文本/图片、会话创建/加载、流式状态、权限确认、
  模式切换和取消；不是完整 IDE 插件或所有 ACP 可选能力的承诺。
- Browser 增加移动视口、控制台/网络诊断，以及显式开发模式下的同源 WebSocket/HMR。
  私人浏览器、任意 JS、CDP、上传/下载、弹窗和 Service Worker 仍不开放。

协议设置与边界见 [MCP OAuth / ACP](protocol-adapters.md)。

## 升级顺序

1. 备份网关数据库和设备私密状态；不要复制手机私钥到网关。
2. 升级企业网关/Web 镜像，才能使用账号 SSH 地址簿；OIDC 回调不变，
   数据落在既有 store 的新命名空间，不新增独立 SSH 服务或外部监听端口。
3. 升级被控电脑 CLI，才能使用新 SSH 宿主、上下文与删除方法。
4. 安装同证书的 Android APK；自动更新设置里选择 Preview 才会检查预览版。

旧网关不支持地址簿时 Android 保留本机缓存直连，不虚构已同步。
生产域名的部署与发布包是两件事；本仓库测试不会自动升级你的生产网关或示范主机。
网关/Web 镜像从本版标签源码构建；本次不向公共镜像仓库推送镜像：

```sh
git checkout v1.0.4-preview.0
docker build -f deploy/Dockerfile -t kkcode-gateway:1.0.4-preview.0 .
```

保留现有环境配置、数据库卷、加密密钥和 OIDC 注册，只替换网关/Web 容器。
HA 部署应完成所有网关副本升级；npm `latest` 和 GitHub 稳定版不随预览发布移动。
