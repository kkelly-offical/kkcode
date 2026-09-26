# 宿主隔离服务：Office 与语言工具

[文档导航](README.md) · 适用源码：1.1.6；[发行状态](versions.md)。服务连接同一内核中的CLI、Web、Android会话；手机和网页不运行解析器或语言服务器。工具输出仍受会话、任务合同和出域限制。

## 按需启用

先在执行电脑准备并验收固定 Docker 镜像。不会自动拉取浮动镜像、安装语言服务器或回退到宿主执行。Office 镜像的构建和格式范围见 [文档工具](office-tools.md)，语言服务器见 [LSP](language-services.md)。

在自己选择的 JSON 文件中明确写入镜像和程序：

```json
{
  "schemaVersion": 1,
  "office": { "image": "sha256:替换为本机已验收镜像的64位摘要" },
  "lsp": {
    "image": "sha256:替换为本机语言工具镜像的64位摘要",
    "servers": {
      "typescript": { "command": "/opt/language-tools/typescript-language-server", "args": ["--stdio"] }
    }
  }
}
```

例子里的摘要和程序路径是占位符，不是已安装的环境。可只配置 `office` 或 `lsp`；JavaScript 可复用 TypeScript 服务。

```sh
kkcode services configure --file /absolute/path/services.json
# 核对首次输出的配置及 SHA-256，再执行同一条命令并带上确认值：
kkcode services configure --file /absolute/path/services.json --confirm-hash 上一步的哈希
kkcode services status
```

首次调用只是预览，不保存、不启动服务。确认后的配置保存到用户私密状态目录 `host-services.json`，只在新内核/新设备进程中生效。**项目配置、模型参数、Web 设置 RPC 不会覆盖这份文件。** 关闭所有服务可明确确认 `{"schemaVersion":1}`。旧服务实例不在运行中被悄悄更换。

`status` 只证明配置存在，不代表镜像能运行。请分别执行 `kkcode office capabilities --image …` 和 `kkcode lsp inspect … --image …` 验收。工具首次使用仍检查隔离、镜像、工作区和资源上限，失败时中文说明，不拖垮普通聊天。

## SDK 宿主

`createKernel({ services: { lsp, office } })` 只接受正式 SDK 工厂生成的服务实例，不接受仿造普通对象。传 `{}` 明确禁用默认私密配置。宿主注入的实例由调用者负责关闭，默认从私密配置创建的实例由内核关闭。`kernel.diagnostics.services()` 提供配置就绪状态；不会输出凭据。

工具上下文由内核的运行实例注入。每轮输入的 `toolContext` 不能替换 Office/LSP 服务。严格委托还要求实例与独立工作区一致，工具名出现在已批准合同内；配置服务不等于授权任何任务使用它。

## 支持界限

- Office 支持有限的 DOCX/XLSX/PPTX/PDF/Markdown 操作。宏、签名、加密、复杂嵌入等按文档工具契约拒绝或明确限制，不隐性丢弃。
- Office 处理使用离线 job；固定搬运程序采集和发布文件，解析器本身不挂原工作区。原文件保留，只发布新目录。
- LSP 为只读诊断、符号、定义和引用，不等于完整构建测试。
- Linux 宿主直接 LSP 是显式高级接口，不是 OS 沙箱；Windows/macOS 原生宿主安全路径原语尚不支持，应使用 Linux Docker 隔离后端。实际三系统 Docker Desktop 验收以实施账本为准，不能把 Linux 结果当作全平台结果。
