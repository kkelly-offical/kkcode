# 1.0.2 使用与升级说明

发布目标：1.0.2；实际验收和发布回执以 [实施台账](implementation-1.0.2.md) 为准。
版本仍在 `1.0.x`，不移动已发布的 `v1.0.1` 标签。

## 这次解决什么

- Web 和 Android 的每个会话都有管理入口：改名、归档、恢复；手动命名优先于后台生成。
- 用户提问旁有回退入口，当前会话菜单可回退上一轮。确认后撤回该提问及之后的对话、工具记录和审查记录，恢复提问草稿，并同步其他客户端。
- **对话回退不是文件回滚**。不会撤销代码、提交、外部请求；设备保留最近一次回退前的私有 `checkpoints/<sessionId>/before-rewind.json` 备份。需要恢复文件时单独使用受确认保护的 `/undo` 或 Git 流程。再次回退会更新这份备份，不是无限版本库。
- 分支面板展示本地分支、已有远端引用、提交摘要、跟踪关系和 ahead/behind；支持从选定提交创建分支，以及安全创建和打开 Worktree。
- Web/Android 只保留执行模式与模型选择，不再并排显示独立权限档。终端快捷键提示只留在 CLI；键盘和无障碍导航仍可用。
- 首轮成功对话后，以首轮同一个模型、渠道和临时连接覆盖生成标题，不借用 `models.fast`。失败保留首问摘要，不重试、不阻断正文；可用 `session.title_generation: false` 关闭。额外标题请求有 15 秒/512 输出 token 上限，用量单独计入会话，不增加对话轮数。
- SVG 默认当源代码读取，可正常接着编辑；显式图片预览会先安全渲染为 PNG。损坏的历史图片不会再令整个会话持续报同一个 400。
- 新增内建 Browser 工具：独立浏览器、页面结构快照、点击/输入、截图、关闭；不接管个人浏览器。

## 统一执行模式

| 模式 | 行为 |
| --- | --- |
| Plan | 只读分析与规划；不执行浏览器交互等可能改变状态的操作 |
| Agent | 常规助手；按照确定性策略和用户确认执行 |
| Auto | 普通编辑直接执行；敏感操作由当前对话模型做一次独立审查 |
| Ultra | 分阶段持续推进长任务，保留预算、取消和阻塞边界；沿用 Auto 审查 |
| Yolo | 已授权范围内自主执行，跳过常规人工确认；不解除硬性安全规则 |

`/auto`、`/mode auto` 是正式写法；旧 `/mode agent-auto` 仍接受并映射为 Auto。
旧 SDK `approval` 字段继续兼容，服务端将它归一为一个模式，而不是让两个选择器互相冲突。
CLI 的高级策略配置、显式允许/拒绝规则和治理能力仍保留；简化交互不等于删除安全策略。

### Auto 审查流程

1. 先评估工作区信任、工具/技能边界、显式规则和受保护路径。硬拒绝直接阻止；要求人工确认的治理路径和显式 `ask` 规则不委托模型放行。
2. 普通安全读取/编辑按策略执行。其余可委托的敏感操作，把当前用户要求和**最终实际执行参数**送入独立审查请求。
3. 审查沿用对话实际 provider/model/Base URL/凭据来源；没有工具、不能继续委派、没有后台执行权。最多 30 秒和 2048 输出 token，单次请求不做供应商重试。
4. 严格读取 `allow / deny / ask` 和理由。允许只适用于这一调用，不变成长期授权；拒绝会以工具失败反馈给主智能体；不确定、格式不正确或服务不可用则交给用户确认。无交互通道时不默认放行。
5. 同一对话保留简短可展开的 Auto 审查行，完整决策进审计，用量进入统计。明确取消会停止执行。

这是防御的一层，不是“模型保证安全”的承诺。尤其是新依赖脚本、仓库内不可信页面、凭据、外部发布和生产操作，应保留组织规则与最小权限。

## 会话和 Git 操作

首页每行右侧 `…` 打开管理；归档列表在首页更多菜单（桌面侧栏归档按钮）中。
归档不删除历史，运行中的会话不能归档或回退。共享访客不能修改所有者的会话管理信息。
改名和回退带并发版本检查：另一端刚改过标题或追加消息时，请刷新后重新确认，不覆盖别人的工作。

输入框 `+ → Git 分支` 打开分支和 Worktree 面板：

- 本地分支切换：必须干净、没有 Git 合并/rebase 等进行中操作，且没有相关活动任务；不做自动 stash、reset、clean。
- 远端缓存：只显示已有引用；选择它作为新分支起点不会联网 fetch/pull/push。
- Worktree：选择已授权父目录、新文件夹、新分支和起点。目录必须不存在，创建自已有提交，原目录的脏文件不会复制过去或被丢弃。
- 打开 Worktree：新建一个绑定到该目录的会话；旧会话的 cwd 保持不变。已锁定工作树可查看，不能借此强制删除或解锁。
- 钩子、fsmonitor 和已初始化子模块的 checkout filter 在这些受控操作中禁用。不提供删除工作树、强制覆盖或自动提交按钮。

