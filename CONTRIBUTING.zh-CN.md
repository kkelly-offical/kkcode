# 贡献指南

[English Version](CONTRIBUTING.md)

感谢你对 kkcode 的关注！本指南将帮助你参与贡献。

## 如何参与

### 提交 Issue

所有人都可以[提交 Issue](https://github.com/kkelly-offical/kkcode/issues/new/choose)。我们提供了以下模板：

- **Bug 报告** — 发现了 Bug？告诉我们。
- **功能建议** — 有新功能的想法？
- **功能改进** — 想改进现有功能？
- **问题求助** — 需要帮助或有疑问？

### Pull Request

我们欢迎社区提交 PR，但请注意：

- 所有 PR 需要**团队成员审查并批准**后才能合并。
- 较大的变更请先开 Issue 讨论方案。
- 保持 PR 专注——每个 PR 只关注一件事。

## 开发环境

### 前置要求

- **Node.js** >= 22
- **pnpm**（推荐）或 npm

### 快速开始

```bash
git clone https://github.com/kkelly-offical/kkcode.git
cd kkcode
npm install
npm run start
```

### 运行测试

```bash
npm test
npm run test:e2e
```

## 代码风格

- 纯 ESM（`.mjs` 文件）——不使用编译工具
- 不使用 TypeScript——使用纯 JavaScript，必要时用 JSDoc 注释
- 极简依赖——添加新依赖前请三思
- 优先使用函数而非类
- 使用描述性变量名，不用缩写

## Commit 规范

遵循以下 commit 消息格式：

```
<类型>: <简短描述>

[可选的详细说明]
```

**类型说明：**

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `enhance` | 现有功能改进 |
| `refactor` | 代码重构（不改变行为） |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建、CI、工具链 |

**示例：**

```
feat: add websearch tool
fix: prevent file lock deadlock in parallel writes
docs: update LongAgent section in README
```

## 分支策略

- `main` — 稳定发布分支，受保护
- 功能分支命名：`feat/<名称>`、`fix/<名称>`、`enhance/<名称>`
- 从 `main` 创建分支，提交 PR 回到 `main`

## 项目结构

详见 [README.md — 项目结构](README.md#项目结构)。

## 安全问题

如果你发现安全漏洞，**请不要提交公开 Issue**。请遵循[安全政策](SECURITY.md)。

## 许可证

参与贡献即表示你同意你的贡献将以 [GPL-3.0 许可证](LICENSE) 发布。
