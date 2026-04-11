# kkcode CLI General Assistant Capability Matrix (0.1.11)

This document defines the **0.1.11 shipped capability boundary** for kkcode as a pure CLI general assistant.

The goal is not to turn kkcode into an IDE shell or GUI automation platform. The goal is to make it reliably useful for high-value terminal-native work across coding, local machine tasks, repo operations, bounded research, and release assistance.

## Scope principle

kkcode 0.1.11 should be understood as:

- **CLI-first**
- **local-machine capable**
- **code-strong by default**
- **general-assistant friendly for bounded terminal work**
- **explicitly not a GUI / desktop automation product**

## Capability taxonomy

| Capability lane | Typical user request | Current tool / runtime anchor | 0.1.11 status |
| --- | --- | --- | --- |
| Coding | “修这个 bug”, “改一下 README”, “补测试” | `read` / `write` / `edit` / `patch` / `multiedit` / LongAgent | Shipped |
| Local filesystem inspection | “看看这个目录”, “读一下配置”, “搜某个字符串” | `list` / `glob` / `grep` / `read` | Shipped |
| Shell / task execution | “跑一下测试”, “检查日志”, “执行这个命令” | `bash` | Shipped |
| Repo / release assistance | “看 git 状态”, “做快照”, “恢复现场” | `git_status` / `git_info` / `git_snapshot` / `git_restore` | Shipped |
| Web lookup / fetch | “查一下最近的变更”, “抓这个网页内容” | `websearch` / `webfetch` | Shipped |
| Codebase research | “找路由逻辑在哪”, “汇总代码编辑能力” | `codesearch` / read-only analysis | Shipped |
| Structured delegation | “把这个子任务交给子智能体” | `task` / `background_output` / `background_cancel` | Shipped |
| Planning / approval | “先规划”, “进入 plan” | `enter_plan` / `exit_plan` | Shipped |
| Interactive clarification | “需要我回答什么？” | `question` | Shipped |

## What “general assistant” means in practice

0.1.11 broadens kkcode from a narrow code runner into a terminal-native assistant that can also:

- inspect directories and logs
- summarize local configs and repo state
- help with release hygiene and verification
- combine shell execution with codebase reasoning
- choose a lighter route for small local tasks instead of over-triggering LongAgent

## Non-goals for this release

These are **not** part of the 0.1.11 public contract:

- IDE integration
- desktop GUI automation
- browser automation as a first-class local surface
- mobile / voice / bridge product surfaces
- marketplace / plugin auto-install / remote plugin distribution

## Routing implications

The capability matrix should influence routing behavior in one specific way:

- a bounded local task should remain eligible for `ask` or `agent`
- a short terminal task should not become LongAgent just because it mentions design, logs, or multiple checks
- LongAgent remains the preferred lane for structured multi-file delivery and staged ownership

## Prompting / assistant behavior contract

When kkcode is acting as a CLI general assistant, it should:

1. prefer direct local completion for small bounded work
2. avoid over-delegating one-shot terminal actions
3. keep GUI/platform promises explicit and conservative
4. preserve LongAgent for heavyweight delivery rather than flattening everything into one agent surface

## Release checklist

Before shipping 0.1.11, confirm:

- README reflects the CLI general assistant boundary
- prompt/runtime copy does not imply GUI automation support
- tool surface still covers coding + local ops + shell + web + repo + delegation
- routing tests keep heavy multi-file work on LongAgent
