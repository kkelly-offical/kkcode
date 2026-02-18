# kkcode Agent 模式优化任务清单

> 优先级：P0（高）> P1（中）> P2（低）
> 状态：⬜ 待开始 | 🟡 进行中 | ✅ 已完成

---

## 1. 自定义 Agent 系统 [P1]

### 目标
允许用户通过配置创建专用 Agent，替代单一的 `build` Agent。

### 现状
- 只有 `build` 和 `plan` 两个内置 Agent
- Agent 定义在代码中硬编码

### 优化方案
```yaml
# kkcode.config.yaml
agent:
  custom_agents:
    - name: "security-review"
      description: "专注于安全代码审查"
      tools: ["read", "grep", "codesearch"]
      prompt_file: "security-reviewer.txt"
      permission: "readonly"
      
    - name: "test-writer"
      description: "专注于编写测试代码"
      tools: ["read", "write", "edit", "glob"]
      prompt_file: "tdd-guide.txt"
      permission: "full"
      
    - name: "docs-generator"
      description: "生成项目文档"
      tools: ["read", "glob", "write"]
      prompt_file: "docs-guide.txt"
```

### 使用方式
```bash
kkcode agent --agent security-review
# 或在 REPL 中
> /agent security-review
```

### 涉及文件
- `src/agent/agent.mjs` - Agent 注册和解析
- `src/agent/custom-agent-loader.mjs` - 已存在，需要扩展
- `src/config/schema.mjs` - 配置验证

---

## 2. 动态步数限制 [P1]

### 目标
根据任务复杂度自动调整 `max_steps`，避免简单任务浪费额度，复杂任务被截断。

### 现状
- `max_steps` 固定为 8（默认值）
- 复杂任务经常触发 `max_tokens` 截断

### 优化方案
```yaml
agent:
  max_steps: 8  # 基础值
  adaptive_steps:
    enabled: true
    rules:
      - condition: "file_count > 10"
        multiplier: 1.5
      - condition: "task_type == 'refactor'"
        multiplier: 2.0
      - condition: "has_tests == false"
        add: 3
    max_limit: 25
```

### 实现逻辑
1. 任务开始前分析：文件数量、任务类型、代码复杂度
2. 根据规则计算建议步数
3. 用户确认或自动应用

### 涉及文件
- `src/session/loop.mjs` - 步数控制逻辑
- `src/session/engine.mjs` - 任务分析

---

## 3. 任务完成验证增强 [P0]

### 目标
确保 Agent 真正完成任务，而不是虚假报告完成。

### 现状
- 有 `verify_completion` 选项，但验证逻辑简单
- 经常出现"标记完成但任务未完成"的情况

### 优化方案
```yaml
agent:
  verify_completion: true
  completion_criteria:
    todo_check:
      enabled: true
      require_empty: true
    
    syntax_check:
      enabled: true
      languages: ["javascript", "typescript", "python"]
    
    test_check:
      enabled: true
      require_pass: false  # 只检查测试存在性
      auto_run: true
    
    lint_check:
      enabled: true
      command: "npm run lint"
```

### 验证流程
1. Agent 报告完成
2. 系统自动检查 todo 列表
3. 运行语法检查（默认）
4. 对于代码类的任务，创建测试项目，并且运行测试（默认）
5. 读取测试结果，并且检验，只有当验证通过才结束会话，否则提示继续

### 涉及文件
- `src/session/loop.mjs` - 完成验证逻辑
- `src/tool/executor.mjs` - 工具执行

---

## 4. 智能工具权限管理 [P2]

### 目标
根据任务类型自动限制可用工具，减少误操作风险。

### 现状
- `ask` 模式有只读限制
- `agent` 模式有完整权限
- 缺乏中间层级

### 优化方案
```yaml
agent:
  tool_profiles:
    readonly:
      - read
      - glob
      - grep
      - list
      - codesearch
      
    code-edit:
      - read
      - edit
      - write
      - glob
      - grep
    safe-execution:
      - read
      - bash:  # 限制 bash 命令
          allowed_patterns:
            - "^npm test"
            - "^npm run build"
            - "^git status"
          blocked_patterns:
            - "rm -rf"
            - ">.*"
```

### 涉及文件
- `src/session/loop.mjs` - 工具过滤逻辑
- `src/permission/engine.mjs` - 权限检查

---

## 5. Agent 记忆系统 [P2]

### 目标
让 Agent 记住用户的偏好和项目约定，跨会话保持一致性。

