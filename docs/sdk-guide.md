# 内核、远程客户端与分域 SDK

当前源码版本为 **1.0.5-preview.0，未发布**；公开稳定版仍为 **1.0.4**。
1.0.5 Preview 开发增加下列分域入口，原有本地内核和远程客户端入口保持兼容。
这些是当前工作树接口，尚未公开发行；各模块的实现与验收范围以
[实施账本](implementation-1.0.5.md) 为准，不能把存在接口解释为全平台生产验收完成。

## 选择公开入口

| 入口后缀 | 用途和边界 |
| --- | --- |
| `sdk` | Node 本地 `createKernel` 与兼容客户端导出；浏览器不要导入整个内核 |
| `protocol` | 共享设备协议版本与方法定义；不是认证／执行服务 |
| `sdk/client` | 浏览器安全传输、全部增量 RPC 类型、按需哈希校验下载；不包含 Node 内核 |
| `sdk/artifacts` | 浏览器安全的显式分块下载，完整 SHA-256 校验后返回 Blob；不自动预览／执行 |
| `sdk/diagnostics` | 规范账本／内核的只读诊断，不执行或恢复未知动作；宿主仍负责授权，不能把私密账本交给访客 |
| `sdk/storage` | 私密 SQLite/WAL 与产物原件，低层可信宿主接口，不自行授权或执行 |
| `sdk/runs` | 宿主确认、独立工作树、严格执行、持久操作与恢复；不能原样暴露为模型工具 |
| `sdk/tasks` | 有界持久 DAG、逐项子任务/结果核准；不是旧后台线程的别名 |
| `sdk/environments` | 宿主批准的 npm 锁文件/SRI 环境、单独批准离线安装脚本、恢复验签及只读挂载；不是模型安装工具 |
| `sdk/memory` | 有来源的项目事实、待确认个人偏好、更正/禁用/忘记 |
| `sdk/models` | 角色模型解析与能力来源档案，不虚构远端模型能力 |
| `sdk/browser` | 隔离浏览器、本机授权桥接；宿主授权方法不能转成无认证 RPC |
| `sdk/browser-recipes` | 限定账号与工作区的实验录制/审核/离线验证；模型运行逐叶重新治理 |
| `sdk/office`、`sdk/lsp` | 明确配置的离线隔离文档与语言服务；不自动安装依赖 |
| `sdk/forge` | GitHub/GitLab 的治理式交付；不自动合并、部署或发版 |

所有后缀均以 `@kkelly-offical/kkcode/` 开头。扩展宿主不得把模型返回的
`approved:true` 当作确认，必须在自己已认证的界面展示范围并让用户操作。
Node 宿主域会访问文件、进程或 Docker，不应打进手机／浏览器客户端。对外 RPC
使用 `DeviceClient` 和设备已有权限检查，不要直接包装低层 `store` 或 `coordinator`。

## 本地内核与远程传输

Node `>=22.12`。现有公开入口继续可用；以下变量中的工作目录、地址和凭据均由
宿主配置，不是模型提供的授权：

```ts
import { createKernel, DeviceClient } from '@kkelly-offical/kkcode/sdk';

const kernel = await createKernel({ cwd: '/absolute/workspace', boot: false });
try {
  // 具体模型、工作区信任及权限按宿主配置，不在此绕过。
  const result = await kernel.executeTurn({ sessionId: 'my-session', prompt: '检查项目结构' });
  console.log(result.reply);
} finally {
  await kernel.shutdown();
}

const client = new DeviceClient({ url: 'https://gateway.example.com', deviceId: 'device-id', token: accessToken });
const sessions = await client.call('sessions.list', {});
// 在你的已认证界面展示 sessions；不要在初始化客户端时自动修改/删除会话。
```

SDK 不隐式获取 control lease；
start/configure/rewind 等需要 `control.acquire`，完成后显式 `control.release`。
删除／回退／停止等操作应先展示当前对象和影响，让用户确认，再提交对应版本参数。