## Browser 安装与使用

浏览器引擎在运行智能体的**工作电脑**安装，不装在 Android 或中继网关上：

```sh
kkcode browser status
kkcode browser install
# Linux 缺少系统库时，由电脑管理员按需运行：
kkcode browser install --with-deps
```

工具定义默认加载、浏览器按需启动。让智能体“打开本地开发页面，检查按钮并截图”即可。
工具动作：`status`、`open`、`snapshot`、`click`、`fill`、`press`、`screenshot`、`close`。
以语义 role/name 或明确 CSS selector 定位，不开放任意 JavaScript 求值接口。
页面结构/文本最多 24k 字符；截图是模型可读取的像素，并能在 Web/Android 的图片行展开。

- 每个会话使用独立临时 profile，不读取个人浏览器 cookie/password/profile；关闭或闲置回收时清理该临时 profile。
- 最多 4 个浏览器会话，10 分钟闲置回收；每个浏览器会话限制 500 次请求/64 MiB 传输，单资源 16 MiB。
- 明确打开的私网开发源可以访问；其他私网源必须分别明确打开。DNS 地址固定，重定向逐跳校验，拒绝云元数据、链路本地地址、URL 内凭据和非 HTTP(S) 地址。
- 不支持个人 Chrome 接管、CDP 公网端口、弹窗、下载、Service Worker 或 WebSocket。依赖 WebSocket 的应用功能（包括部分 HMR）需要其他验收方式，不能声称已经通过。
- Chromium 默认开启 OS sandbox。`tool.browser.chromium_sandbox: false` 只供受隔离且确有需要的 root CI 实验，不是生产推荐；浏览器自动化本身不是宿主机安全边界。
- 如不需要浏览器工具，可设 `tool.browser.enabled: false`；`tool.browser.executable_path` 可指定管理员安装的兼容 Chromium。

实现基于 [Playwright Library](https://playwright.dev/docs/library)，参考
[Playwright MCP](https://github.com/microsoft/playwright-mcp) 的结构化浏览思路；没有宣称兼容其全部工具或复用用户登录环境。

## 图片与 Harness 修复

本次真实故障是把 SVG XML 字节作为 `image/svg+xml` 原样发给只支持栅格图的 vLLM 图像解码器。
这不是“模型不认识图片”，也不是应该无意义重试五次的网络故障。

- `read({path: "drawing.svg"})` 读取 XML 并建立后续编辑所需的读取状态。
- `read({path: "drawing.svg", view: "image"})` 渲染自包含静态 SVG 为 PNG；外部资源、脚本、嵌入图像、foreignObject、实体、样式导入等被拒绝，不联网加载。
- PNG/JPEG/GIF/WebP 先完整像素解码，不再只验证文件头；按实际格式而非扩展名发请求。必要时纠正方向、缩放到 2048 范围或取动画首帧。
- 每张源图最多 20 MiB/24M 像素，请求最多保留最近 16 张图片。Web/Android 上传另有更小的 4 MiB 配额。
- 老历史在请求副本中安全转换或替换为有理由的文字提示，**不删除原会话文件**。用户可直接继续原来出错的会话；危险 SVG 不会因“历史兼容”而绕过校验。
- MCP/插件返回的多图片、音视频和结构化结果进入共同的工具结果通道；资源链接仅作为引用，不隐式读取。
- 客户端历史只携带图片引用；展开时按 session/message/index 经鉴权读取有限栅格预览，不暴露任意设备文件路径，不渲染 SVG HTML，不向外部图片站自动发请求。
- 非法工具 JSON 返回明确可修复错误，且不触发快照或工具执行。写文件工具说明与真实 schema 保持一致。

参考：[OpenAI 图像输入要求](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)、
[Sharp 解码与像素限制](https://sharp.pixelplumbing.com/api-constructor/)。

## 部署与验收

升级需要覆盖 CLI/设备进程、网关/Web 镜像和 Android；只有替换网页而设备仍是 1.0.1 时，新 RPC 会明确报不支持。
Android 1.0.2 使用 `versionCode=10005`，保持既有正式签名；GitHub 更新仍要求用户在系统安装器确认。
网关仍是 `apps/gateway`，SSO/数据库职责和部署位置没有迁移；见 [企业部署](enterprise-deployment.md)。

```sh
npm run release:verify
npm run test:web
npm run test:browser
# Android: JVM + Compose/HTTP 客户端契约，再做正式签名安装验证
```

本地 fixture、真实 vLLM、真实 Relay、跨 OS CI 和正式 APK 的证据分开登记。
不把模拟 HTTP 服务器当生产 SSO 验收，也不把单个模拟器当所有实体手机支持。
