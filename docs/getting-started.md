# 安装与首次使用

[文档导航](README.md) · [版本与升级](versions.md) · 适用源码：1.0.5（准备中，尚未发布）

## 安装已发布版本

需要 Node.js 22.12+、npm 和现代终端。文件搜索依赖 `ripgrep`（`rg`）：
Linux 可通过系统包管理器安装，macOS 可用 `brew install ripgrep`，Windows 可用
`choco install ripgrep`。检查 `node --version` 和 `rg --version`。

```sh
npm install -g @kkelly-offical/kkcode@latest
kkcode --version
kkcode
```

`latest` 当前对应已发布稳定版，不会安装尚未发布的 1.0.5。需要预览渠道时，
显式选择 `@preview`；当前公开版本和回执统一见[版本与升级](versions.md)。

## 配置自己的模型

在终端使用 `/provider` 配置渠道，通过 `/model` 选择模型；Web/Android 的配置位于
个人信息／设置内，不会在首页铺开表单。优先提供自己的 Base URL 和 API Key，
读取服务返回的模型目录后选择，不必先猜一个内置模型名。

如果服务未提供兼容目录接口，可以明确配置模型 ID。目录发现失败会显示错误或
标明过期缓存，不会静默换成系统内置列表。完整配置见[配置与模型](configuration.md)。
问模型、执行模型探测或审查可能产生费用；不要把“已配置渠道”当作已批准无限调用。

在需要工作的目录启动 `kkcode`。默认 Agent 适合日常问答、修改与测试；
先看不改用 Plan，复杂多阶段任务再选 Ultra。权限差异见[模式与权限](modes-and-permissions.md)。

## Web 与手机

```sh
kkcode -web                 # 仅本机，默认端口18271
kkcode -web -host-18271      # Host模式；对外访问前先配置访问保护与TLS
kkcode remote               # 工作电脑前台远控；首次登录并确认目录范围
```

浏览器或 Android 连接自托管网关，由网关引导企业 SSO 登录。网关和被控电脑是
不同服务；手机不运行 Agent 内核。Android 也可直接 SSH，Web 不代理 SSH。
详见[企业部署](enterprise-deployment.md)、[Android 更新](android-app-updates.md)。

## 从源码运行1.0.5准备版本

```sh
git clone https://github.com/kkelly-offical/kkcode.git
cd kkcode
npm ci
npm run build:web
node src/index.mjs --version
npm start
```

运行结果由 checkout 决定；`--version` 显示1.0.5不代表npm已经发布。
源码中的 `npm ci` 是你在宿主执行的开发安装，不等于严格任务已支持离线 workspaces。
不要用安装教程绕过[严格依赖环境](dependency-environments.md)的限制。

## 常见排查

| 现象 | 先检查 |
| --- | --- |
| 找不到命令／版本不对 | `node --version`、npm全局bin路径、是否运行了另一份安装 |
| 模型列表为空／认证失败 | Base URL、协议、目录接口、API Key及TLS；不要在Issue贴密钥 |
| 项目配置被拒绝 | 先审查项目配置和扩展，再明确授予工作区信任；信任不等于目录或工具授权 |
| 浏览器或文档工具不可用 | 对应引擎／固定镜像和宿主服务配置是否准备好；不会自动安装所有后端 |
| 终端选择、粘贴或输入法异常 | 终端模拟器、tmux/SSH、剪贴板权限；见[终端交互](cli-reference.md#terminal) |
| 手机看不到设备或新功能 | 电脑远控进程、登录账号、网关／设备／App版本；只升级App不会升级服务器 |

`kkcode --help` 查看入口，`kkcode doctor` 检查环境。问题反馈附版本、平台、复现步骤和
脱敏日志；不要上传私密配置、SSH密钥、签名材料或完整会话内容。
