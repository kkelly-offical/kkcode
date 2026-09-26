# 有来源的项目与个人记忆

[文档导航](README.md) · 适用源码：1.1.6；[发行状态](versions.md)

记忆是历史参考，不是新的系统指令、审批凭据或永久授权。当前用户要求、工作区规则和运行时权限始终优先。

## 范围与身份

项目记忆按真实工作目录（解析路径别名后的 canonical cwd）、账号、网关和组织隔离；个人偏好只在相同账号／网关／组织内跨项目使用。未绑定设备使用独立的本机范围。绑定账号变化后，旧记录留在旧范围，不自动转给新账号。

记录位于设备私密状态目录的 `memories-v1`，采用进程锁和原子私密文件写入；不存入 Git 工作目录，不默认上传网关。旧控制句柄检测到账号或项目变化会拒绝继续访问。

## 从候选到可用记忆

- 自由文本提议、旧 instinct、导入的高 confidence 值均只能创建 `candidate`；重复出现不等于确认。
- 宿主确认必须通过真实用户界面回调，记录确认者与确认回执的摘要。传入 `approved: true` 或伪造 JSON evidence 不能激活记忆。
- 跨项目个人偏好始终需要该确认，不能自动晋升。
- 确认绑定候选版本、正文和账号。确认期间发生纠正、遗忘、换账号，旧确认失效。
- 本阶段自动项目观察只读取 `package.json` 的结构事实：模块类型、包管理器、有限依赖名称和常见脚本是否存在。它不复制脚本命令、描述正文、网页内容或工具输出，也不声称测试执行成功。
- 自动事实保留源文件 SHA-256、来源会话／回合和观察时间，提交前再次核对文件；文件改变后，旧事实在提示中失效，重新观察后才更新。

## 管理接口

内核导出 `createMemoryController({ cwd, confirmMemory })`。身份由设备读取，不接受调用参数覆盖账号／网关／组织。

| 方法 | 行为 |
| --- | --- |
| `propose({ scope, text, category, sessionId, turnId })` | 建立候选，默认项目范围 |
| `list({ scope, includeCandidates, includeDisabled })` / `get({ scope, id })` | 查看正文、版本、来源、状态 |
| `correct({ scope, id, expectedVersion, text })` | 纠正后成为新版本候选，旧确认不沿用 |
| `confirm({ scope, id, expectedVersion })` | 调用宿主真实确认后激活 |
| `setEnabled({ scope, id, expectedVersion, enabled })` | 禁用立即停止注入；重新启用需要确认 |
| `forget({ scope, id, expectedVersion })` | 删除正文、来源、版本记录；不在自动观察时悄悄重学 |
| `observeProject({ sessionId, turnId })` | 读取并复核限定的项目结构事实 |
| `legacySources()` / `importLegacy({ source })` | 查看旧来源并经确认导入候选 |
| `formatForPrompt()` | 投影当前有效参考；不用于授权判定 |

`scope` 为 `project` 或 `personal`；类别为 `project-fact`、`workflow`、`preference`。修改需要最新 `expectedVersion`，冲突要求刷新，而不是覆盖他人修改。

宿主 `confirmMemory(request)` 必须来自实际用户操作，返回 `{ approved: true, confirmedBy, approvalId }`。没有回调、取消或拒绝均不激活。该工厂是宿主接口，不能由模型提供回调实现。

Node SDK 子路径为 `@kkelly-offical/kkcode/sdk/memory`，包含完整 TypeScript 类型；它不属于浏览器 bundle。

```sh
kkcode memory --cwd /path/to/project list
kkcode memory --cwd /path/to/project --scope personal propose "优先使用简洁的中文汇报"
kkcode memory --cwd /path/to/project --scope personal show MEMORY_ID
kkcode memory --cwd /path/to/project --scope personal confirm MEMORY_ID --version 1
kkcode memory --cwd /path/to/project observe
kkcode memory --cwd /path/to/project legacy
kkcode memory --cwd /path/to/project import auto-memory
```

CLI 的确认、重新启用、导入和遗忘需要真实 TTY 输入所显示的确认短语；不提供 `--yes` 静默激活。`--json` 仅改变结果显示，不绕过审批。纠正、禁用及遗忘命令同样要求所查看的版本号。

远程 `memory.*` 接口只开放给设备实际所有者，共享会话访客不能读取个人偏好或项目记忆。项目范围由有效 `sessionId` 的实际工作目录派生，不能从请求传入任意 `cwd/account/gateway/org`。激活、重新启用、导入和遗忘要求所有者在 UI 中作出 `confirmed: true` 的明确动作，并对相应候选检查版本；这些方法不注册为模型工具。

设备去重日志仅记录记忆写操作的完成状态，不缓存返回正文；重复请求会要求客户端刷新记录，不重复执行，也不会在遗忘后从旧请求日志重新返回正文。`memory.updated` 事件只携带范围与会话标识。

## 旧文件与迁移

旧 `MEMORY.md` 和 `instincts.json` 保留在原位置，启动时不默默删除、迁移或跨账号加载正文。检测到文件后，提示可通过记忆管理显式导入。

导入旧文件先要求宿主确认当前用户有权使用它，然后进行敏感内容检查；安全内容也只进入候选，不能继承旧 confidence 或观察次数的权威性。支持 `auto-memory`、`instincts`、`project-memory` 三种来源。原文件不被导入操作删除。

Ultra 的旧工作区 `.kkcode/project-memory.json` 仍保留兼容存取，但提示投影明确标为未核验的工作区参考，并过滤秘密和明显越权指令；它不等于新账号范围内的已确认记忆。用户手写的 `AGENTS.md` 等仍走原工作区指令加载规则。

## 安全与容量边界

每条正文上限 2000 字符，每个范围最多 500 条；每份存储上限 2 MiB。提示最多选择 30 条、约 8000 字符的有效参考，并采用 JSON 转义和低优先级来源标记。

凭据标签、已知密钥格式、含认证信息的链接、当前环境中的已知秘密值和明显覆盖系统／审批的文本会被拒绝，不把原文复制到错误日志。自动事实采用固定模板和字段白名单，而不是依赖模型自己声称“安全”。

这些检查不是完整秘密识别或对任意提示注入的数学保证；执行隔离、凭据权限与项目出域规则仍必须独立生效。运行时内存工厂和本机私密状态属于可信宿主边界。

遗忘清理活动记录中的正文和历史摘要，保留不可读的内容指纹或自动事实键以抑制自动重新学习；不宣称能擦除既有对话、用户自行备份、旧原始文件或磁盘底层历史。旧来源文件需要用户单独管理。

损坏或未知版本记录不会被当成空数据库覆盖，也不会回退加载未经确认的旧记忆。
