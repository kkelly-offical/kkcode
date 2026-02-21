# kkcode Android — 移动端开发要点

> 目标：在 Android 设备上本地运行 kkcode，实现完整的 vibe coding 体验。
> 核心原则：**全部本地执行，零云后端依赖**。

---

## 架构总览

```
┌──────────────────── Android App ────────────────────┐
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │              Presentation Layer                │  │
│  │  Jetpack Compose Chat UI + File Browser       │  │
│  └──────────────────┬────────────────────────────┘  │
│                     │ Kotlin ↔ JSON-RPC              │
│  ┌──────────────────┴────────────────────────────┐  │
│  │              Bridge Layer                      │  │
│  │  ProcessBuilder → stdin/stdout pipe            │  │
│  │  Workspace lifecycle (clone/push/destroy)      │  │
│  └──────────────────┬────────────────────────────┘  │
│                     │                                │
│  ┌──────────────────┴────────────────────────────┐  │
│  │              Runtime Layer                     │  │
│  │  Termux Bootstrap (Node.js 22 + git + utils)  │  │
│  │  proot sandbox (可选隔离)                      │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  存储：app cacheDir/workspace_<uuid>/               │
└─────────────────────────────────────────────────────┘
```

---

## Phase 1：运行环境嵌入

### 1.1 Termux Bootstrap 集成

不依赖用户安装 Termux，而是将 Termux 的 bootstrap 包嵌入 App 私有目录。

