# Strict Browser 实机验收

`node scripts/browser-strict-smoke.mjs` 是严格浏览器验收入口。普通 Browser 功能测试中，在明确隔离的测试环境里关闭 Chromium sandbox 的 fixture，只能证明交互功能，**不能代替此验收**。

## 必要条件

- Linux 普通用户（非 root），能使用本机 Docker，且内核／runner 允许 Chromium 的沙箱机制。
- `npm ci` 安装项目锁定依赖；通过项目的 `kkcode browser install` 或相同锁定 Playwright 版本安装 Chromium。脚本只使用该版本的默认二进制。
- 本机已有包含 Node 和 `/usr/bin/timeout` 的 Linux 执行镜像，通过 `KKCODE_STRICT_TEST_IMAGE` 指定不可变 `sha256:…` 或 `repository@sha256:…`。脚本不拉取镜像，不接收浮动标签，不连接远程 Docker。
- `/proc` 允许该用户读取本次启动的 Chromium 主进程环境和 renderer 安全状态。无法取证时不算通过。

验收不改 sysctl／AppArmor，不创建 SUID helper，不关闭 Chromium sandbox，也不读取个人浏览器 profile。

## CI 调用

在专用 Linux 非 root runner 上执行。镜像准备步骤应独立固定来源；从已准备镜像取得实际摘要，再传给脚本，例如：

```sh
npm ci
node src/index.mjs browser install
export KKCODE_STRICT_TEST_IMAGE="$(docker image inspect --format '{{.Id}}' your-prepared-test-image)"
node scripts/browser-strict-smoke.mjs
```

也可以将真实验收作为 Node 测试执行：

```sh
KKCODE_REQUIRE_STRICT_BROWSER=1 node --test test/browser-strict-smoke.test.mjs
```

镜像示例中的名称只是宿主预先准备镜像的查询参数，不是验收允许的运行标识。真正运行始终使用查询所得的不可变摘要。环境变量未设置时，普通全量测试会显式跳过实机项；CI 门禁必须设置 `KKCODE_REQUIRE_STRICT_BROWSER=1` 或直接调用脚本，不能将跳过算作通过。不要为了让受限的公共 runner 变绿而降低 OS 安全设置；改用已具备支持的受控 runner。

## 验收链和证据

1. 实际 `createDockerExecutionBackend` 对固定镜像执行隔离探针，核验只读根、无特权、seccomp、独立工作区及无网络容器。
2. 通过该后端的真实 Browser 白名单路径调用生产 controller；合同仅允许测试临时 HTTP origin。Browser 是宿主受控适配器，Chromium 用自己的 OS 沙箱，**不声称 Chromium 在执行镜像容器里面**。
3. 对本地合成页面实际执行打开、快照、点击、PNG 截图；同时验证合同外 origin 被拒绝。
4. 启动观察器不修改任何生产启动参数。通过实际 CDP 进程信息定位进程，检查 `/proc` 命令行没有关闭沙箱的参数，renderer 为 `NoNewPrivs=1`、`Seccomp=2`、无有效 capabilities。
5. 在父进程放置随机私密 canary，核对启动环境及实际 Chromium 主进程环境没有继承。回执不输出完整命令行、环境或 canary。
6. 打开一个真实挂起的导航后取消，检查 context 关闭、已观察 Chromium 进程停止、私密 profile 删除。最后关闭临时 HTTP 服务并回收测试目录。

输出是一行 JSON：`status: passed` 为真实通过；`blocked` 表示环境不支持或无法充分取证；`failed` 表示断言失败。退出码分别为 **0、2、1**。`blocked` 是未验收，不是成功，也不能被发布门禁忽略。

`test/browser-strict-smoke.test.mjs` 的合成证据测试用于验证验收器不会接受伪成功，不能算作真实 Chromium OS 隔离实测。root 主机运行脚本应明确返回 `non_root_required`，不会尝试 `--no-sandbox`。
