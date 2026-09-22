# KK Code 1.0.1 使用与升级说明

本版将三轮 `1.0.1-preview.*` 的企业远控、WebUI、Android、SDK 与 CLI 改进带入
稳定渠道，并加入 GitHub Android 更新源、像素视觉主题和明确的远控目录授权。
最终测试／发布记录见 [验收账本](stable-1.0.1-worklog.md)；历史预览记录保留原版本
和当时的边界，不代表正式版未实现。

## 安装和升级

```sh
npm install -g @kkelly-offical/kkcode@1.0.1
kkcode --version
kkcode doctor
```

需要 Node.js >= 22.12 和 PATH 上的 ripgrep。npm `latest` 对应稳定版，`preview`
仍是主动试用渠道。公开 SDK 与协议入口随同一个 npm 包提供，不需要另安装私有
workspace 包；headless JSONL schema 保持不变。

Android 从 [v1.0.1 Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.1)
下载 `kkcode-android-1.0.1.apk`，覆盖安装已有正式签名预览版，**不要先卸载**。
版本码为 `10004`，沿用同一项目证书。App 的个人资料版本号现在可进入更新页；
自动检查和手动下载／系统确认安装见 [应用更新说明](android-app-updates.md)。
不需要额外更新服务器，企业更新管理暂缓。

## 远控启动先确认目录范围

```sh
kkcode remote --gateway https://coding.example.com
```

交互启动会先询问是否信任远控访问“当前系统用户有权访问的所有普通目录”；
接受后可浏览所有本地普通目录，拒绝或直接回车只开放 home。首次设备绑定仍需
浏览器 SSO 登录确认，文件范围授权不会取代账号登录。

非交互启动必须显式选择一个范围：

```sh
kkcode remote --home-only
kkcode remote --root /path/to/workspace
kkcode remote --all-folders
kkcode remote status
```

`--trust` 是工作区扩展信任，不是全盘授权。目录同意也不提升 OS 权限、不绕过
工具审批、不开放 SSH 密钥、模型凭据、KK Code 私密状态和系统私密路径。退出
远控终端即停止暴露；不会悄悄安装后台常驻服务。详见 [目录边界](remote-folder-browsing.md)。

## 模型自动发现与兼容端点

在 Web／Android 的连接／模型设置里填写 HTTPS Base URL 与 API key，读取服务
自己的模型列表，再选择并保存实际模型 ID。临时发现请求默认 OpenAI-compatible，
也保留显式 Anthropic／网关协议；失败不使用内置列表冒充在线发现。

本版修复 vLLM 兼容端点的两处问题：未显式配置时省略 OpenAI `reasoning_effort`，
由服务使用自己的默认；稳定／动态系统提示合并为一条位于最前的 system 消息，
仍保留稳定块的缓存标记。没有硬编码千问模型名或统一强制某个思考等级。
Base URL 应带正确 API 根路径（常见 `/v1`）；带凭据连接必须 HTTPS，不能为了
本地调试关闭 TLS 校验。见 [模型发现](gateway-model-discovery.md)。

## Web／Android 主题

在既有布局上采用黑白／纸白表面、细边框、克制像素底纹与切角样式；模型、权限、
模式、设备、工作目录等控件保留原位置和功能。红绿 diff、连接状态、错误颜色
保持语义；启动仍是紧凑会话首页，配置藏在菜单和分层设置页。

Web 镜像由本仓库 `deploy/Dockerfile` 构建，内含同一份 WebUI。已有生产网关
不会因为 CLI 或 APK 升级而自动改变样式，需要部署管理员拉取本版源码并重建
网关镜像；不需要迁移按键布局或另起一个前端服务。

```sh
docker build -f deploy/Dockerfile -t kkcode-gateway:1.0.1 .
```

本项目不宣称已经把该镜像发布到某个公共容器仓库。企业部署仍需 HTTPS、OIDC、
PostgreSQL、备份和自己的密钥托管。先做备份，再滚动升级实验网关／一台设备，
验证后再升级生产，见 [部署说明](enterprise-deployment.md)。

## 验收和不承诺的范围

单元、E2E、真实 DeviceService/Web、Android、跨平台 CI、包验证和安全扫描均为
发布门禁；真实安装测试与模型请求也单独记录，不用 mock 替代实际结果。
模拟器不代表所有物理手机和 OEM 安装器；标准 OIDC 兼容不等于测试过所有企业
租户；网关进程 HA 不等于供应数据库基础设施 HA。部署者仍负责公网 DNS/TLS、
异地备份、签名密钥长期保管和自己的合规验收。
