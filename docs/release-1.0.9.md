# 1.0.9 · 通用 Agent 与会话体验修复

[版本状态](versions.md) · [逐项实施与验证](implementation-1.0.9.md)

状态：**1.0.9 / Android10016稳定正式版已发布并核验**。npm latest、[稳定Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.9)与原证书APK均已上线；[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.9/release-verification.json)。旧Preview与所有旧tag保持。

- 普通会话默认关闭强制测试验收，日常问答、文档及运维可正常结束；明确代码工作仍遵循项目检查。失败回执保留，回答结束与验收通过分开记录，宿主严格合同及权限、预算、未知效果约束保持。
- 上下文标尺统一为最近请求的实际输入数，区分估算和严格上界；新请求独立检查完整预算。
- Web／Android进入会话定位最新内容，长回复跟随真正底部，向上阅读时自由滚动，并提供“回到最新”。Compact前可见记录默认折叠，可展开查看。
- 手动Compact显示提交／压缩／停止状态，接入真实取消和重复请求保护。接受后清空原指令，失败或取消可重试，不覆盖新草稿；完成即更新标尺并显示`≈ 100k → 11k`，重开会话仍能看到结果。
- Android Markdown支持GFM表格、对齐、行内格式和安全链接；宽表可横向阅读，单元格文字可选择。
- 模型选择器每次打开自动刷新，失败保留已有目录；异步响应按设备和渠道隔离。CLI的`/model`也会重新发现目录。
- Android连接提示随断开、重连、恢复变化；恢复后自动收起，普通提示限时展示，真实任务错误仍留在会话记录。

Android为正式发行，沿用项目原证书及direct-SSH，版本码递增到10016。CLI、Web网关和App分别升级；本轮包括用户已授权的本机`/root`、all-folders tmux remote更新，不自动部署公共网关镜像或其他生产环境。

验证使用本地受控provider与HTTP、浏览器、模拟器；不新增真实模型调用，不重启历史冻结评测，不改写旧失败与unknown。
