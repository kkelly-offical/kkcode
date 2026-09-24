# 实验性 Browser Recipe：录制到受控工具

Recipe 是固定的语义动作数据，不是自动安装的插件或生成的 JavaScript。默认关闭录制，用户明确开始后，才在专用隔离 Browser 的当前页面采集有限动作；不连接个人 Chrome Profile，不后台抓取全量网络。

默认库按当前设备账号（含组织/网关）和规范工作目录分开。模型只能看到当前范围中已启用的 Recipe，不能查看未审核候选的站点或内容。账号重新绑定、组织/网关变化、工作目录变化会阻断旧授权；原有全局宿主库不会自动迁移或提升到新账号。

## 必经流程

`用户同意录制 → 脱敏候选与内容哈希 → 用户审核该哈希 → 独立离线 Browser fixture → 用户启用同一哈希 → 逐叶治理执行`

候选只有 `snapshot`、同 origin 的参数化 `open`、`click`、`fill`、有限 `press` 动作。定位只允许 role + 可访问名称，不接受 JavaScript、CSS 执行代码、任意 CDP、文件路径、请求头或 Cookie。普通词（如 `Name` / `Save`）可以作为定位名称保留；其余名称（项目名、账号、邮箱、文档标题等）改为运行时 `target_N` 参数。输入始终变成 `input_N` 参数；导航路径变成 `path_N` 参数，查询串、fragment 和跨站地址不能直接写进导航步骤。

用户可拒绝任何录制/审核/启用请求。没有宿主真实确认通道时，不能用 JSON 的 `confirmed: true` 代替批准，也没有 `--yes` 开关。审核与验证按 revision 做并发检查，不能覆盖等待期间的停用/账号转移。

## CLI 完整使用

以下命令在目标电脑和相同项目目录运行。录制需要可见桌面、交互终端和已安装的固定 Chromium；生产路径强制使用 bundled Chromium 和 OS sandbox，不提供命令行关闭沙箱的捷径。

```sh
kkcode browser install
kkcode browser recipe record https://example.com/app --minutes 10
kkcode browser recipe list
kkcode browser recipe show recipe_<id>
kkcode browser recipe review recipe_<id> --hash <完整SHA256>
kkcode browser recipe validate recipe_<id> --hash <完整SHA256> --fixture ./recipe-fixture.json
kkcode browser recipe enable recipe_<id> --hash <完整SHA256>
kkcode browser recipe run recipe_<id> --hash <完整SHA256> --url https://example.com/app --parameters ./recipe-parameters.json
kkcode browser recipe disable recipe_<id>
```

录制会先展示站点、指纹和时限；明确输入 `record` 后，才开始监听。在专用浏览器中操作，终端按 Enter 收束候选。审核和启用分别要求输入完整哈希。录制最长 30 分钟，最多 64 个已接收语义事件；超时关闭监听，已接收事件按顺序处理后收束，不保持后台采集。显式取消不自动发布候选。

`run` 默认打开全新可见 Browser。需要登录时由用户在该窗口手动完成，回到目标页面后确认继续；登录输入不会交给模型，也不会自动继承其他 Profile。无登录需求时可显式选择 `--headless`。身份、站点或界面指纹发生变化会停用 Recipe，不自动换 URL/选择别的设备/重新授权。

独立 fixture 文件示例（这是人工维护的测试，而不是把录制过程复制一遍就声称验收成功）：

```json
{
  "html": "<label>Name<input aria-label='Name'></label><button onclick=\"document.querySelector('output').textContent='Saved '+document.querySelector('input').value\">Save</button><output></output>",
  "parameters": { "input_1": "fixture-value" },
  "assertions": ["Saved fixture-value"]
}
```

fixture 用独立临时 Profile 和拒绝代理运行：仅在内存提供同 origin 的固定 HTML，外站请求和服务端写请求全部拒绝，不访问真实账号/生产服务。要求所有候选动作完成且所有最终 snapshot 断言成立；回执绑定 Recipe 哈希、fixture 哈希和动作数量。验证总时限 60 秒，失败/取消不会启用。CLI fixture JSON 不能指定浏览器二进制或关闭沙箱。

参数文件只需提供候选列出的键，例如 `{"input_1":"工作内容"}`。Recipe 目录不会另存运行参数；但经模型明确调用的 fill/参数，仍可能按普通会话、工具调用和审计记录规则记录。不要因此把密码、令牌或其他秘密传给模型。

