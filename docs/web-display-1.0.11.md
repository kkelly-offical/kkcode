# 1.0.11 Web 显示补丁

用户确认采用独立网关／Web显示补丁，安卓不升版。目标标识为 **1.0.11-display.1**；CLI/npm稳定版仍为1.0.11，Android10018和所有既有发行产物保持。

当前状态：独立Web显示补丁 **1.0.11-display.1 已正式发布**，提交`dd1e4a2`（PR#52）与候选`5d51fdc`同树。npm／CLI仍为1.0.11，Android10018不变。现网尚未部署，正在等待用户提供实际部署机器／目录。

| 项目 | 状态 |
| --- | --- |
| 移除重复设备横条，保留侧栏和移动端切换入口 | 已实现并通过浏览器检查 |
| 紧凑标题栏、输入区和伙伴栏，扩大正文面积 | 已实现并通过短窗口检查；1366×768正文383→519px，1024×600正文225→384px |
| 字号与阅读宽度在当前浏览器保存 | 已实现并通过浏览器检查 |
| 原生滚轮、键盘翻页、流式输出及重排位置保持 | 已修复并通过：键盘翻页即时定位、回到最新无回弹、重排保留阅读段落 |
| 窄屏、短窗口、代码块与表格的独立滚动 | 已通过；流式重绘保留代码块纵向及表格横向位置 |
| 独立静态补丁、校验、备份与回退、公开下载 | 已完成：真实归档覆盖安装、安装后Web检查、重复安装、哈希回退、Node22.12及跨平台CI通过；匿名下载一致 |
| 现网应用 | 待用户提供实际部署机器／目录，尚未修改现网或实验网关 |

补丁只包含网页静态资源，运行时、Android和签名证书不改变；安装目标必须是1.0.11网关／本机Web。发布补丁不等于已更新所有生产网关。检查使用隔离模拟网关与长对话，不新增真实模型调用。

安装方式见[安装与回退](web-display-install.md)。补丁已以独立 `web-1.0.11-display.1` 标签和Release发布，不占用npm latest，也不改变Android更新渠道。

检查：完整Web套件、最终滚动／显示专项及既有会话专项通过；Node文档、版本、Markdown安全和安装器共13项通过。更新版本显示后，旧版本标签检查只允许单一import的断言已按实际共享导入修正。没有降低检查阈值。

本机检查回执：`/tmp/kkcode-web-111-display1-ab0n_dgh/`；前后布局测量和隔离样例截图随记录保留。

## 公开交付

- [独立补丁Release](https://github.com/kkelly-offical/kkcode/releases/tag/web-1.0.11-display.1) · [下载归档](https://github.com/kkelly-offical/kkcode/releases/download/web-1.0.11-display.1/kkcode-web-1.0.11-display.1.tar.gz) · [公开核验回执](https://github.com/kkelly-offical/kkcode/releases/download/web-1.0.11-display.1/web-display-verification.json)。
- 归档SHA-256：`e0c856678fc36c652289a9086905da874b409abb7c384a5fe1dcaccab5f1747c`。最终归档与候选的资源、安装器和说明文件内容一致，仅manifest的源码提交信息因合入更新；真实Node22.12安装／回退通过。
- 当前提交的Linux Node22/24、macOS、Windows、Web与CodeQL全部通过；npm latest与GitHub默认正式版仍为1.0.11，Preview不变，原tag与APK不改写。
- 安装器先校验和备份，再写入新哈希资源并原子切换入口，保留旧资源供已有标签页使用。现网部署位置尚待用户补充，本机另一个实验网关保持原样。
