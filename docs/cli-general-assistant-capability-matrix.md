# kkcode CLI General Assistant Capability Matrix (0.1.13)

This document defines the **0.1.13 shipped capability boundary** for kkcode as a pure CLI general assistant.

The goal is not to turn kkcode into an IDE shell or GUI automation platform. The goal is to make it reliably useful for high-value terminal-native work across coding, local machine tasks, repo operations, bounded research, interrupted-task continuation, and release assistance.

## Scope principle

kkcode 0.1.13 should be understood as:

- **CLI-first**
- **agent-default for bounded terminal work**
- **LongAgent reserved for heavyweight staged delivery**
- **code-strong by default**
- **general-assistant friendly for bounded local transactions**
- **explicitly not a GUI / desktop automation product**

Public mode contract:

- `ask` = read-only explanation and analysis
- `plan` = produce a spec / plan only, without file mutation
- `agent` = default bounded local execution lane
- `longagent` = staged multi-file delivery lane
- upgrade from `agent` to `longagent` only when heavy multi-file evidence appears

## Capability taxonomy

| Capability lane | Typical user request | Current tool / runtime anchor | 0.1.13 status |
| --- | --- | --- | --- |
| Coding | “修这个 bug”, “改一下 README”, “补测试” | `read` / `write` / `edit` / `patch` / LongAgent | Shipped |
| System / runtime summary | “看一下系统信息”, “当前环境怎样”, “机器资源概况” | `sysinfo` | Shipped |
| Local filesystem inspection | “看看这个目录”, “读一下配置”, “搜某个字符串” | `list` / `glob` / `grep` / `read` | Shipped |
| Shell / task execution | “跑一下测试”, “检查日志”, “执行这个命令” | `bash` | Shipped |
| Repo / release assistance | “看 git 状态”, “做快照”, “恢复现场” | `git_status` / `git_info` / `git_snapshot` / `git_restore` | Shipped |
| Web lookup / fetch | “查一下最近的变更”, “抓这个网页内容” | `websearch` / `webfetch` | Shipped |
| Codebase research | “找路由逻辑在哪”, “汇总代码编辑能力” | `codesearch` / read-only analysis | Shipped |
| Interrupted-turn continuation | “刚才那个检查继续做，再顺手改一下配置” | same session transcript + routing / REPL continuation copy | Shipped |
| Structured delegation | “把这个子任务交给子智能体” | `task` / `background_output` / `background_cancel` | Shipped |
| Planning / approval | “先规划”, “进入 plan” | `enter_plan` / `exit_plan` | Shipped |
| Interactive clarification | “需要我回答什么？” | `question` | Shipped |

## What “general assistant” means in practice

0.1.13 keeps kkcode as a terminal-native assistant and pushes `agent` further toward the default bounded-transaction lane. It can also:

- inspect directories, configs, and logs
- summarize repo state and release hygiene
- combine shell execution with codebase reasoning
- keep bounded inspect + patch + verify work in `agent` by default
- continue the same local transaction after an interrupt when the follow-up is still bounded
- surface route reasons so users can see why kkcode stayed local or suggested `longagent`

## Non-goals for this release

These are **not** part of the 0.1.13 public contract:

- IDE integration
- desktop GUI automation
- browser automation as a first-class local surface
- mobile / voice / bridge product surfaces
- marketplace / plugin auto-install / remote plugin distribution
- a LongAgent runtime rewrite

## Routing implications

The capability matrix should influence routing behavior in four specific ways:

- a bounded local task should remain eligible for `ask` or `agent`
- an interrupted bounded task should prefer continuing the same `agent` transaction before re-routing
- a short terminal task should not become LongAgent just because it mentions design, logs, or multiple checks
- LongAgent remains the preferred lane for structured multi-file delivery and staged ownership

## Prompting / assistant behavior contract

When kkcode is acting as a CLI general assistant, it should:

1. prefer direct local completion for small bounded work
2. keep `agent` as the default general execution lane for bounded local transactions
3. avoid over-delegating one-shot terminal actions
4. keep GUI/platform promises explicit and conservative
5. preserve LongAgent for heavyweight delivery rather than flattening everything into one agent surface

## Release checklist

Before shipping 0.1.13, confirm:

- README reflects the CLI general assistant boundary
- prompt/runtime copy says `agent` is the default bounded transaction lane
- prompt/runtime copy does not imply GUI automation support
- route-reason copy, continuation copy, and release docs tell the same story
- tool surface still covers coding + local ops + shell + web + repo + delegation
- routing tests keep heavy multi-file work on LongAgent
