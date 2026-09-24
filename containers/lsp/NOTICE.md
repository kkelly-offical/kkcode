# 固定语言服务器构建

这是显式部署配方，不是随每次对话自动执行的安装器。运行时通过 `createIsolatedLanguageServerConfigs()` 选择镜像内已装服务，并仅接受操作者确认过的不可变 Docker image ID。

| 服务 | 固定版本 | 来源/范围 |
| --- | --- | --- |
| Node | 22.23.1（基础镜像 digest 固定） | 官方 `node:22-bookworm-slim`，只在容器内运行 |
| TypeScript Language Server | 6.0.0 | [上游](https://github.com/typescript-language-server/typescript-language-server/tree/v6.0.0)，Apache-2.0 |
| TypeScript | 6.0.3 | npm 完整 integrity lock；不盲选不含传统 tsserver 的 TypeScript 7 |
| Pyright | 1.1.414 | [Microsoft Pyright](https://github.com/microsoft/pyright)，MIT |
| gopls / Go | 0.23.0 / 1.27.1 | [Go 官方](https://go.dev/gopls/)；工具链官方 SHA-256 + Go SumDB 校验源模块和依赖 |
| Kotlin Language Server | fwcd 1.3.13 | [上游发行](https://github.com/fwcd/kotlin-language-server/releases/tag/1.3.13)，MIT；bundled compiler 2.1.0 |

构建上下文只需本目录，不发送整个仓库、工作区或用户 HOME 给 Docker。npm 使用固定 registry、独立空配置和 `ci --ignore-scripts`，不读取用户 npm token。Go 工具链包验证官方 SHA-256，gopls 验证明确的模块/`go.mod` SumDB hash；Kotlin 旧发行资产没有上游独立 checksum 文件，因此本项目锁的是从上游固定发行 HTTPS 资产计算并复验的 SHA-256，不声称它有维护者签名。锁变更需要重新审查和实际验收。Debian直接依赖固定版本，完整已安装系统包表及 Go 模块版本记录在镜像 `/opt/kkcode-lsp`；系统传递依赖受 Debian 仓库供应情况影响，最终运行以实际不可变镜像 ID 为准，不声称任意时间重建一定字节相同。

Kotlin 上游已经 [声明 deprecated](https://github.com/fwcd/kotlin-language-server)，其 [版本目录](https://github.com/fwcd/kotlin-language-server/blob/1.3.13/gradle/libs.versions.toml) 使用 Kotlin 2.1.0。本次证明的是这套明确版本的真实 LSP 诊断/符号能力，不是新语法、Gradle/Android 全项目兼容性认证。新版 JetBrains 发行包涉及独立许可/EULA等选择；本配方不下载它、不代替用户确认许可、不绕过其授权。

镜像包括第三方程序及其随包声明，部署/再分发前应保留上游许可。这里没有发布公共镜像，也不把 Java/JVM、Gradle 或任意项目插件执行称为宿主只读；真正边界来自 strict 容器的网络 none、只读工作区/根文件系统、最小环境与资源限制。Host 模式是单独的显式信任选择。

本机已验收 image ID：`sha256:a356b7647635213ccd1b07695dd11cec18f102fa3b272f75e607f8289665adae`（仅本机 receipt，不是公共 registry 地址）。所有五种语言必须返回故意植入的实际类型错误与源码声明，不能以启动日志或空结果代替成功。
