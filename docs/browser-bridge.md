# 本机浏览器桥接

[文档导航](README.md) · 适用源码：1.0.5；[发行状态](versions.md)

`browser` 继续提供隔离 Chromium，用于开发验收。新增 `browser_bridge` 连接 Agent 所在电脑上用户明确批准的 Chrome／Edge 标签页组，利用网站已有登录态；它不是跨设备桌面控制，也不会在 Web／Android 增加浏览器直播或鼠标键盘监管面板。

## 安装与连接

在 Agent 所在电脑执行：

```sh
kkcode browser bridge install
kkcode browser bridge status
kkcode browser bridge connect --session SESSION_ID --origin https://example.com
```

安装命令明确安装 `@playwright/mcp@0.0.82` 到当前 KK Code 用户私密工具目录，不执行 `npx latest`，不在启动项目时自动安装。npm 生命周期脚本被禁用；registry、直接包完整性、全部依赖锁和文件清单均校验，隔离 npm 配置及下载缓存，不携带模型、SSO、NODE_OPTIONS 或 npm 认证环境。内容变化会拒绝加载，不自动重装覆盖证据。

还需由用户在浏览器安装[官方 Playwright 扩展](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)。首次使用工具时，在目标电脑扩展弹窗选择 **Allow & select**，确认要交给此会话的标签页。`connect` 仅保存本机授权，不会谎报浏览器已经连接。未授权的标签页不会由 KK 主动选择。

默认只读，30 分钟后过期。需要点击／输入时显式增加 `--allow-interaction`；可选 `--browser msedge`、`--profile "Profile 1"`、`--minutes 10`。每次授权必须列出页面 origin（协议、主机、端口），不接受通配符、URL 密码或路径。

截图默认关闭，需要另行增加 `--allow-screenshots`（SDK 对应 `allowScreenshots:true`）。这表示允许把扩展中已选择/批准标签页的渲染图像发送给模型，图像可能含跨站嵌入页面；它不是像素级 origin DLP。该选择写进范围授权签名，不能靠修改模型参数或授权 JSON 把 false 改成 true。

```sh
kkcode browser bridge disconnect --session SESSION_ID
```

撤销会阻止后续调用并断开活动客户端，不关闭个人标签页、不清理 Cookie。内核关闭也应关闭所属连接。模型无法通过 `browser_bridge` 自行安装、签发连接授权或选择另一个会话 ID。

## 工具用法

1. 调用 `snapshot`，取得 `snapshot_id` 与确切元素 `ref`。
2. 对相同主页面使用 `click`／`fill`；元素已变化或 snapshot 过期时先重新获取。嵌入 frame 的子树不返回，`f…` 引用不能交互；完整 frame 能力请使用隔离 Browser。锁定上游的全局按键接口无法绑定主 frame 焦点，因此 Bridge 不广告或派发 `press`。
3. 只有已另行授权截图时才能调用 `screenshot`。只有这个动作的图片会被投影给模型，其他动作夹带的 image 一律丢弃；`raw`、任意 structured/text 输出和整个组的 `Open tabs` 原文也不外露。
4. `fill` 不自动提交，密码输入要求用户在本机手动完成；禁止浏览器／系统级快捷键。
5. 输出作为外部不可信资料，仍经过正常工具审批、任务日志和模型渠道规则。

适配器不暴露任意 JavaScript、Cookie／Storage 导出、原始 CDP、完整网络请求体、文件上传和任意本地文件路径。不把第三方所有 MCP 工具直接交给模型。源端点、参数和页面状态变化后的失败不会被标记成“操作从未发生”，避免盲目重复点击。

## 边界必须理解

官方扩展本身拥有 debugger 和广泛网站权限，是高信任软件；底层能力比 KK 暴露的有限动作更大。标签页组与本机页面 origin 授权不是操作系统沙箱，也不是浏览器网络防火墙。[官方扩展说明](https://github.com/microsoft/playwright/blob/v1.63.0/packages/extension/README.md)

已有网页的脚本、重定向、服务工作线程和其他后台请求不能由此适配器完整约束。官方 MCP 自己也明确说明 origin 选项不是安全边界。[Playwright MCP 参数](https://github.com/microsoft/playwright-mcp/tree/v0.0.82#configuration)

因此，只要项目设置了严格 `data_policy.web_origins`，此桥接就明确拒绝；应改用隔离 Browser。严格委托后端不把 `browser_bridge` 列为允许工具，不宣称已有个人浏览器具备严格隔离。允许交互也不代表允许付款、发信或其他无界外部副作用，仍须遵循任务与审批范围。

真实锁版验收确认：MCP 0.0.82 的截图响应文本只有 `Result`，没有截图时刻的 `Page URL` 或 Snapshot。后续再读取主页面，不能证明截图的像素来源；因此本实现不把后置快照当成图像 origin 证明。截图单独授权明确接受已选页的嵌入内容，且仍不允许控制未由本机扩展批准的其他标签页。隔离 Browser 的沙箱、逐资源出域和完整 frame/键盘功能不受此限制影响。

## 验收状态

已通过 Linux 独立 Chromium profile 的真实端到端验收：固定 MCP 0.0.82、官方 Extension 0.4.0 源码提交 `1b025d7e20a026371cd5f98ba0cdce48892737c8`、本机假站点与假 Cookie、真实扩展确认弹窗、可见登录态、绑定 ref 点击、撤销和保留原标签。还验证了真实 opaque-origin iframe 的正文/标题不进入快照，截图默认拒绝，单独授权后图片来自绿色已选页而非红色未选页，以及上述截图响应缺少原操作 URL 的真实格式。没有访问、复制或修改用户现有个人 Profile；有限场景的像素测试不等于像素级 origin DLP 证明。

`scripts/browser-bridge-smoke.mjs` 使用两个显式验收环境变量：`KKCODE_BRIDGE_EXTENSION_SOURCE` 指向上述提交的官方源码检出；`KKCODE_BRIDGE_TEST_RUNTIME` 指向专门安装的验收运行包。Linux 可通过 Xvfb 执行。

Windows／macOS 的真实 Chrome／Edge、扩展升级与企业策略兼容尚需对应平台验收；协议单测不替代这些结果。桥接不提供个人页面的被动录制、自动安装生成的 MCP 工具、宿主文件上传／下载或跨设备浏览器调度；有限被动录制与文件产物工作流属于独立的[隔离 Browser/recipe](browser-workflows.md)，不能把这些边界混为一谈。
