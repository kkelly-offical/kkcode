# Project Memory

## Repository

- URL: https://github.com/kkelly-offical/kkcode.git
- Remote: origin

## Workflow Rules

- 每次测试成功后，提交 commit 并推送到 GitHub 仓库。
- 推送前核对所有版本号：`package.json`、`NOTICE.md`、`README.md`、`src/repl.mjs`、`src/index.mjs`、`src/mcp/constants.mjs` 必须一致。

## Validation Rules

- 所有修改过的文件必须通过 `node --check <file>` 语法检查。
- 优先运行相关测试文件（如 `node --test test/xxx.test.mjs`），而非全量 `npm test`。
- 区分预存失败和本次改动引入的失败（如环境缺失 `.kkcode/` 目录、缺少 `yaml` 依赖等属于预存问题）。
- 修改分发/路由逻辑时，必须同步更新测试配置以匹配新的默认行为。
- 大块代码删除前后，验证文件边界完整性（grep 行号 + 读取上下文确认）。
- 删除函数/变量前，先 grep 确认无其他引用。
- 提交 commit 时不需要添加 Co-Authored-By 信息。
