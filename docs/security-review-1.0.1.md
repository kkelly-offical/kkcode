# 1.0.1 正式版安全复核

本轮重点为 Android 外部下载／安装、扩大目录授权和模型兼容请求。生产域名／
租户没有被改动；没有关闭 CodeQL 查询、排除生产代码或批量消除告警。

## 新增边界

- Android 更新使用独立、无 SSO／模型凭据的网络客户端，固定 GitHub 仓库，
  限定 HTTPS 重定向来源、分页、超时、JSON 深度、精确大小和下载上限。
  安装前重新校验文件摘要、真实 APK 包名／版本／非调试标志及项目签名，且要求
  与已安装应用同签名；不能用 GitHub 清单自报的签名替代 APK 检查。
- 安装走系统 PackageInstaller 用户确认；显式 non-exported 回调及 session
  校验。专用 AVD 上真实执行权限设置和系统覆盖升级，安装来源确认为 App 自身，
  升级后偏好及 Keystore 数据保留。没有 root 安装或自动静默授权。
- 全普通目录访问需要终端交互同意或显式范围参数；`--trust` 不扩大文件范围。
  词法根检查、realpath、私密路径／inode 校验保留，Unix 进程环境、设备、运行时
  和系统凭据路径额外排除。Windows 不探测任意 UNC／网络映射驱动器。
- 实际 vLLM 对接没有关闭 TLS 或修改生产模型配置；通过专用 SSH loopback
  隧道和进程级信任的 TLS 适配器连接。API key 仅在私密设备配置中保存，不进
  命令参数、仓库、验收报告或日志。模型服务器未被重新加载或改参数。

## 扫描事实与静态告警

代码 `dc90560` 的 [CodeQL 35741782371](https://github.com/kkelly-offical/kkcode/actions/runs/35741782371)
三组均成功：JavaScript/TypeScript、Actions，以及真正执行 Kotlin Android 构建
的 Java/Kotlin。Kotlin 和 Actions 的本次分析结果数为 0。JS 分析结果计数与
GitHub open 告警数是不同口径；验收分支 open 告警仍为 **17**，不称“零告警”。

沿用 [preview.2 的逐类复核](security-review-1.0.1-preview.2.md)，本轮再次核对：

- 文件根检查后的 realpath 告警归并为 #56（原同类 #53）；#37 的大小写别名
  必须证明物理根身份。扩大 roots 也没有去掉 private/realpath/no-follow 检查，
  新增系统私密路径测试和显式授权测试与原对抗测试同时运行。
- #30–35、#39–41 是固定私密目录及严格 session ID 边界；#43 是所有者配置的
  模型 Base URL，同源分页／重定向限制；#54–55 是用户选择的企业网关，不是
  公网服务接受任意目标后代访。私网部署是合法场景，不能一律封禁私网地址。
- #20–21 是模型目录的密钥隔离摘要，不是密码登录存储；#19 是自定义文件提及
  token 的转义，不是 shell 引号处理。这些静态数据流不能直接当作可利用漏洞。

本机 `npm audit --omit=dev --audit-level=high` 返回 0 个漏洞，打包秘密扫描通过。
这不是容器底层镜像、SSO 租户或应用商店安全认证；发布门禁及最终 main 扫描链接
继续写入 [正式版账本](stable-1.0.1-worklog.md)。
