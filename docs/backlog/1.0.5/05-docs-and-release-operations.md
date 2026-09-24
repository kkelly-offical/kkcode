# 文档与发布流程待办

基线：`1.0.5-preview.0` 已公开，发行产物已核验；此处只登记后续改进，见[总索引](README.md)。
证据：[实施账本](../../implementation-1.0.5.md)、[文档导航](../../README.md)、
[路线图](../../ROADMAP.md)、[发行回执 PR #6](https://github.com/kkelly-offical/kkcode/pull/6)。

## DOC-01 · P1 · 当前状态与历史快照分离

- 类型／状态：已确认的文档状态混杂／待整理。
- 现状：实施账本保留完整过程，但旧工作包表仍有“品牌 CI 失败”“尚未合入 main”
  等过时描述；文档导航和路线图也有旧版当前状态。新版工程 CI 和六组品牌浏览器
  实际已通过，不能把历史失败继续列为当前待办。
- 范围：提供单一当前状态表，把历史过程明确归档；保留原提交、失败和收据。
  AGENTS.md 缩短为当前交接与仍有效约束，历史细节用可追溯链接维护。
- 验收标准：
  - [ ] README、导航、路线图、工作包表对稳定版／Preview／部署状态描述一致。
  - [ ] 历史失败有时间／提交标记，已修复项指向新证据，不删除或覆盖旧记录。
  - [ ] “接口有代码”“工程通过”“真实模型通过”“生产部署”分别表述。
  - [ ] 所有本地文档链接可解析；保留历史版本号，不全局替换旧发布文档。
  - [ ] PR #6 按仓库规则审核；本轮待办不冒充其已合并，也不为文档更新重发二进制。
- 建议后续实现提交：`docs: separate current acceptance status from historical checkpoints`。

## REL-01 · P2 · npm 接受发布与公开可下载分状态

- 类型／状态：发布流程改进／待实现，不是当前包仍不可用。
- 现状：本次 npm 发布命令成功后，平台异步处理了数分钟；元数据先可见，tarball
  随后才可下载。最终匿名下载／干净安装均通过，原延迟已经解决。
- 范围：在发布回执中区分 accepted、processing、distribution-ready，提供有界
  的匿名下载核验；预先准备相同不可变 CI 包的 GitHub 安装入口。
- 验收标准：
  - [ ] 元数据、dist-tag、tarball 下载和 CI hash 逐层检查，保护稳定 latest 不变。
  - [ ] 覆盖 metadata 先到／文件仍 404、网络超时、hash 不符等受控正负路径。
  - [ ] 处理超时显示“已接受、分发待核验”，不能误导用户重复 publish 或删除重发。
  - [ ] 验证流程可继续，不重复上传版本或移动已发布标签；重试有次数和时间上限。
  - [ ] 实际公开下载与安装证据保存；CI 的成功安装不冒充公网来源验证。
- 入口：`.github/workflows/release.yml`、`scripts/package-artifact-verify.mjs`、
  `scripts/release-policy.mjs`。
- 建议后续实现提交：`fix(release): verify public distribution after registry processing`。

## REL-02 · P1 · 发布操作同时核查 repository rulesets

- 类型／状态：发布治理改进／待落实到操作入口及回归。
- 现状：本次 main 快进推送触发已有凭据的旁路权限，已披露，未修改规则。
  普通 branch-protection 接口返回 404 不代表没有保护；仓库 ruleset 实际要求 PR 和审核。
- 范围：发布前预检同时读取适用 rulesets 与传统保护；明确允许的提交路径和当前
  审查状态。先核查既有 SDK 能力，不能无证据宣称 Forge 已有同样实现缺陷。
- 验收标准：
  - [ ] “旧接口404＋活动PR规则”必须仍报告审核要求；权限不足不等于没有规则。
  - [ ] 不使用 admin/bypass 作为默认解法，不自动改规则、伪造批准或自批自合。
  - [ ] 所有 mutation 仍服从用户本次授权，草稿往返测试不附带合并／发布权限。
  - [ ] 覆盖规则继承、未批准、候选变化、只读预检与有效批准的允许路径。
  - [ ] 失败保留可行动说明；门禁测试使用专用 fixture，不拿真实 main 试绕过。
- 建议后续实现提交：`fix(release): check repository rulesets before protected branch updates`。

公共网关镜像发布按用户决定暂不处理；这里不新增 registry、镜像推送或生产部署任务。