## 模型工具与权限

模型入口只有 `browser_recipe` 的 `list` / `run`，没有录制、审核、验证、启用选项。模型先通过普通 `browser` 工具打开用户允许的站点，再选择列表中的固定 id/hash，提供声明的参数。

每一个 Browser 叶动作都重新进入内核 `executeOneCall`：执行期再次检查 Agent/Skill 白名单、权限和敏感操作审批、数据出域策略、持久操作回执和严格执行后端。外层 Recipe 不会绕过这些检查。计划/只读范围只能列出 Recipe，不能直接执行。普通工具参数无法伪造宿主的 WeakSet 品牌叶调用接口。

权限等待结束、实际派发前还要检查 Recipe 是否仍启用、版本是否一致、账号范围和当前页面指纹是否仍匹配。停用或转移后不会继续下一步。已完成的副作用不假装回滚，失败/取消也不会自动重放；“动作已完成”不等于业务目标已经完成，仍应检查实际页面与任务验收标准。

## SDK 宿主入口

`src/sdk/browser-recipes.mjs` 提供：

- `createBrowserRecipeAuthority({confirm})`：宿主用户交互回调产生的品牌 authority。
- `createScopedBrowserRecipeStore(...)`：默认推荐，按真实设备身份和项目分库，并重查身份。
- `createBrowserRecipeHost(...)`：组合专用 Browser、有效数据策略和 scoped store。
- `createBrowserRecipeFixtureRunner(...)`：构造真实独立离线 Browser 验证器。
- `createBrowserRecipeStore({rootDir,...})`：低层 trusted-host API；显式全局库不自动暴露给远程或模型。

`executor.observe` 必须来自受控浏览器，不能回显模型传入的“指纹”。`executor.execute(step, options)` 必须在实际派发前调用 `options.authorize()` 并按 origin/fingerprint 验证当前页面；模型集成应使用内核提供的品牌逐叶桥，不直接递归调用 Controller。自定义 fixture runner 是宿主信任边界，不能让模型传一个“通过”的回执冒充隔离验证。

状态文件使用私密目录、原子写入和跨进程锁；符号链接、硬链接、宽松权限、损坏记录或哈希不匹配时停止，保留证据，不静默删库或自动重新批准。

## 实际录制边界与验收

当前被动 DOM listener 只覆盖主 frame 的按钮/链接 click，以及普通 input/textarea 的 change；不读取输入值。不录密码、hidden/file、iframe、select/checkbox、完整键盘输入序列，不向 BrowserBridge 的个人页面注入录制器。SDK 显式语义 feed 能表达更多受限动作，不表示 DOM 自动录制覆盖所有操作。

单站、有限动作是有意的首轮范围。动态菜单/界面结构变化、跨站 API、复杂多页面流程可能触发保守失效；应拆分 Recipe、补独立 fixture，或继续用逐步 Browser 工具。没有承诺通用宏录制、生产流程自动验收或跨站权限自动继承。

独立委托和任务图 worktree 不会自动继承源目录批准：必须在具体规范工作目录授权。严格任务还要求合同明确允许 `browser_recipe`、实际 Browser 叶工具及目标 `allowedNetworkOrigins`，并受 data_policy 收窄。BrowserBridge 不属于 strict 路径。跨 worktree 的逻辑项目共享将来需要显式宿主映射/allowlist，不能由模型传入源路径获得。

本机验收包括：真实被动 DOM 录制→人工接口确认→独立离线 Browser→固定哈希启用；真实模型调用 Recipe 再进入 Browser 叶工具；Skill 白名单收紧后叶动作拒绝；账号/项目隔离和等待期间转移；事件顺序、容量、停止、损坏/链接状态；取消/失败不重放。测试均使用项目专用 fixture，没有登录生产服务。

```sh
KKCODE_REQUIRE_BROWSER=1 node --test test/browser-recipes.test.mjs test/browser-recipe-live.test.mjs test/browser-recipe-loop.test.mjs
```

Linux root 容器中的测试可由 trusted SDK fixture 明确关闭 Chromium sandbox，以验证离线测试管线；这不等于严格模式已在该环境通过 OS sandbox 验收。正式桌面/严格运行仍保持默认 fail-closed，不能用测试配置宣称已覆盖所有系统。
