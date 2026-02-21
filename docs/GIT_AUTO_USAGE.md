# Git 自动化使用说明

kkcode 现在支持 AI Agent 自动进行 Git 仓库操作，参考了 OpenAI Codex 的设计哲学：**AI 可以修改代码，但用户保留最终提交控制权**。

## 核心概念

### Ghost Commit（幽灵提交）

幽灵提交是一种临时的 Git 提交对象，它：
- ✅ 保存工作目录的完整状态
- ✅ 可以被 AI 创建和恢复
- ❌ **不引用在任何分支上**（不是正式的 Git 历史）
- ⏰ 默认 7 天后自动清理

### 安全原则

1. **AI 只修改，不提交** - 所有实际的 `git commit` 操作必须由用户手动执行
2. **幽灵提交用于回滚** - 不是正式的 Git 历史，只是临时的快照点
3. **安全第一** - 通过执行策略禁止危险的 Git 操作（如 `git commit`、`git push`）

## 配置方法

### 安全模式（默认）

在 `~/.kkcode/config.yaml` 中添加：

```yaml
git_auto:
  enabled: true           # 启用 Git 自动化功能（默认：true）
  auto_snapshot: true     # 每次 AI 修改前自动创建快照（默认：true）
  max_snapshots: 50       # 每个仓库最多保留的快照数（默认：50）
  ttl_days: 7             # 快照保留天数（默认：7）
  forbid_commit: true     # 禁止 AI 执行 git commit（默认：true）
  forbid_push: true       # 禁止 AI 执行 git push（默认：true）
```

### 全自动化模式（⚠️ 高级用户）

**警告**：全自动化模式会赋予 AI 更大的权限，包括自动提交和推送。建议仅在受控环境、CI/CD 场景或个人项目中使用。

```yaml
git_auto:
  enabled: true           # 启用 Git 自动化功能
  full_auto: true         # ⚠️ 启用全自动化模式
  auto_commit: true       # AI 可以自动执行 git commit
  auto_push: true         # AI 可以自动执行 git push
  auto_stage: true        # 自动 stage 更改（默认启用）
  allow_dangerous_ops: false  # 是否允许危险操作（如 force push）
  
  # 快照配置（建议保持启用作为安全措施）
  auto_snapshot: true     # 修改前自动创建快照
  max_snapshots: 50
  ttl_days: 7
```

### 模式对比

| 功能 | 安全模式 | 全自动化模式 |
|------|---------|-------------|
| `git_snapshot` | ✅ | ✅ |
| `git_restore` | ✅ | ✅ |
| `git_apply_patch` | ✅ | ✅ |
| `git_auto_stage` | ❌ | ✅ |
| `git_auto_commit` | ❌ | ✅ |
| `git_auto_push` | ❌ | ✅ |
| `git commit` (bash) | ❌ | ✅ (需 auto_commit) |
| `git push` (bash) | ❌ | ✅ (需 auto_push) |
| `git push --force` | ❌ | ⚠️ (需 allow_dangerous_ops) |


## 工具列表

### 1. git_snapshot - 创建幽灵提交快照

在 AI 修改代码前创建临时快照，用于后续可能的回滚。

**输入参数：**
- `message` (string, 可选): 快照描述信息
- `paths` (string[], 可选): 要包含的特定文件路径，默认为所有更改
- `auto` (boolean, 可选): 是否为自动创建的快照

**使用示例：**
```json
{
  "tool": "git_snapshot",
  "args": {
    "message": "Before refactoring auth module",
    "paths": ["src/auth.js", "src/utils.js"]
  }
}
```

**返回结果：**
```json
{
  "ok": true,
  "snapshot": {
    "id": "gc_abc123",
    "commitHash": "a1b2c3d4...",
    "shortHash": "a1b2c3d4",
    "message": "Before refactoring auth module",
    "createdAt": 1700000000000,
    "files": ["src/auth.js", "src/utils.js"]
  }
}
```

### 2. git_restore - 恢复到指定快照