**关键资源：**
- [termux-packages](https://github.com/termux/termux-packages) — 预编译的 ARM64 包
- Bootstrap 最小集：`coreutils`, `bash`, `nodejs-lts` (v22), `git`, `openssh`

**目录结构：**
```
/data/data/com.kkcode.app/
├── files/
│   └── usr/                    ← Termux bootstrap 解压到此
│       ├── bin/                ← node, git, bash
│       ├── lib/                ← 共享库
│       └── etc/
├── cache/
│   └── workspaces/             ← 临时工作空间
└── kkcode/                     ← kkcode 本体 (npm pack 产物)
```

**初始化流程：**
```kotlin
class BootstrapManager(private val context: Context) {
    private val prefixDir = File(context.filesDir, "usr")

    suspend fun ensureReady(): Boolean {
        if (isBootstrapped()) return true
        // 1. 从 assets 解压 bootstrap.tar.gz
        extractAsset("bootstrap-aarch64.tar.gz", context.filesDir)
        // 2. 修复 symlinks 和权限
        fixPermissions(prefixDir)
        // 3. 验证 node 可执行
        return verify("node", "--version")
    }

    private fun isBootstrapped(): Boolean =
        File(prefixDir, "bin/node").canExecute()
}
```

**注意事项：**
- Bootstrap 包约 80-120MB（压缩后 ~40MB），首次启动解压一次
- 必须设置 `LD_LIBRARY_PATH` 指向 `usr/lib`
- `HOME` 和 `TMPDIR` 要指向 app 私有目录，避免权限问题
- 需要处理 SELinux 上下文：`Os.setenv("LD_PRELOAD", "", true)` 清除预加载

### 1.2 环境变量配置

```kotlin
fun buildEnvironment(): Map<String, String> {
    val prefix = "${context.filesDir}/usr"
    return mapOf(
        "HOME"            to context.filesDir.absolutePath,
        "TMPDIR"          to context.cacheDir.absolutePath,
        "PREFIX"          to prefix,
        "PATH"            to "$prefix/bin:${System.getenv("PATH")}",
        "LD_LIBRARY_PATH" to "$prefix/lib",
        "LANG"            to "en_US.UTF-8",
        "NODE_OPTIONS"    to "--max-old-space-size=512",  // 限制内存
        "KKCODE_HOME"     to "${context.filesDir}/.kkcode",
        // API Key 从 Android Keystore 解密后注入
        "ANTHROPIC_API_KEY" to keystore.getApiKey("anthropic"),
        "OPENAI_API_KEY"    to keystore.getApiKey("openai"),
    )
}
```

---

## Phase 2：kkcode 进程管理

### 2.1 进程启动

kkcode 支持 `--pipe` 模式，通过 stdin/stdout 以 JSON 行协议通信。

```kotlin
class KKCodeProcess(
    private val workspacePath: File,
    private val env: Map<String, String>
) {
    private lateinit var process: Process
    private lateinit var writer: BufferedWriter
    private lateinit var reader: BufferedReader

    fun start(mode: String = "agent") {
        val nodebin = "${env["PREFIX"]}/bin/node"
        val kkcodePath = "${context.filesDir}/kkcode/bin/kkcode.mjs"

        process = ProcessBuilder(
            nodebin, kkcodePath,
            "--pipe",
            "--mode", mode,
            "--cwd", workspacePath.absolutePath
        ).apply {
            environment().putAll(env)
            redirectErrorStream(false)
        }.start()

        writer = process.outputStream.bufferedWriter()
        reader = process.inputStream.bufferedReader()
    }

    suspend fun send(message: String) {
        withContext(Dispatchers.IO) {
            writer.write(message)
            writer.newLine()
            writer.flush()
        }
    }

    fun outputFlow(): Flow<String> = flow {
        reader.lineSequence().forEach { line ->
            emit(line)
        }
    }.flowOn(Dispatchers.IO)

    fun destroy() {
        process.destroyForcibly()
    }
}
```

### 2.2 Foreground Service 保活

Android 会积极杀后台进程，必须用 Foreground Service 保活：

```kotlin
class KKCodeService : Service() {
    private var kkProcess: KKCodeProcess? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification("kkcode 正在运行...")
        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    // 通过 Binder 暴露给 Activity
    inner class LocalBinder : Binder() {
        fun getProcess() = kkProcess
    }
}
```

**关键配置（AndroidManifest.xml）：**
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.INTERNET" />

<service
    android:name=".service.KKCodeService"
    android:foregroundServiceType="dataSync"
    android:exported="false" />
```

---

## Phase 3：Workspace 生命周期

### 3.1 Clone → Work → Push → Destroy

```kotlin
class WorkspaceManager(
    private val cacheDir: File,
    private val env: Map<String, String>
) {
    data class Workspace(
        val id: String,
        val path: File,
        val repoUrl: String,
        val branch: String
    )

    suspend fun create(repoUrl: String, branch: String = "main"): Workspace {
        val id = UUID.randomUUID().toString().take(8)
        val wsDir = File(cacheDir, "workspaces/ws_$id")

        // shallow clone 节省空间和时间
        exec(
            "git", "clone",
            "--depth", "1",
            "--branch", branch,
            "--single-branch",
            repoUrl, wsDir.absolutePath
        )

        return Workspace(id, wsDir, repoUrl, branch)
    }

    suspend fun push(ws: Workspace, commitMsg: String) {
        exec("git", "-C", ws.path.absolutePath, "add", "-A")
        exec("git", "-C", ws.path.absolutePath, "commit", "-m", commitMsg)
        exec("git", "-C", ws.path.absolutePath, "push", "origin", "HEAD")
    }

    suspend fun destroy(ws: Workspace) {
        ws.path.deleteRecursively()
    }

    // 磁盘空间检查
    fun availableSpaceMB(): Long =
        StatFs(cacheDir.absolutePath).availableBytes / (1024 * 1024)

    private suspend fun exec(vararg cmd: String) = withContext(Dispatchers.IO) {
        ProcessBuilder(*cmd)
            .apply { environment().putAll(env) }
            .start()
            .waitFor()
    }
}
```

### 3.2 Git 认证

```kotlin
class GitAuthManager(private val context: Context) {
    // 方案1：GitHub Personal Access Token (推荐)
    // clone URL: https://<token>@github.com/user/repo.git
    fun authenticatedUrl(repoUrl: String, token: String): String {
        val uri = URI(repoUrl)
        return "${uri.scheme}://$token@${uri.host}${uri.path}"
    }

    // 方案2：GitHub OAuth Device Flow (更安全)
    // 用户在手机浏览器里授权，App 拿到 token
    suspend fun deviceFlowAuth(): String {
        // POST https://github.com/login/device/code
        // 用户访问 https://github.com/login/device 输入 code
        // 轮询 POST https://github.com/login/oauth/access_token
        // 返回 access_token
        TODO("实现 Device Flow")
    }
}
```

---

## Phase 4：UI 层 (Jetpack Compose)

### 4.1 Chat 界面

```kotlin
@Composable
fun ChatScreen(viewModel: ChatViewModel) {
    val messages by viewModel.messages.collectAsState()
    val inputText by viewModel.inputText.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(viewModel.workspaceName) },
                actions = {
                    // 模式切换
                    ModeSelector(viewModel.currentMode) { viewModel.switchMode(it) }
                    // 推送按钮
                    IconButton(onClick = { viewModel.pushChanges() }) {
                        Icon(Icons.Default.CloudUpload, "Push")
                    }
                }
            )
        },
        bottomBar = {
            ChatInput(
                text = inputText,
                onTextChange = viewModel::updateInput,
                onSend = viewModel::sendMessage,
                // 附件：选择文件、截图、语音
                onAttach = viewModel::attachFile
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding),
            reverseLayout = true
        ) {
            items(messages) { msg ->
                when (msg) {
                    is ChatMessage.User -> UserBubble(msg)
                    is ChatMessage.Assistant -> AssistantBubble(msg)
                    is ChatMessage.ToolCall -> ToolCallCard(msg)  // 折叠显示工具调用
                    is ChatMessage.Code -> CodeBlock(msg)         // 语法高亮代码块
                }
            }
        }
    }
}
```

### 4.2 文件浏览器

```kotlin
@Composable
fun FileBrowser(
    workspace: Workspace,
    onFileSelect: (File) -> Unit
) {
    val tree by remember { mutableStateOf(buildFileTree(workspace.path)) }

    LazyColumn {
        items(tree) { entry ->
            Row(
                modifier = Modifier
                    .clickable { onFileSelect(entry.file) }
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            ) {
                Icon(
                    if (entry.isDirectory) Icons.Default.Folder
                    else Icons.Default.InsertDriveFile,
                    contentDescription = null
                )
                Spacer(Modifier.width(8.dp))
                Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
```

### 4.3 代码查看/编辑

轻量级方案——不需要完整 IDE，提供只读高亮 + 简单编辑即可：

```kotlin
// 使用 Highlight.js (WebView) 或 compose-richtext 实现语法高亮
@Composable
fun CodeViewer(
    content: String,
    language: String,
    onEdit: ((String) -> Unit)? = null  // null = 只读模式
) {
    // 方案A：WebView + highlight.js（最简单）
    // 方案B：compose-richtext + treesitter（更原生）
    AndroidView(factory = { ctx ->
        WebView(ctx).apply {
            loadDataWithBaseURL(null, highlightHtml(content, language), "text/html", "utf-8", null)
        }
    })
}
```

---

## Phase 5：沙盒隔离

### 5.1 文件系统隔离

kkcode 的工具只能操作 workspace 目录，通过配置实现：

```yaml
# 注入到 workspace 的 kkcode.config.yaml
permission:
  default_policy: ask
  rules:
    - pattern: "write:**"
      scope: "workspace_only"
    - pattern: "bash:rm *"
      policy: deny
    - pattern: "bash:sudo *"
      policy: deny
```

### 5.2 proot 增强隔离（可选）

```kotlin
fun launchSandboxed(workspace: File, command: List<String>): Process {
    val prootBin = "${env["PREFIX"]}/bin/proot"
    return ProcessBuilder(
        prootBin,
        "-r", workspace.absolutePath,  // 根目录限制
        "-w", "/",
        "-b", "/dev",
        "-b", "/proc",
        "-b", "/sys",
        *command.toTypedArray()
    ).apply {
        environment().putAll(env)
    }.start()
}
```

---

## Phase 6：性能与资源管理

### 6.1 内存控制

```kotlin
// Node.js 内存上限
"NODE_OPTIONS" to "--max-old-space-size=512"

// 监控内存使用
class MemoryWatchdog(private val threshold: Float = 0.85f) {
    fun check(): Boolean {
        val mi = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(mi)
        return mi.availMem.toFloat() / mi.totalMem > (1 - threshold)
    }
}
```

### 6.2 存储管理

```kotlin
class StorageManager(private val cacheDir: File) {
    private val maxWorkspaces = 3
    private val maxCacheMB = 500L

    // 自动清理最旧的 workspace
    suspend fun autoCleanup() {
        val workspaces = File(cacheDir, "workspaces")
            .listFiles()
            ?.sortedBy { it.lastModified() }
            ?: return

        // 超过数量限制
        while (workspaces.size > maxWorkspaces) {
            workspaces.removeFirst().deleteRecursively()
        }

        // 超过空间限制
        while (dirSizeMB(cacheDir) > maxCacheMB && workspaces.isNotEmpty()) {
            workspaces.removeFirst().deleteRecursively()
        }
    }
}
```

### 6.3 网络优化

```kotlin
// sparse checkout：只拉取需要的目录
suspend fun sparseClone(repoUrl: String, paths: List<String>, target: File) {
    exec("git", "clone", "--filter=blob:none", "--no-checkout", repoUrl, target.absolutePath)
    exec("git", "-C", target.absolutePath, "sparse-checkout", "init", "--cone")
    exec("git", "-C", target.absolutePath, "sparse-checkout", "set", *paths.toTypedArray())
    exec("git", "-C", target.absolutePath, "checkout")
}
```

---

## 技术选型清单

| 层级 | 技术 | 说明 |
|------|------|------|
| 语言 | Kotlin | Android 官方推荐 |
| UI | Jetpack Compose | 声明式 UI，适合 Chat 界面 |
| 架构 | MVVM + Repository | ViewModel + StateFlow |
| 依赖注入 | Hilt | 标准方案 |
| 异步 | Kotlin Coroutines + Flow | 处理进程 I/O |
| 运行时 | Termux Bootstrap | Node.js 22 + git |
| 通信 | stdin/stdout JSON 行协议 | kkcode --pipe 模式 |
| 存储 | Room (元数据) + File (workspace) | 会话历史 + 代码文件 |
| 安全 | Android Keystore | API Key 加密存储 |
| 代码高亮 | WebView + highlight.js | 轻量方案 |
| Git 认证 | GitHub OAuth Device Flow | 免密码，token 存 Keystore |
| 保活 | Foreground Service | 防止进程被杀 |

---

## 项目结构

```
kkcode-android/
├── app/
│   ├── src/main/
│   │   ├── java/com/kkcode/app/
│   │   │   ├── di/                    ← Hilt 模块
│   │   │   ├── data/
│   │   │   │   ├── runtime/
│   │   │   │   │   ├── BootstrapManager.kt
│   │   │   │   │   ├── KKCodeProcess.kt
│   │   │   │   │   └── EnvironmentBuilder.kt
│   │   │   │   ├── workspace/
│   │   │   │   │   ├── WorkspaceManager.kt
│   │   │   │   │   ├── GitAuthManager.kt
│   │   │   │   │   └── StorageManager.kt
│   │   │   │   ├── session/
│   │   │   │   │   ├── SessionRepository.kt
│   │   │   │   │   └── MessageDao.kt
│   │   │   │   └── security/
│   │   │   │       └── KeystoreManager.kt
│   │   │   ├── service/
│   │   │   │   └── KKCodeService.kt   ← Foreground Service
│   │   │   ├── ui/
│   │   │   │   ├── chat/
│   │   │   │   │   ├── ChatScreen.kt
│   │   │   │   │   ├── ChatViewModel.kt
│   │   │   │   │   └── components/
│   │   │   │   │       ├── MessageBubble.kt
│   │   │   │   │       ├── ToolCallCard.kt
│   │   │   │   │       └── CodeBlock.kt
│   │   │   │   ├── workspace/
│   │   │   │   │   ├── WorkspaceListScreen.kt
│   │   │   │   │   ├── FileBrowserScreen.kt
│   │   │   │   │   └── CodeViewerScreen.kt
│   │   │   │   ├── settings/
│   │   │   │   │   ├── SettingsScreen.kt
│   │   │   │   │   └── ProviderConfigScreen.kt
│   │   │   │   └── theme/
│   │   │   │       └── Theme.kt
│   │   │   └── App.kt
│   │   ├── assets/
│   │   │   └── bootstrap-aarch64.tar.gz  ← Termux 运行时
│   │   └── AndroidManifest.xml
│   └── build.gradle.kts
├── gradle/
└── build.gradle.kts
```

---

## 已知限制与应对

| 限制 | 影响 | 应对策略 |
|------|------|----------|
| ARM64 only | 部分旧设备不支持 | minSdk 设 26 (Android 8+), ABI filter aarch64 |
| 存储空间有限 | 大仓库 clone 慢 | `--depth 1` + sparse checkout + 自动清理 |
| 内存 4-12GB | LLM context 受限 | `--max-old-space-size=512` + compaction 阈值调低 |
| 后台进程被杀 | 长任务中断 | Foreground Service + checkpoint 恢复 |
| 无硬件键盘 | 编码效率低 | Chat 为主交互，减少手动编码需求 |
| 无法跑 Docker | 部分项目测试受限 | proot 模拟 + kkcode 内置 test gate |
| iOS 不适用 | 本方案仅限 Android | iOS 需走 Web Terminal 远程方案 |

---

## kkcode 侧适配清单

为配合 Android 客户端，kkcode 本体可能需要以下调整：

| 调整项 | 说明 |
|--------|------|
| `--pipe` 协议文档化 | 确保 JSON 行协议稳定，定义消息类型 schema |
| 内存友好模式 | 添加 `--low-memory` flag，减小 context window、关闭缓存 |
| workspace 限定 | `--workspace-root` 参数，限制工具只能访问指定目录 |
| 进度事件 | pipe 输出中增加 `type: "progress"` 事件（stage 进度、token 消耗等） |
| 优雅退出 | SIGTERM 时保存 checkpoint，下次启动可恢复 |
| Bootstrap 检测 | 检测 Termux 环境并自动调整路径（$PREFIX 而非 /usr） |

---

## 安全要点

1. **API Key**：必须使用 Android Keystore 加密存储，禁止明文存 SharedPreferences
2. **Git Token**：同上，OAuth token 存 Keystore，过期自动刷新
3. **Workspace 隔离**：每个 workspace 独立目录，kkcode permission 限制在 workspace 内
4. **网络**：所有 API 调用走 HTTPS，证书固定可选
5. **App 签名**：Release 包必须签名，防止篡改注入恶意代码
6. **日志脱敏**：kkcode 输出中可能含敏感信息，UI 层不持久化完整日志
