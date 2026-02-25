# NOTICE

This file contains attribution notices and third-party acknowledgments for the kkcode project.

## Project

- **Name**: kkcode
- **Version**: 0.1.6
- **License**: GPL-3.0
- **Copyright**: Copyright (C) 2026 kkcode team
- **Repository**: https://github.com/kkelly-offical/kkcode

---

## Inspirations & Acknowledgments

kkcode 的架构设计受到以下开源项目的启发，在此致谢：

### Claude Code
- **Repository**: https://github.com/anthropics/claude-code
- **License**: Proprietary (Anthropic)
- **Influence**: 工具体系设计（read/write/edit/patch/glob/grep/bash/task）、子智能体架构（explore/reviewer/researcher）、提示词工程模式、权限审批交互流程。

### OpenCode
- **Repository**: https://github.com/nicepkg/opencode
- **License**: MIT
- **Influence**: 多 Provider 抽象层、主题系统、TUI 布局与状态栏设计。

### Everything Claude Code
- **Repository**: https://github.com/affaan-m/everything-claude-code
- **License**: MIT
- **Influence**: Instinct 自动学习机制、Hook Recipes 模式、TDD 工作流集成。

---

## Runtime Dependencies

| Package | License | Usage |
|---------|---------|-------|
| [commander](https://github.com/tj/commander.js) | MIT | CLI 参数解析 |
| [yaml](https://github.com/eemeli/yaml) | ISC | YAML 配置文件解析 |

---

## Supported Model Providers

kkcode 通过标准 API 协议接入以下模型提供商，不包含其模型权重或专有代码：

- **Anthropic** (Claude) — https://www.anthropic.com
- **OpenAI** (GPT) — https://openai.com
- **阿里云 DashScope** (Qwen) — https://dashscope.aliyuncs.com
- **智谱 AI** (GLM) — https://open.bigmodel.cn
- **DeepSeek** — https://platform.deepseek.com
- **Ollama** (本地模型) — https://ollama.com

各提供商的模型名称、API 端点等信息均来自其公开文档。使用时需遵守各提供商的服务条款。
