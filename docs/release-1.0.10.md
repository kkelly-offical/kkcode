# 1.0.10 · 模型参数与通用编排优化

[版本状态](versions.md) · [逐项实施与验证](implementation-1.0.10.md)

状态：**稳定正式版已发布并核验**。npm latest=1.0.10，Android10017沿用原证书；[稳定Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.10)与[公开回执](https://github.com/kkelly-offical/kkcode/releases/download/v1.0.10/release-verification.json)。

KK Code **1.0.10 稳定正式版**，Android **10017**，沿用原签名证书。

- 自动解析模型目录中的上下文、输入与输出限额，统一输出预留、思考预算和上下文计量；缺失资料时采用明确标注的规格或窗口 1/5 兜底。
- CLI、Web、Android 共用动态思考选项：略思／审思／深思／精思／穷理，分别对应可用的 low／medium／high／xhigh／max；按接口能力裁剪，只有二态时使用开关，不强凑档数。
- 子代理按自身模型计算额度，支持精简上下文与证据引用交接。
- 普通 Ultra 按任务需要安排阶段、委派与检查，减少固定工程流程；持久 ToDo、取消、权限、硬预算和显式严格合同保留。
- 修复并发日志快照与产物锁释放的竞争问题，保留原权限、链接与超时限制。

安装或升级 CLI：

```sh
npm install -g @kkelly-offical/kkcode@1.0.10
```

Android 安装附件 `kkcode-android-1.0.10.apk`，或在 App 内检查稳定更新。Web／网关需独立升级部署。Preview 保持 1.0.6-preview.1，既有版本与标签不移动。

候选跨平台、Web、CodeQL 检查通过；Android 85 项 JVM、81 项 UI／设备检查及原证书 10016→10017 覆盖升级通过。未新增真实模型推理评测，不代表延期成熟度门禁已完成。本次不部署公共网关镜像或升级生产服务。

公开下载、发行流水线、签名及哈希的最终核验见本 Release 附件 `release-verification.json` 和 `SHA256SUMS`。
