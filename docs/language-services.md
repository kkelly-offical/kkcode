# 按需语言服务

1.0.5 Preview 开发能力：支持 LSP 3.17 的初始化、文档打开、拉取／推送诊断、文档符号、定义及引用。支持路由 TypeScript／JavaScript、Python、Go、Kotlin；不安装或自动下载语言服务器。

## 安全和执行方式

- `createLanguageService` 默认严格模式：使用已有固定摘要 Docker 镜像、只读工作区、无网络、现有私密路径遮蔽和资源上限。没有隔离条件时拒绝，不回退宿主。
- 显式宿主模式要求 `authorizeStart` 授权绝对命令路径、参数与配置指纹；最小环境、不继承模型密钥和 Node loader，使用独立临时 HOME。
- 宿主模式只是 LSP 操作接口只读，**不是操作系统沙箱**；服务器自身和项目分析插件仍是可执行代码。只对用户信任的配置开放。严格任务不得使用宿主模式。
- 每次按需启动独立 worker，完成后关闭；查询有总时限与取消，切换项目需建立新的服务对象。没有后台自动预载服务器。
- 工作区路径、符号链接、文件大小、位置、返回 URI、协议帧、结果数量均有限制。服务端 `workspace/applyEdit` 被明确拒绝。
- 严格模式的源码采集与前后哈希检查全部在只读 Linux 容器内进行，不先由宿主读取源码再注入容器。逐级固定目录句柄并拒绝每一级符号链接，避免父目录在检查后被替换为外部路径。
- 显式宿主模式同样使用固定目录句柄读取源码；目前此原语仅支持 Linux。Windows／macOS 不回退到有竞态的路径读取，请使用严格 Docker 模式；原生宿主模式需后续补齐各平台句柄实现。

## 配置与 CLI

配置从用户明确选择的宿主 JSON 文件读取，不自动读项目中的服务器命令。例如已安装服务器的配置形态：

```json
{
  "servers": {
    "typescript": { "command": "/opt/language-tools/typescript-language-server", "args": ["--stdio"] },
    "python": { "command": "/opt/language-tools/pyright-langserver", "args": ["--stdio"] },
    "go": { "command": "/opt/language-tools/gopls", "args": ["serve"] },
    "kotlin": { "command": "/opt/language-tools/kotlin-lsp", "args": ["--stdio"] }
  }
}
```

以上是形态示例，不代表这些路径或所有 Kotlin 发行版的启动参数已经安装／验证。JavaScript 可复用 typescript 配置；路径与参数必须对应用户安装的固定版本。Windows／macOS 当前使用严格 Linux 容器时，填写的是镜像内的绝对程序路径，不是宿主 `.cmd` 或应用路径。

```sh
kkcode lsp inspect src/main.ts --operation symbols --config /path/to/lsp.json --image sha256:固定镜像摘要
kkcode lsp inspect src/main.ts --operation definition --line 10 --character 4 --config /path/to/lsp.json --host --allow-host-server
```

SDK 入口：`@kkelly-offical/kkcode/sdk/lsp`。工具注册函数 `createLspTools()` 返回 `lsp` 工具；调用上下文必须包含由宿主创建的 `lspService`，模型 JSON 不能伪造。

## 结果与验收

结果绑定 `sourceHash`。查询过程中源码改变则拒绝旧结果。`pull_full`、`push_snapshot` 和 `typescript_sync` 明确区分；`push_snapshot` 只表示收到某个当前版本的异步通知，不能解释为整个项目类型检查完毕。对明确广告 `typescript.tsserverRequest` 的 TS/JS 服务，内核仅调用固定的语法、语义、建议同步诊断查询，避免把清空旧诊断的第一条空推送当成完成；不向模型开放任意 `executeCommand`。语言诊断不能替代测试、构建或独立验收。

## 真实语言服务器镜像

仓库提供独立 [containers/lsp](../containers/lsp/NOTICE.md) 构建配方和 npm/下载锁，不在 CLI 首次运行时安装。当前固定 Linux/amd64：TypeScript Language Server 6.0.0 + TypeScript 6.0.3、Pyright 1.1.414、gopls 0.23.0 + Go 1.27.1、MIT 的 fwcd Kotlin Language Server 1.3.13（捆绑 Kotlin 编译器 2.1.0）。Kotlin 上游已标记 deprecated，不表示已支持较新的 Kotlin 语法、Android/Gradle 全项目导入或所有编辑器功能。需要新版本官方服务的用户可在审核许可后提供自己的显式 host/server 配置，本次没有代签其 EULA 或认证该商业发行包。

```sh
docker build -t kkcode-lsp:1.0.5-preview.0 containers/lsp
docker image inspect kkcode-lsp:1.0.5-preview.0 --format '{{.Id}}'
# 把实际输出的 sha256:... 用作下方的镜像 ID，不以浮动 tag 执行
KK_LSP_REAL_IMAGE=sha256:... KKCODE_REQUIRE_REAL_LSP=1 node --test test/lsp-real-servers.test.mjs
```

SDK 使用 `createIsolatedLanguageServerConfigs()` 获取这张镜像的明确路径/argv/初始化配置，再传给 `createLanguageService({cwd, servers, mode:'strict', image, authorizeStart})`。TS/JS 默认关闭自动类型包安装和额外 syntax server；gopls 关闭在线模块代理与 telemetry。运行时仍无网络、工作区只读、无宿主凭据、资源受限。真实服务可能在内部启动 tsserver、JVM 或项目 classpath/build 进程，因此 host 模式的“只读 LSP 协议”不等于操作系统隔离；不可信项目应使用 strict。

`test/lsp-real-servers.test.mjs` 对五种语言分别放入真实类型错误和声明，必须实际返回相符诊断与 symbol；缺失、超时、错误均不算 clean。真实镜像的 5/5 用例已在本机 Linux/amd64 严格容器中通过。未提供固定镜像时测试明确跳过；设置 `KKCODE_REQUIRE_REAL_LSP=1` 后缺失镜像直接失败。未把这些容器结果宣称为 Windows/macOS 原生服务器、ARM 或完整 Android 仓库认证。离线项目依赖需要宿主提前准备经过审核的镜像/缓存，不能用无法解析依赖的诊断代替构建验收。

`test/lsp-service.test.mjs` 使用真实本机 stdio 子进程和合成服务器验证五种语言路由、分帧、两种诊断、符号和定位、编辑请求拒绝、环境隔离、权限拒绝、取消、超时及畸形帧。真实 TS/JS、Pyright、gopls、Kotlin 服务器及三系统实测仍需逐项记录，不能将合成协议测试称为语言服务器认证。

官方来源：[LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)、[TypeScript Language Server](https://github.com/typescript-language-server/typescript-language-server)、[Pyright](https://github.com/microsoft/pyright)、[gopls](https://go.dev/gopls/)、[Kotlin LSP](https://github.com/Kotlin/kotlin-lsp)。
