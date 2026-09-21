# 1.0.1 移动端交互说明（开发中）

本轮根据用户提供的两组参考图调整 WebUI 和原生 Android。目标是把会话放在前面，把配置放在后面；不是复刻其他产品的账户、订阅或尚未实现的功能。

## 首屏与设置

- 启动进入设备/会话首页。没有登录、没有配对、没有配置模型，也不自动弹出表单。
- 顶部只显示当前设备和连接状态；底部是搜索与新建聊天。
- 会话支持按优先级、项目、时间查看。只有正在运行的会话进入优先级组；分组可展开、收起。
- 新对话先选择设备、工作目录和执行模式，再进入输入框。
- 菜单中的设置打开分组列表。模型列表、添加渠道表单、网关登录和 SSH 表单分层进入。
- 桌面 WebUI 保留左下角个人/设置入口；移动端使用圆角底部弹层。
- Web 弹层支持 Esc、返回、点遮罩关闭、焦点限制和关闭后的焦点恢复。设置界面不强制占满屏幕；内容较多时内部滚动。
- Android 的开关使用统一的绿色连接状态；自动恢复连接不会自动打开设置。

## 对话页

- 顶部显示会话标题、项目和设备；新会话根据第一条消息生成短标题。
- 正文解析 Markdown。Web 使用 DOMPurify 清理 HTML；原生端使用 Markwon。
- 同一个工具 invocation 的开始和结束合并为一条浅灰活动记录，点击展开输出和参数。
- 编辑记录展示实际 `mutations` 元数据中的增减行数，展开后逐行显示红删绿增。没有证据时不编造统计。
- 思考增量合并为折叠段，运行时显示动效和经过秒数；正文开始后结束计时。
- 上下文压缩显示为细分隔条。普通提示使用短暂通知，不把配置提示塞进正文。
- “/”建议浮在输入框上方。命令名、别名前缀优先于描述文字中的偶然匹配；Web 支持上下键、Tab 补全、Esc 收起、Shift+Enter 换行。
- “+”只放已实现的模式、目录、模型、扩展入口。暂不显示未接通的相机、语音、上传或分支切换按钮。
- 展开长代码差异时，滚动发生在对话区域，输入框保持可见。
- 模型与模式切换写入电脑上的会话状态，并同步到其他客户端；浏览模型目录本身不会偷偷切换当前模型。
- 提问按实际问题 ID、选项值提交，支持单选、多选与自定义回答；另一端处理审批后本端同步收起。
- 只读共享会话禁用发送和审批，不显示所有者的配置入口；接管控制只对所有者展示。

## 验证方法

```sh
npm ci
npm run typecheck:web
node --test test/web-presentation.test.mjs
npx playwright install chromium
npm run test:web
```

已有浏览器可通过 `KKCODE_CHROMIUM` 指向 Chromium 可执行文件。
`scripts/web-smoke.mjs` 使用临时工作区和测试 provider，经过实际 DeviceService/kernel 请求链路发送一轮消息，不消耗付费模型额度。
差异和思考的渲染用例另外注入明确的 UI 测试事件，不代表真实模型修改过演示文件。
截图输出到被 Git 忽略的 `test-results/`：首页、菜单、设置、对话、展开差异、命令建议。

Android 需要 JDK 17+、Android SDK 和 Gradle 8.14.3：

```sh
cd android
gradle :app:assembleDebug :app:assembleDebugAndroidTest
cd ..
KKCODE_ANDROID_SERIAL=emulator-5580 node scripts/android-ui-smoke.mjs
```

脚本要求明确指定测试设备，不会自动选取手机或清除设备数据。测试 APK 与 debug APK 安装到该设备。
如 Gradle 的 `connectedDebugAndroidTest` 被 UTP 附加组件下载阻塞，可在 APK 构建成功后使用上述原生 AndroidJUnitRunner 路径运行同一套测试。

## 尚未作为完成项交付

这些 UI 验证不等于整个 1.0.1 已满足发布条件。当前本机实验环境已通过真实 Keycloak/PostgreSQL/HTTPS 中继、Android 原生登录状态流程和 SSH、多端模型与对话同步、跨端审批、网关重启恢复；详见 `enterprise-lab-progress.md`。手机上的外部浏览器登录页面、更多真机/浏览器、子代理审批聚合、分支安全切换与附件上传仍需补验收。相机、语音录入、应用商店签名和发布没有在本轮完成。
