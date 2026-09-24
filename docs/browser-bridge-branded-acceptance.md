# Chrome / Edge 品牌浏览器 Bridge 验收

本指南对应未发布的 **1.0.5-preview.0** 开发工作树。
`scripts/browser-bridge-branded-smoke.mjs` 是 **GitHub-hosted 临时 CI runner 专用**
验收入口，不是产品启动器，也不是给用户安装扩展的脚本。

它用于分别验证 Windows、macOS、Linux 上已安装的正式 Google Chrome / Microsoft
Edge 与官方 Playwright 扩展的真实连接。六格矩阵必须各有自己的执行回执；在本机
跑六份合成 argv / User-Agent 单元测试，不等于六平台实测通过。当前执行状态以
[实施账本](implementation-1.0.5.md) 和对应 CI 回执为准，不因该脚本存在而视为已验收。

## 临时安装权限的准确含义

脚本仅在新建的、由本次 `mkdtemp` 得到的临时 profile 中启用
`--enable-unsafe-extension-debugging` 与 `--remote-debugging-pipe`，用于调用浏览器
提供的 `Extensions.loadUnpacked` 安装调试接口。固定官方源码来自 Playwright commit
`1b025d7e20a026371cd5f98ba0cdce48892737c8`，扩展版本 `0.4.0`，预期 ID
`mmlmfjhmonkocbjadbfplnigmagldckm`。构建读取该 Git 提交的原始 blob，不使用 checkout
中被修改或未跟踪的源码，也不运行该仓库的安装／构建脚本。

这项权限仅属于 **CI 测试准备**：

- 不验证 Chrome Web Store / Edge Add-ons 商店安装 UI、商店签名分发或自动更新。
- 不沿用用户的个人 profile、登录状态、Cookie 或已有扩展。
- 不打开 TCP 远程调试端口；不使用 CDP 连接用户正在使用的浏览器。
- 不通过 `--load-extension`、`--disable-extensions-except` 等启动参数绕开安装接口。
- 不关闭 Chromium sandbox，不更改 AppArmor／sysctl，不添加 SUID helper。
- 不自动接受浏览器 EULA、登录／首次启动或操作系统权限界面；若出现需要处理的
  初始页面，验收明确受阻，不能自动点击它们换取绿灯。

产品用户仍按 [Bridge 使用指南](browser-bridge.md) 在本机安装官方扩展、核对并
批准页面组。**不要为了在个人电脑运行此脚本而伪造 CI 环境变量或降低安全设置。**
环境变量检查是运维防误用限制，不是对宿主身份的密码学证明。

## 启用条件

工作流中必须明确配置以下输入；无显式选择不会启动浏览器：

| 输入 | 要求 |
| --- | --- |
| `GITHUB_ACTIONS` / `RUNNER_ENVIRONMENT` | `true` / `github-hosted`；不接受普通本机或 self-hosted runner |
| `RUNNER_OS` | 与实际 Windows / macOS / Linux 一致；Linux 必须非 root |
| `KKCODE_BRIDGE_ALLOW_EXTENSION_DEBUGGING` | 精确为 `1`，仅授权本轮 CI 临时扩展安装调试 |
| `KKCODE_BRIDGE_TEST_CHANNEL` | `chrome` 或 `msedge`；Chromium、Chrome for Testing、beta 等不是替代验收 |
| `RUNNER_TEMP` | 已存在的绝对临时目录 |
| `KKCODE_BRIDGE_TEST_RUNTIME` | `RUNNER_TEMP` 下专用、已安装并校验锁定 MCP 运行包的目录 |
| `KKCODE_BRIDGE_EXTENSION_SOURCE` | `RUNNER_TEMP` 子目录，或本次 checkout 的确切 `test-results/bridge-extension-source` |
| `KKCODE_BRIDGE_REPORT` | 可选的 `RUNNER_TEMP` 内新文件路径；不覆盖已有回执 |

