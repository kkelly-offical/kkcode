# 1.0.12 · 用户体验与 Windows 客户端

[版本状态](versions.md) · [实施与检查](implementation-1.0.12.md) · [设计归档](https://github.com/kkelly-offical/kkcode/tree/main/docs/design/1.0.12)

已发布 **1.0.12 正式版 / Android10019**（npm latest），发行提交 `00e573c`（PR#54），与候选 `caf7073` 同树；Android 沿用原证书。

[Windows 安装器](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.12/kkcode-windows-1.0.12-x64-setup.exe) · [Android APK](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.12/kkcode-android-1.0.12.apk) · [设计导出包](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.12/kkcode-design-1.0.12.zip) · [校验回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.12/release-verification.json)

- Web 沿用确认稿的三栏结构，保留任务卡、执行横幅与活动面板。统一深绿与琥珀配色，减轻按钮边框，收拢重复设备、伙伴与操作入口；浅色主题、字号及阅读宽度继续可选。
- 项目按当前设备的完整工作路径区分，同名文件夹不会混在一起。会话内搜索已加载记录，定位后暂停跟随，可返回刚才的位置或回到最新；压缩前记录仍可展开和定位。
- Android 整理客户端外观、工作设备、模型与账户入口，新增项目选择、历史定位和活动分类。底部伙伴与上下文合并为一行，保留状态来源说明、思考选择、Markdown 表格、压缩状态与取消操作。
- 首次提供 Windows x64 图形应用。本机工作区使用随包 Node 与搜索工具，原生选择项目目录；也可连接 HTTPS 企业网关，界面使用随包版本。支持托盘、窗口缩放、快捷键、显示偏好保存和任务退出确认。
- Agent 继续复用既有权限、子代理自动汇报与上下文管理。本轮不增加固定编排或普通任务的强制测试门禁；取消不撤销已完成的副作用。

Windows 使用说明见[客户端指南](windows-client.md)。macOS / iOS 应用暂缓。Windows 应用、CLI / remote、网关和 Android 分别安装与升级，不自动部署其他网关。检查使用隔离数据和模拟器，没有新增真实模型调用。
