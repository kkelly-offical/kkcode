# 严格任务的离线 npm 依赖环境

严格工作树默认没有 `node_modules`，也没有外网。依赖准备由宿主单独进行；模型不能发一个 `npm install` 就获得网络或宿主凭据。准备成功不代表任务已接入依赖：任务宿主还必须恢复真实环境句柄、核对清单和镜像，并为独立工作树准备只读挂载点。

## 实际支持范围

- npm `package-lock.json` v2/v3，普通注册表 tarball，Linux 宿主和 Linux 容器。私有签名存储目前使用 Linux 固定目录句柄原语；Windows／macOS 原生宿主准备和恢复会明确拒绝，不会退回存在父目录换链竞态的普通文件读取。不能将 Linux Docker 测试算作这两个宿主的验收。
- 固定本机镜像摘要，不自动拉镜像；该镜像须已有 Node、npm、`/bin/sh` 和严格后端要求的基础工具。
- 每个 tarball 必须有单一 SHA-256、SHA-384 或 SHA-512 SRI。主机按明确批准的 registry origins 获取，禁止重定向、URL 用户信息和查询参数。仅显式本机验收可用 HTTP；一般来源要求 HTTPS。私网开关不允许云元数据地址。
- 无脚本包可直接成为 `ready` 环境；有 `preinstall`、`install`、`postinstall` 的包，安装后先处于 `needs_offline_build`。只有宿主独立批准包含包路径、事件、原始命令和 SHA-256 的完整脚本清单后，才会在离线私有 job 中运行。根项目安装脚本从不在准备阶段运行。
- 已实际验证 esbuild 0.28.2：SRI 下载、离线安装、独立批准 `node install.js`、只读依赖环境中的打包和 `npm test`，以及同一固定 LSP 镜像里的 TypeScript 包类型解析。

当前**不支持** pnpm/Yarn/Bun、monorepo workspaces、Git/目录依赖、别名包、捆绑 `node_modules`、归档内硬链接／符号链接、含 `.env`／`.npmrc`／`.git` 等严格后端私密路径名称的包，以及隐式 node-gyp（包括真实归档中有 `binding.gyp` 的情形）。KK Code 本仓库有 workspaces，因此不能据此声称本仓库完整安装已经支持。带原生构建或联网下载的安装脚本可能在隔离环境内失败；失败不会增加网络权限。不能通过手动复制 `node_modules` 或修改回执绕过这些限制。

## 授权与完整性

1. `inspectNpmEnvironment` 在只读隔离容器中读取两份清单，返回不可变计划。计划 ID 绑定原始清单字节、镜像 ID、平台、包路径／版本／URL／SRI、允许来源、私网选择和配额。检查本身不下载、不执行包代码。
2. `prepareNpmEnvironment` 要求真实宿主 `authorize(plan)`。确认后重读源码清单，拒绝确认期间的修改。逐个下载包并验证 SRI，在独立、有内存和时间上限的 worker 中审核归档。展开字节按每个安装路径计量，缓存去重不会漏算重复安装。
3. 只将清单与已核验 tarball 复制到项目之外的私有 job。**仅 job 副本**的 `resolved` 改为缓存文件；原锁文件不改，版本和 SRI 不改。固定镜像执行 `npm ci --offline --ignore-scripts --no-audit --no-fund`，不挂原仓库、认证文件、宿主 HOME 或 Docker socket。
4. 如果有安装脚本，另问 `authorizeScripts(scriptPlan)`。没有回调或返回非 `true` 时仍保留 `needs_offline_build`，不能挂给任务。`scriptsHash` 绑定本次 planId、imageId 和完整脚本清单；即使命令仍是 `node install.js`，只要包内容／SRI／镜像变更，就不能复用旧的脚本授权。命令只能来自已验证包；运行前重新比对提取后的 `package.json` 和命令 hash，不接收模型提供的“已批准”。脚本不获得额外网络，也看不到原仓库和宿主密钥。
5. 最后核对 job 清单未被安装修改，遍历并绑定真实依赖树。拒绝外向链接、特殊文件、超限文件和变化中的文件。esbuild 产生的内部硬链接会在隔离 job 中先证明全部链接都在依赖树内，再物化为独立文件。
6. 私有回执使用宿主存储中的 HMAC 密钥签名。默认目录是 `userRootDir()/dependency-environments`，遵循 `KKCODE_HOME`；密钥不写入 Git、artifact 或日志。存储不得放在源码项目内，也不得与项目形成父子目录。环境恢复核验签名和实际内容，JSON 克隆不能冒充已验证句柄。

每次严格执行前，仍核对当前项目清单、固定镜像和环境内容。`package.json`（含 scripts）或锁文件发生任何字节变化，旧环境立即失效；需要重新准备和验收，不能沿用旧依赖成功结论。

## SDK

```js
import {
  inspectNpmEnvironment, prepareNpmEnvironment, restoreNpmEnvironment,
  prepareNpmWorkspace, verifyNpmEnvironment,
} from '@kkelly-offical/kkcode/sdk/environments'
import { createDockerExecutionBackend } from '@kkelly-offical/kkcode/sdk/runs'

const plan = await inspectNpmEnvironment({
  cwd: sourceRepository,
  image: approvedImmutableImage,
  registryOrigins: ['https://registry.npmjs.org'],
})
const environment = await prepareNpmEnvironment({
  plan,
  authorize: showExactPlanAndAskUser,
  authorizeScripts: showExactOfflineScriptsAndAskUser,
})
if (environment.status !== 'ready') {
  // 未批准安装脚本：不能把该环境交给任务。重新 prepare 并独立批准，
  // 不就地修改已经签名的环境。
  throw new Error('依赖还需要独立的离线构建批准')
}
await prepareNpmWorkspace({ environment, cwd: isolatedTaskCopy, image: plan.imageId })
const backend = createDockerExecutionBackend({ image: plan.imageId, dependencyEnvironment: environment })
```