### 现状
- 每次会话都是独立的
- 需要重复说明项目规范

### 优化方案
```yaml
agent:
  memory:
    enabled: true
    storage: "~/.kkcode/agent-memory.json"
    max_items: 100
    auto_learn: true  # 自动从对话中提取偏好
    
    # 记忆类型
    categories:
      - name: "coding_style"
        description: "代码风格偏好"
      - name: "project_conventions"
        description: "项目约定"
      - name: "user_preferences"
        description: "用户个人偏好"
```

### 自动学习示例
```
User: 请使用 2 空格缩进
→ 提取记忆: {category: "coding_style", key: "indent", value: "2 spaces"}

User: 我喜欢函数式编程风格
→ 提取记忆: {category: "coding_style", key: "paradigm", value: "functional"}
```

### 涉及文件
- `src/session/memory-loader.mjs` - 已存在，需要扩展
- `src/agent/agent.mjs` - Agent 提示词构建

---

## 6. 并行工具执行优化 [P1]

### 目标
更智能地并行执行独立工具，提高响应速度。

### 现状
- 已支持并行，但没有依赖分析
- 有时不必要的串行执行

### 优化方案
```javascript
// 工具依赖图
const TOOL_DEPENDENCIES = {
  read: [],           // 无依赖
  glob: [],           // 无依赖
  grep: [],           // 无依赖
  write: ["read"],    // 写之前需要先读
  edit: ["read"],     // 编辑前需要先读
  bash: ["read"],     // 执行命令前可能需要检查文件
}

// 自动分组并行执行
// Group 1: glob, grep (并行)
// Group 2: read (依赖 Group 1 结果)
// Group 3: edit (依赖 Group 2 结果)
```

### 涉及文件
- `src/session/loop.mjs` - 工具执行调度
- `src/tool/executor.mjs` - 工具执行器

---

## 7. 定价配置扩展 [P1]

### 目标
支持自定义模型定价，特别是国内模型（如通义千问）。

### 现状
- 默认定价只包含 Claude 和 GPT 系列
- 阿里 DashScope 模型没有定价信息

### 优化方案
```yaml
# pricing.yaml
usage:
  pricing:
    currency: "USD"
    per_tokens: 1000000
    models:
      # 阿里 DashScope
      "qwen-max":
        input: 0.02
        output: 0.06
      "qwen-plus":
        input: 0.001
        output: 0.002
      "qwen-turbo":
        input: 0.0005
        output: 0.001
        
      # 其他国产模型
      "deepseek-chat":
        input: 0.27
        output: 1.1
```

### 涉及文件
- `src/usage/pricing.mjs` - 定价加载
- `templates/pricing.default.yaml` - 默认定价模板

---

## 8. 状态栏信息增强 [P2]

### 目标
在状态栏显示更多有用信息。

### 优化方案
```
# 当前
AGENT   MODEL qwen-max   TOKENS T:10 ~   COST $0.0001   CTX 0%   PERMISSION ASK

# 优化后
AGENT   MODEL qwen-max   TOKENS T:10/S:150/G:1200   COST $0.0001/$0.05   CTX 15%   STEP 3/8   PERMISSION ASK
```

### 新增信息
- `S:150` - Session 累计 token
- `G:1200` - Global 累计 token
- `$0.05` - Session 累计成本
- `STEP 3/8` - 当前步数/最大步数

### 涉及文件
- `src/theme/status-bar.mjs` - 状态栏渲染
- `src/repl.mjs` - REPL 界面

---

## 快速开始建议

### 第一阶段（本周）
1. ✅ 完成定价配置扩展（任务 7）- 影响成本显示准确性
2. ✅ 完成任务完成验证增强（任务 3）- 提高任务完成质量

### 第二阶段（下周）
3. 🟡 动态步数限制（任务 2）
4. 🟡 自定义 Agent 系统（任务 1）

### 第三阶段（后续）
5. ⬜ 智能工具权限管理（任务 4）
6. ⬜ Agent 记忆系统（任务 5）
7. ⬜ 并行工具执行优化（任务 6）
8. ⬜ 状态栏信息增强（任务 8）

---

## 贡献指南

### 开发流程
1. 从 `main` 分支创建 feature 分支
2. 实现功能并添加测试
3. 更新文档
4. 提交 PR

### 代码规范
- 使用 ES Module
- 添加 JSDoc 注释
- 保持向后兼容

---

*最后更新: 2026-02-18*