将工作目录恢复到之前创建的幽灵提交状态。

**输入参数：**
- `snapshot_id` (string, 必需): 快照 ID
- `restore_index` (boolean, 可选): 是否同时恢复暂存区

**使用示例：**
```json
{
  "tool": "git_restore",
  "args": {
    "snapshot_id": "gc_abc123",
    "restore_index": false
  }
}
```

### 3. git_list_snapshots - 列出所有快照

查看当前仓库的所有幽灵提交快照。

**输入参数：**
- `include_expired` (boolean, 可选): 是否包含已过期的快照

**使用示例：**
```json
{
  "tool": "git_list_snapshots"
}
```

### 4. git_apply_patch - 应用 AI 生成的 diff 补丁

应用 AI 生成的统一格式 diff/patch 到工作目录。

**输入参数：**
- `diff` (string, 必需): 统一格式的 diff 内容
- `preflight_only` (boolean, 可选): 仅检查是否可应用，不实际修改
- `threeway` (boolean, 可选): 使用三方合并（默认：true）

**使用示例：**
```json
{
  "tool": "git_apply_patch",
  "args": {
    "diff": "diff --git a/src/file.js b/src/file.js\n--- a/src/file.js\n+++ b/src/file.js\n@@ -1,5 +1,5 @@\n function hello() {\n-  return 'world';\n+  return 'kkcode';\n }",
    "preflight_only": false,
    "threeway": true
  }
}
```

### 5. git_info - 获取仓库信息

收集当前 Git 仓库的上下文信息供 AI 使用。

**返回信息：**
- 当前分支名称
- 当前 commit hash
- 远程仓库 URL
- 是否有未提交的更改
- 变更文件列表

**使用示例：**
```json
{
  "tool": "git_info"
}
```

### 6. git_status - 获取当前状态

获取详细的 Git 状态，包括未提交更改和 diff。

**输入参数：**
- `include_diff` (boolean, 可选): 是否包含实际的 diff 内容（默认：true）

**使用示例：**
```json
{
  "tool": "git_status"
}
```

### 7. git_delete_snapshot - 删除快照

手动删除指定的幽灵提交快照。

**输入参数：**
- `snapshot_id` (string, 必需): 要删除的快照 ID

**使用示例：**
```json
{
  "tool": "git_delete_snapshot",
  "args": {
    "snapshot_id": "gc_abc123"
  }
}
```

### 8. git_cleanup - 清理过期快照

清理所有仓库中已过期的幽灵提交快照。

**使用示例：**
```json
{
  "tool": "git_cleanup"
}
```

## 典型工作流程

### 场景 1: AI 帮助重构代码

```
1. 用户: "帮我重构这个函数"
   
2. AI 执行:
   - git_snapshot { message: "Before refactoring" }
   - 分析代码并生成修改
   - 应用修改 (edit/write/git_apply_patch)
   
3. 用户满意:
   - 手动运行: git add . && git commit -m "refactor: extract helper function"
   
4. 用户不满意:
   - AI 执行: git_restore { snapshot_id: "gc_xxx" }
   - 或者用户手动运行: git checkout -- .
```

### 场景 2: 批量修改多个文件

```
1. AI 执行:
   - git_snapshot { message: "Before batch updates" }
   
2. AI 逐个修改文件（自动快照已启用时，每次修改前都会自动创建快照）
   - edit file1.js
   - edit file2.js
   - write file3.js
   
3. 用户审查:
   - git_status 查看所有更改
   - 如有问题: git_restore 回滚到最后一个快照
   
4. 用户确认后手动提交
```

## 执行策略

以下命令被 AI **禁止执行**（通过 bash 工具）：

| 命令模式 | 原因 |
|---------|------|
| `git commit` | AI 不能创建正式提交，请使用 git_snapshot |
| `git push` | AI 不能推送到远程，用户需手动审查后推送 |
| `git push --force` | 强制推送可能覆盖远程历史，极度危险 |
| `git reset --hard` | 会销毁未提交更改，使用 git_restore 代替 |
| `git clean -f/-d` | 删除未跟踪文件，危险操作 |
| `rm -rf /` | 危险文件删除 |
| `curl \| sh` | 管道到 shell 执行任意代码 |