跨进程保存 `environment.directory` 和自定义的 `storageRoot` 即可；恢复时调用 `restoreNpmEnvironment`，不能直接反序列化当成句柄。持久化的检查计划需要重新 `inspect` 并严格比较 `plan.id` 后才能批准准备。

`prepareNpmWorkspace` 是明确的宿主变更：只为已经建立的独立任务／验收副本创建空 `node_modules`。非空目录、符号链接不会被覆盖。不能用它暗中修改原用户仓库。运行时固定挂载 `/workspace/node_modules:ro`，无任意 mount、环境变量或 PATH 入口。npm 自身的 script runner 会正常将 `.bin` 加入 PATH。

主执行后端的 `createVerificationBackend` 继承同一真实环境，不能验收时偷偷换依赖。子任务由任务图宿主传入同句柄，节点 JSON 不能选环境。严格 LSP 可通过 `createLanguageService({dependencyEnvironment, ...})` 复用；它必须与任务使用同一镜像摘要，例如将已锁定的 LSP bundle 镜像同时作为任务基础镜像。宿主模式 LSP 不接受此私有挂载。

实际执行结果的 `isolation.dependencyEnvironment` 带上经宿主核验的 `id`、`planId`、`treeHash` 和 `imageId`，用于对照主任务、独立验收和 LSP 的真实依赖版本；该字段不包含环境路径、签名密钥或注册表凭据。

## CLI

```sh
kkcode environments inspect --cwd /path/to/project \
  --image sha256:<approved-local-image> --registry https://registry.npmjs.org

kkcode environments prepare --cwd /path/to/project \
  --image sha256:<approved-local-image> --registry https://registry.npmjs.org \
  --confirm-hash <exact-plan-id>

# 仅在上一轮确实返回 needs_offline_build、并审核了完整 scriptApproval 后：
kkcode environments prepare --cwd /path/to/project \
  --image sha256:<approved-local-image> --registry https://registry.npmjs.org \
  --confirm-hash <exact-plan-id> --confirm-scripts <exact-scripts-hash>

kkcode environments verify /private/environment/library/npm-xxxxxx \
  --cwd /path/to/project --image sha256:<same-image>
```

自定义环境库存储使用 `--storage-root`，之后恢复和 verify 也要指定相同目录。`prepare` 不带 `--confirm-hash` 只显示计划；不匹配时不下载。安装脚本授权不会附带网络权限；第二次准备创建新的不可变环境，保留旧的待批准环境。

在原有 `kkcode runs start` 命令上添加 `--environment <environment.directory>`；自定义环境库另加 `--environment-store <storageRoot>`。CLI 会在独立 task 副本中准备挂载点，私有 run metadata 仅保存 id、planId、treeHash 和路径引用。resume 时再次恢复并核验，不把 JSON 引用当作权限凭证。源项目不会因此出现 `node_modules`。

## 限额与已知边界

默认最多 2,000 个锁条目、单包 64 MiB 下载、总下载 512 MiB、总展开 1 GiB 和 200,000 个文件／目录。宿主可调低，不能通过 SDK 提高超过上限。空文件、重复安装和 `.bin` 链接在解包前单独按数量计量，不能只凭字节数绕过 inode 配额。归档 worker 有独立内存和 15 秒限制；容器有 CPU、内存、PID、命令时间和输出上限。安装脚本还继承固定单文件硬限制（不超过 64 MiB，具体 shell 的块单位可能更小）。准备完成后，环境总量再次实测。

**目前没有宿主 bind 目录的执行时硬总磁盘 quota。** 归档安装总量在运行前可以准确限制，但获批安装脚本可以生成新文件；最终 seal 的总量限制是事后验收，不是运行中的硬磁盘配额。生产宿主应把依赖存储放在有磁盘配额或独立容量限制的卷上。不能把这个实现描述为对任意恶意安装脚本都有硬总磁盘隔离。对无法接受该风险的部署，不批准离线脚本即可。

需 `.npmrc` 的自定义安装策略、私有注册表凭据或生命周期依赖顺序等复杂项目，当前可能明确失败；不会读取原项目 `.npmrc`、继承宿主 npm token，或自动切到联网安装。清单变化后的增量重准备和环境 GC 尚无自动化策略，已签名环境保持不可变；删除应由宿主管理界面明确选择确切环境。

## 验收

```sh
KKCODE_STRICT_TEST_IMAGE=sha256:<local-image-id> node --test test/npm-environment.test.mjs

# 真实公开 esbuild 包 + 同一锁定 LSP 镜像；只下载，不向公共服务写入。
KKCODE_DEPENDENCY_LIVE=1 \
KKCODE_STRICT_TEST_IMAGE=sha256:<locked-lsp-image-id> \
KK_LSP_REAL_IMAGE=sha256:<locked-lsp-image-id> \
node --test --test-name-pattern='real locked esbuild' test/npm-environment.test.mjs
```

覆盖 npm v2/v3、真实断网 install/build/test、根安装脚本不执行、脚本独立授权、密钥和源码不可见、主执行与独立验收共用、只读写入失败、当前清单变化、内容／签名篡改、外向链接、重复归档展开计量和非空挂载点保护。没有 Docker 或未明确选择公开包验收时，条件测试会显示 skip，而不会伪报真实通过。

依据：[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)、[package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)、[esbuild 安装说明](https://esbuild.github.io/getting-started/)。
