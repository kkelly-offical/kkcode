# 1.0.13 · 客户端精修、附件与应用内配置

已发布 **1.0.13 正式版 / Android10020 / Windows x64**（npm latest）。发行提交 `4c6107c`（PR#56 / #57 / #58），与候选 `8901af6` 同树；Android 沿用原签名证书。

[Windows 安装器](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.13/kkcode-windows-1.0.13-x64-setup.exe) · [Android APK](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.13/kkcode-android-1.0.13.apk) · [设计导出包](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.13/kkcode-design-1.0.13.zip) · [校验回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.13/release-verification.json)

- Windows 增加独立工程导航、项目栏、链接右键打开 / 复制，以及浏览器授权后的 App 回跳。
- Windows、Web、Android 内置统一的正文与代码字体，细化任务进度、控件和输入区；运行横幅不再提供重复的补充按钮。
- 输入区支持粘贴图片、添加文档与附件卡片。Web 支持拖入，Android 支持富内容粘贴；上传失败可以重试，正文和已有附件保留。
- PDF / DOCX / XLSX / PPTX 提取文字进入 Agent 的既有附件链路；不执行宏、公式、外部关系或文档脚本。扫描版 PDF 没有可提取文字时明确提示改用图片。文档 / 图片 / 音视频单个最多 4 MiB，UTF-8 文本最多 256 KiB，每条消息最多 8 个。
- 对话工具入口可以管理 MCP、插件与技能，填写私密环境变量 / 请求头，打开浏览器授权；插件能力审批保留。
- 模型配置可保存在当前设备，或作为账号模板跨端复用。复制后各自独立，后续修改互不覆盖；同名渠道复制时另取名称，不覆盖设备原配置。

账号模板需要升级账号网关。新版网关提供 Windows 专用返回链接；旧网关仍可通过客户端轮询完成登录并恢复窗口。本轮不自动部署其他现网网关。

五端设计独立维护 iPhone、Mac、Android、Windows、Web；Apple 两端此次交付设计稿，应用仍暂缓。检查结果和未完项见 [实施记录](implementation-1.0.13.md)。

## 账号模板的存储

网关按账号隔离模板，数据库保存 AES-256-GCM 密文。可用 `KKCODE_ACCOUNT_CONFIG_KEY` 指定持久化的 32 字节 Base64 加密密钥；否则使用有命名域隔离的 OIDC 客户端密钥派生值，单节点且没有客户端密钥时使用该 OS 账号的私密加密存储生成密钥。多节点必须共享密钥。修改 OIDC 客户端密钥前，应固定账号配置加密密钥并迁移已有密文；不能直接更换密钥后继续读取旧数据。

模板保存带版本校验，避免两端覆盖；读取默认隐藏密钥，只有明确复制时通过已认证接口获取所需配置。复制不形成后续同步订阅。

## 字体来源

正文基于 [Adobe Source Han Sans](https://github.com/adobe-fonts/source-han-sans)，代码使用 [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)。许可证见 [思源黑体](licenses/source-han-sans.txt) 和 [JetBrains Mono](licenses/jetbrains-mono.txt)。字体随客户端提供，不从公共字体 CDN 加载。
