# 固定基础镜像的隔离测试镜像

只供本机／CI 合成验收，不是生产 Agent、网关或语言服务器镜像。不会推送镜像。

- 基础：官方 `node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`，固定 OCI index。
- 本脚本只构建 `linux/amd64`，对应基础 manifest 为 `sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27`。
- 已核对 Node `22.23.1`、npm `10.9.8`，以及 `/usr/bin/env`、`timeout`、`sh`、Bash、常见 coreutils、find、grep。
- 不执行 apt、npm install 或在线脚本。构建的 `RUN` 阶段断网；初次获取固定基础镜像仍需要 Docker Hub 连接。
- Docker CLI 使用临时空配置，不读取本机 Docker 登录资料；构建上下文只有 Dockerfile 和仓库的合成 LSP fixture，不发送整个工作区。

在仓库根目录执行：

```sh
node scripts/build-strict-test-images.mjs
```

构建进度写入 stderr。stdout 输出一行 JSON 回执，包括基础摘要、平台、fixture SHA-256 和：

```json
{
  "environment": {
    "KKCODE_STRICT_TEST_IMAGE": "sha256:构建所得严格测试镜像ID",
    "KK_LSP_TEST_IMAGE": "sha256:构建所得合成LSP镜像ID"
  }
}
```

CI 读取两个 ID 设置相同名称的环境变量，再运行：

```sh
node --test test/strict-test-images.test.mjs test/strict-isolation.test.mjs test/lsp-service.test.mjs
```

其他读取 `KKCODE_STRICT_TEST_IMAGE` 的协调器／任务图／Forge／预算测试可使用同一镜像。
运行时接受不可变 ID，不要把测试镜像改成 `latest` 或浮动 Node 标签。

Dockerfile 有两个 target：`strict-test` 不带合成服务；`lsp-fixture` 只增加只读文件
`/opt/kkcode-test/fake-lsp-server.mjs`。严格语言服务可用
`command: '/usr/local/bin/node', args: ['/opt/kkcode-test/fake-lsp-server.mjs']` 显式启动它。
该 fixture 用于协议、隔离、取消测试，**不能作为真实 TypeScript／Python／Go／Kotlin
语言能力的证明**；真实多语言镜像另见 `containers/lsp/`。

固定源摘要和 fixture 内容保障依赖输入可重复；不同 Docker 构建器可能产生不同构建时间元数据，
不承诺跨构建器逐字节相同的镜像 ID。脚本每次检查构建产物平台、标签和实际不可变 ID，
然后通过真实容器测试确认可用。构建临时目录会清理，构建所得镜像留给后续测试使用。
