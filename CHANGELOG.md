# Changelog / 更新日志

## 0.3.2

### English

- Discover models from user-configured OpenAI or Anthropic-compatible Base URLs.
- Unify OpenAI and Anthropic gateway endpoints, dynamic wizard/TUI model selection,
  persistent catalog caching, and an opt-in one-token inference probe.
- Add correlated request identity and a redacted, rotating `kk.audit.v1` SHA-256
  audit chain with verify, filter, and export commands.
- Add AI-assisted local branch and GitHub pull-request review, deterministic
  high-risk checks, waiver reasons, idempotent PR publishing, and fail-closed gates.
- Enforce trusted-workspace provider boundaries, HTTPS for credential-bearing
  endpoints, terminal-safe model catalogs, and end-to-end review trace correlation.

### 中文

- 从用户配置的 OpenAI 或 Anthropic 兼容 Base URL 动态发现模型。
- 统一 OpenAI / Anthropic Gateway 端点、向导与 TUI 动态模型选择、持久缓存，
  并提供显式启用的单 token 推理探测。
- 新增可关联请求身份，以及脱敏、轮换的 `kk.audit.v1` SHA-256 审计链，
  支持校验、筛选和导出。
- 新增 AI 辅助的本地分支及 GitHub Pull Request 审查、确定性高风险检查、
  带理由的豁免、幂等 PR 发布与 fail-closed 门禁。
- 对项目级模型出口执行工作区信任隔离，要求携带凭据的端点使用 HTTPS，并加入
  模型目录终端安全校验与审查全链路 trace 关联。

## 0.3.1

### English

- Identify outbound HTTP requests as `KK-Code/0.3.1` and redact credentials in diagnostics.
- Add an official Kimi Code Coding API preset with K3 and Kimi for Coding models.
- Improve terminal transcript, tool lifecycle, cancellation, workspace isolation, and provider reasoning support.
- Keep existing configuration and session data readable without destructive migration.

### 中文

- 将出站 HTTP 请求身份统一为 `KK-Code/0.3.1`，并在诊断输出中脱敏凭据。
- 新增官方 Kimi Code Coding API 预设，提供 K3 与 Kimi for Coding 模型配置。
- 改进终端 Transcript、工具生命周期、任务取消、工作区隔离与模型推理支持。
- 保持旧配置和会话可读，不执行破坏性迁移。