`executeTurn` 可省略 `sessionId`，返回新生成的会话 ID；续接时传回该 ID。
省略 provider/model 则从已有会话选择或当前配置的默认渠道/模型读取，不凭空猜模型。
mode 是内核执行航道；省略时沿用会话或配置，并归一化为 assistant/plan/longagent。
权限仍由宿主的 configState 与原审批链决定，不因省略参数而自动取得 Auto/Yolo 权限。
Responses 配置与 CLI 共用，见 [协议指南](responses-api.md)。原生加密续接只在设备
私密历史内部保存，不进入远程 `sessions.get` 的可见消息投影或 headless 事件。

`createKernel`、主要内核接口及全部 DeviceMethods 都有 `.d.mts`。严格外部 TS
消费者不需要 `allowJs` 或跳过库检查才能导入；旧 `request<T>(method, params)`
仍可用，新的 `call()` 校验方法名及对应参数。复杂扩展载荷仍用 unknown/记录类型，
不要把类型声明当成网络输入验证；设备协议仍负责运行时校验和授权。

浏览器只需传输层时，使用 `@kkelly-offical/kkcode/sdk/client`，避免打包 Node 内核。

```ts
const controller = new AbortController();
await client.stream('session-id', {
  after: snapshot.eventCursor,
  signal: controller.signal,
  onEvent: event => applyEvent(event),
  onMeta: state => applyState(state),
  onGap: async () => reloadCanonicalSnapshot()
});
```

stream 消费一条连接；宿主决定重连/退回 `events()` 轮询。切换设备/卸载界面时
abort，reader 会被取消释放；401 刷新复用已有单飞凭据轮转。replay.gap 要重新加载
规范快照，不能把缺失的流片段当完整历史。Web 与 SDK 共用此实现。

Node 通过 SSH 本地转发连接时，目标机仍严格校验 Host。浏览器兼容 fetch 不允许
自定义 Host，可通过 SDK `fetch` 注入基于 Node HTTP 的转发传输；不要为迁就隧道
关闭服务端 Host/Origin 校验。Web 产品本轮不提供 SSH。

`kernel.diagnostics.inspectPrompt(sessionId)` 只返回最近请求的提示来源、指纹和预算
元数据。SDK 宿主负责生命周期、并发会话控制、用户交互和输出；内核不渲染终端界面。

## 增量远程能力

先读取 `status.features`，再使用 `artifacts.v1`、`memory.v1`、`runs.v1` 对应方法。
旧设备返回未知方法时，提示升级，不应伪装成功或尝试从宿主路径直接下载。

```ts
const tasks = await client.call('runs.list', { sessionId: 'session-id' });
const task = tasks.items[0];
// 先在你的界面让设备所有者确认停止该任务版本；示例不自动发送停止。
const stopRequest = task && {
  sessionId: task.sessionId, runId: task.id,
  expectedRevision: task.revision, expectedOwnerEpoch: task.ownerEpoch,
  confirmed: true as const
};
```

任务 RPC 不返回私密合同授权、账号 ID 或宿主路径。共享访问仅开放被授权会话的
读操作，暂停/取消仍要求真实设备所有者。停止不等于撤销文件或外部副作用，
有正在执行/未知操作时应保留明确提示。完成状态来自账本和当前候选验收，不从
模型最后一段文本推断。恢复、交付和重新授权目前由本机可信宿主/CLI处理。

Office/LSP 可由 [`kkcode services`](host-services.md) 私密配置接入内核，或由 SDK
宿主显式传 `createKernel({services:{lsp,office}})`。内核不会接受每轮JSON替换服务。

## 归档搜索、读取和下载

普通工具的大文本在显示截断前保存为私密产物，返回不透明 ID。显式持久任务使用
自己的 run 范围；普通聊天的 conversation 范围不能借 ID 读取另一个任务。

```ts
const matches = await client.call('artifacts.search', {
  sessionId: 'session-id', id: artifactId, query: '失败原因', maxMatches: 5
});
const match = matches.matches[0];
if (match) {
  const page = await client.call('artifacts.read', {
    sessionId: 'session-id', id: artifactId, cursor: match.readCursor, limit: 4096
  });
  // page.encoding === 'base64'；在界面按文本解码展示，不执行 HTML/SVG。
}
```

