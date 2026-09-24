# 严格依赖环境待办

基线：`1.0.5-preview.0`；均未在本次待办提交中实现，见[总索引](README.md)。
证据：[离线依赖边界](../../dependency-environments.md)、[严格任务](../../trusted-runs.md)。

## ENV-01 · P1 · npm workspaces / monorepo

- 类型／状态：已知能力缺口／待设计和实现。
- 现状：严格离线依赖准备支持普通 npm v2/v3 锁文件，不支持 workspaces。
  KK Code 本仓库自身有 workspaces，因此当前不能声称严格路径已支持它的完整安装。
  这不是“普通 CLI 不能编辑 monorepo”。
- 范围：先支持一个明确的 npm workspace 子集，定义根／子包、锁文件、内部依赖、
  安装顺序和安全链接的处理；不通过直接复制宿主 node_modules 绕过验证。
- 验收标准：
  - [ ] 多包公开 fixture 真正完成离线安装、跨包构建、测试与 LSP 类型解析。
  - [ ] 主任务和独立验收消费同一已签名依赖快照；源仓库和原锁文件不被修改。
  - [ ] 工作区外链接、锁与清单不一致、隐式安装脚本、未授权来源明确拒绝。
  - [ ] 安装脚本授权保持独立；断网失败不能自动改为联网或读取宿主凭据。
  - [ ] 自身仓库验收单列结果；支持子集和不支持配置写进 CLI/SDK 文档。
- 入口：`src/kernel/dependencies/npm-environment.mjs`、`test/npm-environment.test.mjs`、
  `test/npm-environment-security-review.test.mjs`。
- 建议后续实现提交：`feat(environments): support governed npm workspaces`。

## ENV-02 · P2 · 其他包管理器、私有依赖与原生构建

- 类型／状态：兼容范围扩展／分项排期；不承诺一次支持所有生态。
- 现状：pnpm/Yarn/Bun、私有 registry 凭据、Git/目录依赖及隐式 node-gyp 等未支持。
- 范围：逐项建立支持矩阵。先确认实际需要的管理器和锁文件版本，再各开实现提交；
  私有来源需另行明确凭据来源和网络授权，不能复用聊天中的旧密钥。
- 验收标准：
  - [ ] 每个适配器具有真实离线安装／构建、完整性和拒绝路径测试，不只解析锁文件。
  - [ ] 凭据仅由受信宿主用于批准来源，不进入模型、安装脚本、日志或签名环境内容。
  - [ ] 原生构建使用明确工具链／镜像／脚本批准，不静默启用 node-gyp 或外网下载。
  - [ ] 不支持的格式显示可理解的原因和替代路径，不用“兼容所有”覆盖未测项。
- 建议后续实现提交：`feat(environments): add one explicitly scoped package manager adapter`。
- 依赖：具体生态优先级、私有验收资源及相关授权，不以伪造私有成功结果关闭。

## ENV-03 · P2 · 依赖环境增量准备与容量维护

- 类型／状态：生命周期能力缺口／待实现。
- 现状：已签名环境不可变；清单变化后的增量重准备和自动 GC 尚无完整策略。
- 范围：增加可审计的复用／重准备、引用与占用查看、预览清理，再讨论可选自动 GC。
- 验收标准：
  - [ ] 改变锁、镜像、脚本或来源必须失效旧批准，不能修改旧签名环境冒充新环境。
  - [ ] 运行中、恢复中和独立验收正在使用的环境不会被删除；覆盖并发引用和清理竞争。
  - [ ] 清理只命中明确选择且验证归属的环境，先预览并保护私密状态及其他项目。
  - [ ] 引用无法确认、存储损坏或删除失败时保守保留并报告，不调用全局 prune。
- 建议后续实现提交：`feat(environments): track environment references and safe cleanup`。
- 与 [SEC-01](03-resource-and-security.md) 分工：容量维护不等于执行时硬磁盘配额。
