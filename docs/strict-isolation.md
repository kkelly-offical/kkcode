# 严格委托执行与范围授权

[文档导航](README.md) · 适用源码：1.0.5；[发行状态](versions.md)

严格委托使用独立任务工作区和 Docker Linux 容器；普通交互的旧 `off`／`auto` 沙箱语义不变，`bwrap`／`sandbox-exec` 不因此被标记为严格后端。严格模式缺失能力时失败关闭，不回退到宿主 Shell。

## 执行环境

- 镜像必须由宿主提前审核和准备，使用本地 `sha256:<image-id>` 或 `repository@sha256:<digest>`。不自动 pull、不接受浮动标签、不允许远程 Docker 上下文或镜像自声明额外卷。
- 要求 Linux Docker、可用的 CPU／内存／PID 限额和默认 seccomp。Windows／macOS 应使用本机 Docker Desktop 的 Linux 环境；真实跨平台验收单独记录，不能由参数单测代替。
- 镜像须包含 `/usr/bin/env`、`/usr/bin/timeout`、`/bin/sh` 与 Node.js。任务开始前真正运行探针核验 capability 清零、NoNewPrivs、seccomp、只读根目录、无出网网卡及无 Docker socket。
- 根文件系统只读，删除全部 capabilities，禁止新增权限，网络 `none`，私有 IPC／cgroup／PID；仅挂载规范化的任务工作区和独立 `/tmp` tmpfs。
- 子进程环境从空环境建立，只设置固定 PATH、HOME、TMPDIR、LANG、CI；不继承模型凭据、SSH Agent、代理或用户 Shell 环境。执行 UID／GID 与宿主用户一致；若宿主用户是 root，容器 UID 也是 0，但没有 capabilities，且仍受只读文件系统、seccomp 和无新增权限限制。
- 默认上限：2 CPU、2 GiB 内存（含 swap 总额相同）、256 PID、512 MiB 临时目录、8 MiB 输出、120 秒命令。命令同时有容器内超时和宿主超时；镜像内容及 Docker daemon 本身属于可信计算基础。