## 存储位置

- **幽灵提交元数据**: `~/.kkcode/ghost-commits/<repo-hash>/gc_<id>.json`
- **会话快照状态**: `~/.kkcode/sessions/<session-id>/git-snapshot-state.json`

## 故障排除

### "not a git repository" 错误

确保当前工作目录是 Git 仓库的根目录或子目录：
```bash
git status
```

### 快照恢复失败

1. 检查快照是否存在：`git_list_snapshots`
2. 检查是否有未提交的更改可能产生冲突
3. 手动解决冲突后重试

### 存储空间清理

手动清理所有过期快照：
```json
{ "tool": "git_cleanup" }
```

## 与 Codex 的对比

| 特性 | kkcode | Codex |
|-----|--------|-------|
| Ghost Commit | ✅ | ✅ |
| Patch 应用 | ✅ | ✅ |
| 执行策略 | ✅ | ✅ |
| 自动快照 | ✅ | ✅ |
| 配置选项 | 更灵活 | 内置 |
| 跨平台 | Windows/Linux/Mac | Linux/Mac 为主 |

## 全自动化工具说明

以下工具仅在 `git_auto.full_auto: true` 时可用：

### 1. git_auto_commit - 自动提交

自动 stage 所有更改并创建 git commit。

**使用示例：**
```json
{
  "tool": "git_auto_commit",
  "args": {
    "message": "feat: add new feature",
    "stage_all": true,
    "amend": false
  }
}
```

### 2. git_auto_push - 自动推送

自动推送当前分支到远程仓库。

**使用示例：**
```json
{
  "tool": "git_auto_push",
  "args": {
    "remote": "origin",
    "branch": "main",
    "force": false
  }
}
```

### 3. git_auto_stage - 自动暂存

自动 stage 文件。

**使用示例：**
```json
{
  "tool": "git_auto_stage",
  "args": {
    "all": true
  }
}
```

### 4. git_full_auto_status - 查看全自动化状态

查看当前全自动化模式的配置和可用操作。

**使用示例：**
```json
{
  "tool": "git_full_auto_status"
}
```

## 全自动化工作流程示例

### 场景：AI 自动完成一个功能并提交

```yaml
# 配置启用全自动化
git_auto:
  full_auto: true
  auto_commit: true
  auto_push: false  # 谨慎启用自动推送
  auto_snapshot: true
```

```
用户: "帮我添加用户认证功能"
   ↓
AI:
  1. git_full_auto_status - 检查权限
  2. git_info - 了解仓库状态
  3. 创建/修改相关文件
  4. git_auto_stage - 自动 stage
  5. git_auto_commit - 自动提交
   ↓
用户: "推送到远程"
   ↓
AI: git_auto_push { remote: "origin", branch: "main" }
```

## 安全警告

⚠️ **全自动化模式风险**：

1. **不可逆操作** - 一旦提交，更改就进入 Git 历史
2. **远程推送** - `auto_push: true` 会直接修改远程仓库
3. **危险操作** - `allow_dangerous_ops: true` 会允许 force push 等危险命令
4. **代码质量** - AI 生成的提交信息可能不够精确

**建议**：
- 在个人项目或 CI/CD 环境中使用全自动化模式
- 团队协作项目建议保持安全模式
- 启用 `auto_snapshot` 作为回滚保障
- 定期审查 AI 创建的提交

## 最佳实践

1. **启用自动快照** - 在配置中设置 `auto_snapshot: true`
2. **定期清理** - 运行 `git_cleanup` 清理过期快照
3. **手动提交** - 始终由用户执行最终的 `git commit`（安全模式）
4. **小步快跑** - 每次修改后检查状态，有问题及时回滚
5. **谨慎使用全自动化** - 仅在受控环境中启用 `full_auto`
