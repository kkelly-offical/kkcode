# Browser 工作流边界（1.0.5 Preview 开发中）

隔离 Browser 与已登录 Browser Bridge 是两个独立入口，不能混用安全承诺。

## 隔离 Browser

每个会话使用独立临时 Profile，默认 Chromium 沙箱开启，关闭后销毁 Cookie 和页面。最多四个会话、每个八个标签页。`tabs/new_tab/select_tab/close_tab` 只管理该隔离上下文；网页弹窗作为新标签页保留。`frames` 返回当前页 iframe ID，`frame_id` 将后续操作定位到该 frame，不接受宿主路径或外部页面对象。

`snapshot` 返回 `snapshot_id`、tab/frame ID 和可唯一识别控件的 `ref`。再次生成 snapshot、导航或节点被替换会使旧引用失效；不猜测元素、不自动重放点击。歧义控件仍可通过现有精确 role/name 或窄 selector 操作。网页内容、标题和诊断都属于不可信数据。

原生 alert/confirm/prompt 默认取消并在 `dialogs` 中留简短记录。确实需要接受时，在触发动作上附带一次性的 `dialog_response: {accept: true}`；不能事后将未知弹窗全部同意。

`upload` 仅接受当前任务已授权 `artifact_id`，逐页验证存储哈希、租约和 16 MiB 上限，再把内存缓冲写入文件控件。填入控件不等于已提交服务器。不同账号/项目/会话/任务产物不能串用，不能传 `/etc/passwd` 等路径。

`download` 接受 HTTP(S) `url` 或真实链接的 href。它不点击按钮、不执行 onclick、不启动 Chromium 原生下载器，而是通过受控网络层执行一次有界 GET（每个重定向各一次，最多五跳），逐跳做 DNS 固定与出域校验，流式限制压缩前/后字节。只对当前页同 origin 发送该隔离上下文 Cookie，跳往其他 origin 不转发凭据。成功后返回 ArtifactStore 完整产物引用，由现有 Web/Android 产物入口下载；不返回宿主文件路径、不执行文件。blob/data 下载及依赖脚本/POST 的下载暂不支持，明确报错，不偷偷重试或回退到不受限下载器。

页面请求走统一受控网络，service workers 禁用，默认 WebSocket 禁用；显式 development 模式仅允许已批准的同源开发 WebSocket。严格受托任务仍要求工作合同中的网络 origin 授权与有效 data_policy 同时允许；不能关闭 Chromium 沙箱或用自定义二进制。缺少系统沙箱支持时失败关闭，不把 `--no-sandbox` 模拟测试称为严格执行验收。

普通对话也会保留配置来源：未信任的项目不能选择浏览器可执行文件或关闭 Chromium 沙箱，这两项只取用户级配置；信任/启动设置改变时关闭旧进程，重新打开才会应用新设置。直接 SDK `createBrowserController` 是可信宿主接口，宿主必须传入真实 `configState` 或自行审核配置，不得把原始 RPC/模型 JSON 当作可信配置。

## 已登录 Browser Bridge

详见 [本机桥接](browser-bridge.md)。固定 Playwright MCP 与官方扩展首次仍需本机人选择/批准标签页组。`tabs` 仅投影组内同时符合授权 origin 的标签页，`select_tab` 必须携带未过期的 `tab_list_id`，切换后再次验证真实页面 origin。标题格式歧义或列表变化时拒绝。不会新增、关闭个人标签页，也不支持导出 Cookie、任意 JS/CDP、宿主上传下载。

扩展对已有浏览器具有强权限，标签组与 origin 检查不是 OS 隔离或网络防火墙。严格网页出域策略存在时此桥接拒绝运行，应使用隔离 Browser。

Bridge 语义快照/引用仅支持主 frame，嵌入子树省略，不派发无法绑定主 frame 的全局按键。图片默认关闭，必须另行 host `allowScreenshots`／CLI `--allow-screenshots` 确认；这只授权已选页面的渲染图像（可能含嵌入内容），不声称后置快照证明了像素级 origin。只有显式截图动作返回 image，其他动作不能夹带图片。隔离 Browser 的完整 frame/按键和受控截图不受影响。

## 被动语义录制

宿主可为独立可见 Browser 构造 `createBrowserController({headless:false})`，通过 host-only `attachRecorder` 连接经人工授权的 recipe recorder。只监听当前主 frame 的 click/change，不读取输入框值、密码、Cookie、请求标头/正文，也不全时抓包；切到其他 origin 不录制。录制结果只是待审候选，不能自己获得执行权限。详情见 [recipe 流程](browser-recipes.md)。当前不会向用户已登录 Bridge 注入录制脚本。

已启用的固定哈希 recipe 可通过 `browser_recipe` 的 `list/run` 使用，默认按设备账号/组织/网关和规范工作目录分库，不自动暴露宿主全局库。运行时每个有限 Browser 动作重新进入正常权限、Skill/Agent 限制及持久执行边界；确认等待结束后再次检查 recipe 未撤销及页面指纹。指纹包括控件结构和链接/form 的目标、方法，但不读取输入值；它不是整个站点后端实现的密码学证明。

Recipe 执行会为当前 Browser 会话收窄到固定单一 origin，交叉站点 API、表单及重定向都不能由 recipe 自动获得授权。这个限制在后续普通 snapshot 后仍保留；只有另一次正常权限流程下、URL/DNS 校验成功的显式 `open` 或关闭会话才释放。更复杂的跨站/多阶段界面请拆分流程并重新授权，不依赖一次录制获得无限权限。

## 验证范围

`test/browser-workflows.test.mjs` 使用真实独立 Chromium Profile 和本机假站点，覆盖 popup、iframe、旧 ref、dialog、跨 scope 上传拒绝、gzip 直链下载与单次请求。`scripts/browser-bridge-smoke.mjs` 使用固定官方扩展、新 Profile、假登录 Cookie 与真实批准弹窗，验证隔离已选标签组和撤销；不访问用户既有 Profile。这些是 Linux 专用 fixture 验收，不代表 Windows/macOS 真 Chrome/Edge 全平台认证。

实现参考 Playwright 官方 [多页面](https://playwright.dev/docs/pages)、[iframe](https://playwright.dev/docs/frames)、[对话框](https://playwright.dev/docs/dialogs) 和 [下载](https://playwright.dev/docs/downloads) 文档。产品额外限制原生下载，避免仅事后检查文件大小。