`matches[].readCursor` 直接读取命中位置；顶层 `nextCursor` 继续搜索，不能混用。
游标绑定 ID 和内容哈希，每页重新认证及验证范围，不能代替身份。模型工具
`artifact_search` → `artifact_read` 使用同一机制，不需要从日志第一页翻到尾部。
大文件下载使用 `downloadArtifact(client, {sessionId, id, signal, onProgress})`；
Web 返回受 128 MiB 上限约束的 Blob，Android 客户端采用私密缓存文件流式校验。
两者都不自动执行文件。更多生命周期与本机维护见 [存储指南](sdk-storage.md)。

## 严格任务与离线依赖

`sdk/runs` 的 `createRunCoordinator` 要求受控内核、持久 store/artifacts、可信
actor、真实宿主授权和严格后端。模型可建议任务，不可自授合同、金额、外部操作或
验收通过。子任务通过 `sdk/tasks` 共用父总额度，结果确认不等于自动合并补丁。
平台交付证明会固定核验对象；等待查询或保存期间候选变化，拒绝把旧证明记到新候选。

依赖准备使用以下宿主接口：

```ts
import {
  inspectNpmEnvironment, prepareNpmEnvironment, restoreNpmEnvironment,
  verifyNpmEnvironment, prepareNpmWorkspace
} from '@kkelly-offical/kkcode/sdk/environments';
```

先检查固定镜像、项目清单和 registry origins，再由人批准 `plan.id`；包安装脚本
还需独立批准固定命令哈希，执行仍离线。只把真实恢复验签的环境句柄交给
`createDockerExecutionBackend({image, dependencyEnvironment})`；JSON 克隆不能当
句柄。`prepareNpmWorkspace` 只在已创建的任务副本准备空挂载点，不修改原项目安装。
当前支持 npm lock v2/v3 普通注册表依赖，不支持 workspaces、pnpm/Yarn/Bun 或任意
私有注册表策略。脚本生成文件尚无执行时硬总磁盘 quota；详见
[依赖环境指南](dependency-environments.md)，不能把最终大小检查称为硬磁盘隔离。

CLI 对应 `environments inspect/prepare/verify`、`runs start --environment …`。
[严格任务指南](trusted-runs.md) 给出可运行合同格式；[独立验收](independent-review.md)
和 [预算](durable-budgets.md) 说明哪些证据可用于完成判断。

## Browser、文档和扩展边界

- `sdk/browser` 隔离 Browser 使用可抛弃上下文、受控网络和明确来源。Bridge 连接
  本机用户在官方扩展选择的页面组，仅主 frame 快照及引用交互；无全局按键。
  `allowScreenshots` 默认 `false`，必须另行本机确认；图像可含嵌入页面，不承诺
  像素级 origin 隔离。严格网页出域策略不能使用 Bridge 替代隔离 Browser。
- `sdk/browser-recipes` 的录制／审核／验证／启用均由可信宿主控制。启用哈希不授予
  新站点或绕过工具审批，模型 `browser_recipe` 每个实际叶动作仍进入正常治理链。
- `sdk/office` / `sdk/lsp` 接收固定镜像与明确服务配置；文档输出保留原件并进入
  受控产物，语言诊断不等于项目构建测试。安装、格式和语言边界见各专门指南。
- MCP/ACP 表单需要协商和真实用户回答，不透传企业 SSO token；插件安装来源／
  内容哈希和新增能力由宿主批准，不把 schema、提示词或服务器声明当作权限。

## 安装包契约与验收口径

公开入口以根 `package.json.exports` 为准；内部 `src/kernel/...` 不是稳定导入 API。
SDK `.mjs` 与 `.d.mts` 随 `src/` 打包，使用文档依 `files` 白名单提供。运行时不会
自动安装 Docker 镜像、浏览器引擎或模型。完整测试、浏览器 smoke、60 任务评测、
Android/Web 源工程需要 Git checkout，不在全局安装目录假定存在 `scripts/`。

外部真实付费模型双轮评测、公共 Forge 往返、Chrome/Edge 三系统、新版 CI 和七天
试用仍须单独验收。当前 API／本地测试不代表这些门禁已经通过，也不代表
`1.0.5-preview.0` 已发布或生产部署完成。
