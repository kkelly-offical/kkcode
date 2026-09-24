# 从普通聊天到可恢复的严格任务

这是 1.0.5 Preview 开发接口，尚未公开发行。普通聊天、原有 Ultra 和严格委托不是同一个保护级别。只有通过宿主确认合同、独立工作区、严格后端和持久账本启动的任务，才具备本文的隔离/恢复契约。当前验收状态见[实施账本](implementation-1.0.5.md)。

CLI 的开始确认包含当前设备账号。原始批准记录另绑定来源仓库、独立工作树、Git基线、
镜像、验收定义、网络范围、任务图上限、预算及明确选择的依赖环境。恢复先验证这份
不可变授权，再读取项目配置或启动依赖检查；删除依赖引用、替换来源或修改验收不能
沿用旧批准。旧开发期没有该绑定的CLI任务不会自动升级授权，应保留账本并重新确认新任务。
SDK 的 `hostBindingHash` 是可信宿主配置摘要，不是模型提供一个字符串就能取得的权限。

## 1. 准备宿主环境

执行电脑需要 Git、Node ≥22.12 和本机 Linux Docker 后端。Windows/macOS 使用 Docker Desktop 的 Linux 环境，不把原生兼容沙箱说成同等隔离。提前准备并验收固定摘要镜像，含 `/bin/sh`、`/usr/bin/env`、`/usr/bin/timeout`、Node 和项目所需工具；不会自动拉取镜像或借用宿主凭据。

模型通过用户现有渠道配置选择，职责默认沿用会话模型；需要完整、明确的价格及窗口才能核发严格请求预算。详见[职责模型](model-roles-and-profiles.md)和[持久预算](durable-budgets.md)。高级Office/LSP环境见[宿主服务配置](host-services.md)。

## 2. 写出可核查的任务合同

以下为结构示例，目标、路径、测试以及期限要换成真实项目内容；不是通用测试已通过的证明。

```json
{
  "contract": {
    "objective": "修复 app.mjs 的边界错误，保留现有测试并通过独立验收",
    "nonGoals": ["不合并、不部署、不发版"],
    "allowedPaths": ["."],
    "allowedTools": ["read", "list", "write", "edit", "bash"],
    "allowedNetworkOrigins": [],
    "allowedExternalActions": [],
    "requiredCriteria": [{"id":"tests","description":"保留原始测试并实际通过"}]
  },
  "acceptance": {
    "required": true,
    "goal": {
      "goalId": "approved-fix",
      "objective": "保留原始测试并修复边界错误",
      "criteria": [{"id":"tests","kind":"command_exit","text":"原始Node测试通过","spec":{"command":"node","args":["--test","test/app.test.mjs"],"expect":0}}]
    },
    "testSources": ["test/app.test.mjs","package.json"]
  },
  "limits": {"budgetUsd":0,"deadlineAt":1800000000000}
}
```

示例期限是占位值，必须改成未来且不超过七天的绝对毫秒时间。零额度只能准备，不会发送推理。需要实际执行时由你明确给出任务总额度；它包含父任务和子任务，不是每个代理各拿一份。

`allowedPaths` 当前只支持 `[]`（工作副本只读）或 `["."]`（整个独立副本可写）。不支持的细粒度列表明确拒绝，不偷偷扩大范围。工具名必须逐项列明；允许 Bash 意味着它可以在离线容器内运行项目代码，不意味着访问宿主、凭据或网络。HTTP/Browser还需要明确网络来源和出域策略交集。

合同验收ID应与目标判据一致，测试来源必须真实存在。程序会冻结原始测试和选择测试命令的 `package.json`；修改/删除这些文件不能让实现代理降低门槛。完整验收环境、候选、命令与证据会绑定，缺检查保持未知，不补造成功。

## 3. 先预览，再确认

```sh
kkcode runs start --cwd /absolute/repository --contract /absolute/task.json --image sha256:固定摘要 --prepare-only --json
# 核对输出，再重复同一命令并增加 --confirm SHA256
```

预览不会启动模型或创建工作树。确认绑定目标、源仓库、Git基线、镜像、范围和验收。当前CLI从固定提交创建独立副本，**不会复制主工作区未提交变更**；如果希望包含这些内容，请先由你妥善形成所需基线，程序不会自动stash或替你提交。

`--prepare-only` 创建任务后保持等待输入。真实执行使用已明确非零预算的合同并去掉该参数，或按恢复命令确认。`--trust` 仅表示允许源项目配置，不是普通目录访问许可，也不是外部操作授权。

## 4. 查看、停止和恢复

```sh
kkcode runs list --json
kkcode runs show RUN_ID
kkcode runs diagnose RUN_ID
kkcode runs events RUN_ID --after 0 --limit 100
kkcode runs pause RUN_ID --json
kkcode runs cancel RUN_ID --json
kkcode runs resume RUN_ID --json
```

控制/恢复先输出确认值，再以当前确认值执行。任务拥有者代次变化时旧确认无效。暂停/取消保留候选、证据及未知操作；它们不撤销文件修改，不等于撤回已经提交的远端请求。执行器正在收尾时，界面会明确显示。

进程崩溃后新宿主需要接管，旧宿主不能提升结果。账本中 prepared/unknown 操作先核查，不会盲目重放。计费未知和工具副作用未知是两套独立门禁，不能用模型的一句“应该没有执行”清零。SDK高级宿主核查必须提供实际证据及真实批准。

Web/Android在设置中的“任务与验收”可看当前会话的状态、候选、验收、额度和证据；真实设备所有者能确认暂停/取消。共享访客只读。没有新增独立权限档位、快捷键提示或浏览器直播面板。

## 5. 验收和交付

本地通过后进入等待交付，不自动完成、合并或发版。`runs complete` 会再次校验当前候选、原始验收、未决动作、子任务和费用回执。需要PR/MR时使用[Forge交付流程](forge-delivery.md)，远端目标/候选SHA、CI和审查独立核对。

可选[任务图](task-graphs.md)有固定总额度/期限/并发上限，子任务及结果逐项确认，写者独立工作树。接受子任务输出不等于自动合并补丁；主任务仍要集成并独立验收。

维护采用 [`runs backup` / `runs migrate`](sdk-storage.md)：恢复只写新目录，历史导入只形成暂停证据，不自动补回旧压缩已丢弃的原文。不要手工删除锁或未知操作来“修复”停住的任务。
