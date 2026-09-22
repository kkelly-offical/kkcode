# KK Code 1.0.1-preview.2

第三个预览版，非 `1.0.1` 稳定版。2026-09-22 已发布到 npm `preview` 和
[GitHub prerelease](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.1-preview.2)；
稳定 `latest` 保持 `1.0.0`。公开注册表安装、CLI 版本和 SDK 导入已复验。

## 安装

```sh
npm install -g @kkelly-offical/kkcode@preview
# 固定本版
npm install -g @kkelly-offical/kkcode@1.0.1-preview.2
kkcode --version
kkcode -web
```

刚发布时镜像可能有同步延迟，可加 `--registry=https://registry.npmjs.org`。
GitHub 同时附有经过相同校验的 npm tarball、正式 APK、SBOM 和 SHA-256 清单。

需要 Node.js >=22.12.0。`grep/glob` 需要 `ripgrep` 在 PATH：Ubuntu/Debian
安装 `ripgrep`，macOS 使用 `brew install ripgrep`，Windows 使用
`winget install BurntSushi.ripgrep.MSVC` 或 `choco install ripgrep`。

## 相对 preview.1

- M32/M33：CLI 提示/日志分流、主题令牌、后台 MCP、回合结束状态机、长文本折叠。
- 音视频输入从接口预留变成实际编码；补齐跨平台剪贴板文件/媒体读取、TUI/
  行模式能力检查、Web/Android 上传及请求前拒绝，不再误报附件成功。
- 目录定价进入本轮成本、压缩成本和委派预算。优先显式定价文件，其次当前渠道
  的目录价格，再回退内置估算；缓存缺失价格和非 USD 价格不冒充可靠账单。
- 模型选择器显示能力，`?` 标记名称推断；修复 Web/Android 把
  `model_capabilities` 当成模型渠道的问题。
- MCP 加载摘要通过设备 SSE/WebSocket 和中继设备流到达客户端；只发计数及
  有限失败名称，不发命令、stderr 或凭据；访客分享不泄露设备配置。
- M28 G10–G12：按需工具发现、根到工作目录的指令继承、兼容别名下的统一工具
  广告面与 task brief；补齐技能用户调用和 allowed-tools 限制。
- CI 显式安装 ripgrep，Windows 路径测试规范化；受控面板启动时退出的竞态
  修复，避免停止后重新创建保活定时器。测试与 CI 现在有明确超时边界。
- Android 事件流取消会立即终止连接，不把主动断开显示成网络错误；同游标
  状态帧不再被误丢弃。历史媒体切换渠道时，token 计数与推理共用能力检查。
- CLI/Web/Android 登录导航固定在所选网关；凭据和 RPC 请求不跟随 HTTP
  重定向。静态告警逐类复核，不关闭规则来制造“零告警”。

详细行为：[媒体输入](media-input.md)、[工具与技能](tool-discovery-and-skills.md)、
[远程事件协议](remote-sse-contract.md)、[实施记录](implementation-1.0.1.md)。

## Android 与企业网关

Android 为原生远程客户端，APK `cn.kkcode.remote` / `10003`，沿用项目正式
证书，签名私钥不进入 Git/CI。公开 APK 在同名 GitHub 预发布附件中；不能用
debug 签名冒充正式产物。详见 [Android 签名验收](android-release.md)。

```sh
git clone --branch v1.0.1-preview.2 --depth 1 https://github.com/kkelly-offical/kkcode.git
cd kkcode
```

网关入口为 `apps/gateway/main.mjs`，设备端是用户电脑上的 `kkcode remote`。
SSO 属于独立 OIDC 身份服务，不应在公网部署设备端来代替网关。
参见 [部署说明](enterprise-deployment.md) 与 [HA/恢复](enterprise-ha-recovery.md)。
升级前备份数据库和设备状态，保留原 OIDC client/callback、加密/会话密钥与
Android 证书；先用一台设备验证，再滚动升级。协议版本仍为 `1`。

## 验收与边界

已通过：Node 全量/覆盖率、JSONL e2e、Web 实际浏览器、协议兼容、
企业实验环境、Android 单元/模拟器/正式 APK、Linux/Windows/macOS CI、
JS/Actions/Kotlin CodeQL、不可变 npm tarball 与生产依赖审计。
本地 Node 2,856 通过 / 1 平台跳过 / 0 失败，E2e 33/33；Android 单元 35、
界面 22、真实网络 3、TLS 1 项通过。CI 各平台的具体通过／跳过数量和发布
链接记录在 [preview.2 工作台账](preview.2-worklog.md)。
告警修复与误报依据见 [本轮安全复核](security-review-1.0.1-preview.2.md)。

真实模型对视频的协议支持、桌面剪贴板策略、企业租户 claim 映射、公网 DNS/TLS、
多网关部署拓扑、异地备份和实体 Android 设备仍有各自的环境验收责任。
已有实验脚本或 CI 通过不等于所有企业环境自动可用；可信网关可以看到转发内容，
默认不持久化对话正文。这些是支持边界，不是隐藏的“已完成”宣称。