Docker 官方说明了这些运行限制及 `none` 网络行为：[运行参数](https://docs.docker.com/reference/cli/docker/container/run/)、[无网络模式](https://docs.docker.com/engine/network/drivers/none/)。rootful Docker daemon 权限很高；条件允许时部署方应采用经过验收的 rootless 配置，而不能把容器理解为对内核漏洞的绝对防护。[Docker 安全模型](https://docs.docker.com/engine/security/)

## 工作区与文件工具

协调器必须创建并验证独立工作区，不能把主工作区伪装为委托目录。后端还会拒绝系统根目录、用户主目录、工作区外路径别名、硬链接和特殊文件。

合同 `allowedPaths: []` 对应整个工作区只读；`allowedPaths: ["."]` 对应任务副本读写。初版不接受其他细粒度路径合同，不会将其静默扩大为整个仓库可写。

`.git`、`.kkcode`、`.env*`、SSH／云凭据目录和常见包管理器认证文件在容器中被空的只读挂载覆盖。不会复制凭据或挂载宿主 Git 公共目录；容器内依赖共享 Git metadata 的命令可能不可用。Git 物化、候选验收和交付须经独立受控流程处理。

严格工具白名单是 Bash、UTF-8 源文本 read/write/edit/patch/multiedit、目录 list、任务 todowrite，以及拥有宿主认证 run scope 的 artifact_read/artifact_search。只有纯任务状态更新和按不透明引用读取本任务产物可调用受控宿主服务；普通文件操作都在容器执行，不是宿主 `realpath` 检查后再裸读写。已有文件编辑需要同一后端读取过且内容哈希未变；批量编辑预检全部文件并在错误时尝试恢复。

Bash呈现的容器根路径 `/workspace/...` 与严格文件工具统一映射到同一个任务副本。
这不是访问宿主 `/workspace` 的授权；上级路径、敏感目录及越界链接仍被拒绝。确定在
执行前拒绝的操作由宿主私密凭证记为未执行，模型可纠正路径后继续；普通错误码、
JSON布尔或内层子操作的未执行说明不能清除已发生的外层副作用。

当前严格 read 不承诺普通 read 的图片／PDF 解码；grep/glob、MCP、插件、任意 Hook、嵌套委派不自动放行，模型可通过隔离 Bash 使用镜像内已安装的搜索工具。所有扩展启动也须由协调器关闭，不能只过滤显示出来的工具名。

宿主明确确认合同 `allowedNetworkOrigins` 并传给后端 `networkOrigins` 后，才会增加受控 webfetch/websearch/codesearch、只读 HTTP 和隔离 Browser 工具；项目的 `data_policy` 只进一步收紧，不因出现列表就自行授予网络能力。每次调用使用合同与有效项目策略的交集，网页请求逐跳检查。通用 HTTP 仅允许无 body 的 GET／HEAD，拒绝认证与任意自定义头。Browser 强制已固定的 Chromium 和原生沙箱、最小进程环境；不可用时明确失败，不复用关闭沙箱的旧会话。个人浏览器桥接不属于严格白名单。以上均为有限可信内建适配器，不存在任意宿主插件 invoker；Bash 容器仍然 `network none`。

### Browser外部效果

`allowedPaths` 只表示工作区文件写权限；`allowedTools:["browser"]` 和网络origin也不
等于网站写权限。严格Browser默认只放行GET/HEAD，阻断页面脚本偷偷发出的POST/PUT等
请求及WebSocket。click、fill、press、upload或接受dialog等动作须匹配合同的精确
`allowedExternalActions`（例如 `"browser.click"`），再逐动作获得真实宿主批准。
普通的全局readonly权限或组织deny仍优先，不因声明外部动作而放宽。

授权绑定任务、账号、拥有者代次、操作意图、精确参数，以及当前页面／标签／frame／
导航版本。批准期间导航、换页或任务状态变化不能沿用旧授权；动作结束便收束请求窗口。
同一选定文档在授权期间产生的请求仍受origin和frame限制。已发送的非幂等请求报错或
断连保留未知结果，不能用随后一次snapshot把它改成成功，也不自动重放。

严格委托暂不支持development模式及WebSocket/HMR；普通交互的显式development模式
和本机Bridge行为不受此限制变更。依赖POST实现只读查询的网站可能在严格只读路径中
不可用，应明确处理限制，不偷偷开放。GET/HEAD是HTTP方法约束，不是“任意网站绝对
无副作用”的证明。以上新增路径仍须实际非root CI验收，不能以root组件fixture代替。

独立验收可以通过 `createVerificationBackend({readOnlyPaths})` 复用已验证的镜像摘要和资源限制，绑定另一份私密候选副本。只读路径会收紧至第一层已有目录／文件，防止通过重命名父目录替换冻结测试；工作区根可创建新的构建输出目录。后端不负责生成副本，候选物化、完整性指纹和生命周期由独立验收协调器负责。

取消时只停止并删除本次随机命名且所有权标签匹配的容器，不运行 prune、不触及其他容器。无法确认清理或命令状态时报告“结果需要核查”，不能宣称没有副作用。工作区 bind mount 没有跨平台可移植的总磁盘硬配额；部署方仍需独立任务卷、磁盘容量监控和清理策略，不能把内存／tmpfs 限制当作整个工作区的磁盘额度。

## 范围授权

`createScopedGrantAuthority` 是宿主专用能力，不作为模型工具。它在仓库外保存长期签名密钥和持久授权账本；真实用户／组织确认后才能签发。授权绑定：主体、任务、动作、资源指纹、资源版本、逻辑操作 ID、参数指纹以及最长 24 小时有效期。

先持久化操作意图，再 `verifyAndConsume` 一次性消费；参数、目标、候选版本改变会使旧授权失效。撤销、超时、跨账号使用、重放和损坏账本均拒绝。立即提交前可以 `verifyContinuation` 再检查已消费的同一逻辑操作；此方法不是重新执行已完成副作用的许可，操作账本仍必须阻止重放。

授权令牌不应发送给模型或写入一般会话日志。它不代替任务范围、数据出域、平台权限或沙箱；模型的自审意见也不能签发授权。

## 验收方式

`test/strict-isolation.test.mjs` 包含参数／授权单测和真实容器用例。设置 `KKCODE_STRICT_TEST_IMAGE` 为已在本机存在的固定镜像 ID 后运行，验证离线构建、宿主秘密 canary、凭据文件遮蔽、只读合同、容器文件编辑、路径别名／硬链接、取消及容器清理。未配置镜像时真实用例明确跳过，不报告为已完成实测。

## Recipe 工作区边界

`browser_recipe` 不会把源目录的批准自动复制到独立委托/任务图 worktree：默认按设备账号与规范工作目录隔离，需要在具体工作区录制、审核、验证和启用。严格任务还必须在合同中明确允许相关工具和目标 `allowedNetworkOrigins`，并满足有效 data_policy；每个 Browser 叶动作继续走正常权限与持久执行。固定 recipe 不是额外网络授权，Bridge 从不属于 strict 执行路径。将来若需跨 worktree 共享，必须设计显式宿主映射/allowlist，不接受模型自行提供源路径。
