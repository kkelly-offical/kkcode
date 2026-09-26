# 1.1.6 安全告警复核

2026-09-27；仅维护源码，不发布版本、部署服务或更改扫描／分支保护规则。

## 范围与基线

PR #26 已按用户当次管理员授权合入 main `c711f834`。该授权不是后续 PR 的常设
免审权限。本次从该提交重新核对 GitHub 告警和 SARIF 完整数据流，不把上一轮
“可能误报”的分类直接当作关闭依据。

- main 开放 CodeQL：6 条（#19、#37、#43、#54、#55、#56）。
- 对应 JavaScript 分析：`1844734253`；Kotlin `1844739258`、Actions
  `1844729444` 均无结果。扫描完成／工作流成功不等于零告警。
- 同次查询 Dependabot、secret scanning 开放列表均为空。
- 另复核当前 SARIF 中仍出现的历史关闭项 #7、#14、#16，不改扫描规则来消除结果。

阶段处置：#37/#43/#54/#55 已在 GitHub 逐条以 `false positive` 关闭并留证。
#19/#56 保持开放，等待 PR #27 修复合入；扫描器在新位置另报的 #73 是同一自定义
引用语法的反斜杠规则，须按修复后的完整语法及回归另行核查，不能无证据批量关闭。

## 逐项结论与关闭条件