运行时会重新检查真实路径，拒绝把 runtime/source/report 的符号链接指向个人目录。
正式浏览器本体需要由受控 runner 预先提供；该脚本不会用项目 Chromium 或 CfT
替代缺失的品牌浏览器。源码工作流为 `.github/workflows/acceptance.yml` 的
`branded-browser-bridge` 六格矩阵，Node 使用当前配置的受支持版本。

在已符合上述条件的 CI 中，Linux 通过临时显示服务器运行：

```sh
xvfb-run -a node scripts/browser-bridge-branded-smoke.mjs
```

Windows/macOS runner 直接运行同一 Node 脚本。不要复制这段命令用于个人浏览器
安装；前置条件不足时的正确结果是 `blocked`。

## 实际检查什么

1. 从真实 browser-level CDP 读取启动参数、版本，再读取当前页面的 User-Agent。
   核对正式渠道可执行路径、唯一的新建 `--user-data-dir`、pipe-only 调试和禁止
   沙箱／安全禁用参数；记录实际二进制 SHA-256 与 runner 镜像版本。
2. 调用官方扩展安装接口，核对实际安装 ID、版本、路径和 enabled 状态。
3. 只在本地合成站点放置测试登录 Cookie。通过扩展自己的 **Allow & select**
   页面批准绿色测试标签，不批准另一个红色标签；不处理真实账号或企业认证。
4. 使用产品 Bridge 完成快照、标签列表／选择、引用点击。数据 URL iframe 中
   确实存在的私密 canary 在返回快照中被省略，不允许把嵌入 frame 当主 frame。
5. 未单独授权时截图必须失败；另行 `allowScreenshots:true` 后检查截图像素属于
   被选择的绿色页面，而不是未批准的红色页面。固定官方截图结果只有 Result，
   没有可用于证明截图时刻来源的 Page URL；回执明确 `imageOriginVerified:false`。
   图片可能包含嵌入内容，这不是像素级 origin 数据隔离证明。
6. 撤销后拒绝继续读取；断开 Bridge 不关闭合成浏览器中仍然打开的两个标签。
   验收结束再卸载临时扩展、关闭本次浏览器／子进程／HTTP 服务，回收本次临时
   profile 和状态目录。清理失败不能产生通过回执。

此脚本的 sandbox 证据是请求配置与**实际进程 argv 中未关闭沙箱**，不单独宣称
完成 Linux kernel seccomp／namespace 或 Windows/macOS OS 沙箱认证。后者应与
[非 root Linux 严格 Browser 验收](browser-strict-acceptance.md) 的具体证据区分。
常规 Bridge 也不是网络防火墙；项目要求严格网页出域围栏时使用隔离 Browser。

## 回执与回归测试

标准输出为一行 JSON；可选报告文件以 `0600` / 不覆盖方式写入指定 CI 临时目录。
回执包括真实 browser/extension/runtime 身份、仅测试准备的额外权限、各行为断言
和清理状态。不会保存个人 profile、真实登录凭据或复制浏览器 Cookie。成功回执
明确 `nativeStoreInstallationUiTested:false`，不能改写为“商店安装流程已通过”。

- 退出码 `0` / `status:passed`：本格真实验收与清理完成。
- 退出码 `2` / `status:blocked`：环境、品牌、初始化页面或安装接口等前置条件不符；未验收。
- 退出码 `1` / `status:failed`：断言或执行失败；未通过。

`blocked`、丢失回执、被跳过的格子都不能被矩阵当作成功；不使用
`continue-on-error` 把它们变绿。即使此矩阵全部通过，也不代表已经发版或部署。

```sh
node --test test/browser-bridge-branded-smoke.test.mjs
```

这些单元测试验证非 CI／未授权／root／越界路径拒绝，六种平台与品牌的合规
argv/UA 验证，禁用沙箱／假品牌拒绝，以及非 CI 调用不会到达浏览器启动。
它们是验收器的回归测试，**没有在本机启动六种品牌浏览器**。