| 告警 | 实际边界与结论 | 处理依据 |
| --- | --- | --- |
| [#19](https://github.com/kkelly-offical/kkcode/security/code-scanning/19) 文件引用转义 | 原规则将自定义文件引用语法当成通用反斜杠转义；但深入复核确实发现相邻的引用注入问题，不能直接按旧报告关闭。 | 先修复下面的文件／图片引用问题，完成回归、合入及扫描后，才可对剩余同一规则结果按自定义语法误报逐项说明。 |
| [#37](https://github.com/kkelly-offical/kkcode/security/code-scanning/37) 大小写别名 `stat` | 告警位置用于确认授权根的设备／inode 身份，不读取文件正文。候选祖先须先与授权根逐段大小写匹配；只有身份相等才准入，大小写敏感的同名兄弟目录不准入。 | 越界、未授权 UNC、大小写兄弟目录、授权别名及私密目录别名负控；#37 不等于允许任意远端路径读取。 |
| [#56](https://github.com/kkelly-offical/kkcode/security/code-scanning/56) 路径规范化 | `realpath` 前有词法授权检查，之后有规范路径授权、私密目录和身份检查；文件预览还校验同一文件句柄、inode、单一硬链接及大小限制。 | 保留已有软／硬链接负控；新增 Windows ADS、设备名及私密路径尾部点／空格处理。必须区分 Linux 上纯字符串测试与 Windows 真实 NTFS 验证。 |
| [#43](https://github.com/kkelly-offical/kkcode/security/code-scanning/43) 模型目录 SSRF | SARIF 的不可信源为模型服务返回的分页 URL。初始地址来自用户配置或已信任工作区；缓存前重查信任、出域策略及凭据传输；分页和跳转均锁定原始 origin。 | 真实双 HTTP 服务确认跨源分页／跳转陷阱零访问，另有信任撤销、HTTP 凭据禁止和出域 deny-all 回归。用户明确配置的本机／企业内网服务是支持场景，不应一刀切禁用。 |
| [#54](https://github.com/kkelly-offical/kkcode/security/code-scanning/54) 网关 HTTP SSRF | 初始网关由本地用户选择；公开 canonical-origin 发现不含 bearer、cookie 或刷新凭据。登录后的凭据请求固定网关，强制拒绝所有 HTTP 跳转；令牌扩展字段不能覆盖网关。 | 301/302/303/307/308 双端点负控、登录及刷新元数据污染测试。企业网关是明确受信任的一方，不是向未认证网页开放的任意 URL 代理。 |
| [#55](https://github.com/kkelly-offical/kkcode/security/code-scanning/55) Relay WebSocket SSRF | 使用登录后绑定的网关 origin，HTTPS 转 WSS；禁止跟随升级重定向，刷新令牌不能改写目标。设备所有权／组织变更另有显式转移约束。 | 真实 WebSocket 升级跳转陷阱不得接收 bearer；错误协议、URL 内嵌凭据和跨账号／跨网关绑定拒绝回归。 |

以上是审计结论与条件，不是宣称所有 GitHub 告警已经关闭。确认为误报的项目才允许
通过 GitHub 单条 dismissal 留下证据；真实修复尚未合入时不得提前宣称 main 已修复。
不使用“风险已接受”来掩盖待修复问题。

## 本轮复现和修复

### 文件引用不能扩大用户选择

旧实现存在可复现的边界错误：

1. 工作区文件名同时含引号、制表符／换行和 `@另一个文件` 时，自动补全会插入
   多个文件引用。以引号起始的文件名也可能被截断为另一条路径。
2. 解析后的文件名再次经过终端拖拽解码，会丢掉字面反斜杠、引号或首尾空格，
   实际读取目标与用户选择不一致。
3. 文件正文追加到提示词后，图片识别再次扫描整段文本，会把正文里的本地图片
   路径或远端图片 URL 自动当成附件；文件名里的图片子串也可能触发额外附件。

修复保留既有普通文件引用语法，不改成 shell 转义：自动补全必须通过单 token、
完整长度、原路径相等的往返检查；不能安全表示的文件名保留原输入并显示中文提示。
控制字符／双向控制字符文件名不进入候选菜单。已经解析的路径只展开 home 前缀，
不再二次反转义。图片仅从原始用户输入识别；被引用正文保持惰性，完整文件 token
不允许被递归识别为别的附件。原始用户直接输入的合法图片和 URL 继续可用。
自动补全还拒绝会被解释成 home 或 URL 的特殊前缀；需要引用此类字面文件名时可
手动使用明确的 `./` 相对路径。4,680 个组合穷举还覆盖真实补全分隔符，防止尾部
反斜杠吞掉用户后续输入。

`test/security-alert-boundaries.test.mjs` 最初5项中4项在旧代码失败；不是仅补注释。
修复后的专项还覆盖空格、中文、Windows 路径、字面反斜杠、正常图片与原有输入行为。
本轮测试使用受控内容，不读取真实用户私密文件、不请求真实模型。

### Windows 特殊路径加固

NTFS 的 `:stream`／`::$DATA` 并非普通文件名；Win32 还存在尾部点／空格与保留
设备名。现在私密路径检查在文件系统访问之前拒绝 alternate streams 和设备名，
并按 Windows 的别名规则核查私密组件。POSIX 合法冒号文件名不受 Windows 规则影响。

`test/device-private-path.test.mjs` 包含跨平台纯规则测试，以及**仅 Windows 运行**
的真实 NTFS 用例：先用 Node 文件系统确认测试流实际存在并可读，再确认远控预览
拒绝，普通文件仍可读。Linux 跳过该用例不得当作 Windows 验收通过。
平台语义依据 Microsoft 的[文件命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
及[文件流说明](https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams)。

## 历史关闭项复核

- #7：`setByPath` 在遍历前拒绝任意层级的 `__proto__`／`constructor`／`prototype`；
  不是把所有动态属性写入都当成安全。
- #14：注释标记替换不是 HTML 消毒器。实际 Markdown 输出另经
  `escapeGitHubMarkdown`／代码片段约束；Web Markdown 显示另有 DOMPurify。
  历史理由里的“全仓无 HTML 渲染”已不适合描述当前产品，应以当前输出路径为准。
- #16：URL `includes` 仅为 Markdown 渲染测试断言，不承担主机授权判断。
- 旧路径缓存散列及诊断日志项 #6/#12/#13/#15 未出现在本次 SARIF；旧记录保留。

## 验证与可追溯性

执行路径：专项旧红新绿 → lint／类型 → 完整 Node／E2E／协议兼容 → 精确提交的
Linux／Windows／macOS CI 与 CodeQL。结果、提交 SHA 与 GitHub 单条处置理由保持
一致；未通过或未运行的环境须明确保留，不以“测试绿”代替漏洞论证。

规则原意见官方说明：[路径注入](https://codeql.github.com/codeql-query-help/javascript/js-path-injection/)、
[SSRF](https://codeql.github.com/codeql-query-help/javascript/js-request-forgery/)、
[不完整转义](https://codeql.github.com/codeql-query-help/javascript/js-incomplete-sanitization/)。
本报告的结论来自本仓库数据流及回归，不是对上述规则的整体否定，也不承诺产品没有
其他未发现漏洞。
