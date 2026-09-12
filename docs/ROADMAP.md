# Roadmap / 路线图

已知欠账与下一步方向。每条都标注了**当前事实**（可以直接核对的数字或文件），
而不是意向描述 —— 路线图最容易烂掉的方式就是写下一堆无法验证的愿望。

更新于 0.9.2。

---

## 1. 类型守护扩容 / Widen the typecheck

**现状**：`tsconfig.json` 的 `include` 覆盖 130 / 290 个源文件。

0.9.1 之前只有 5 个，typecheck 基本在空转。现在纳入的是「自身干净且传递依赖
也全干净」的闭包 —— 用 `exclude` 排除脏文件是无效的，被白名单文件 import 的
脏文件照样会被检查。

**下一步**：剩下 160 个里有 96 个自身带类型错误（全量开 `checkJs` 报 510 个，
多数是无类型标注 JS 上的 `TS2339` 噪音）。修完一个文件的错误后，把它和它的
下游一并加进 `include`，跑 `npm run typecheck` 确认仍是 0 错误。清单只增不减；
变短就是守护面倒退。

---

## 2. 沙箱执行面覆盖 / Sandbox coverage

**现状**：OS 级沙箱（0.8.1）只接在 `src/tool/registry.mjs` 的 bash 工具上。

`grep` 可核对：`src/mcp/`、`src/skill/`、`src/tool/git-full-auto.mjs` 都没有
引用 `sandbox.mjs`。也就是说 MCP 服务器进程、skill 执行、git 自动化这三个
执行面目前不受沙箱约束。

**下一步**：这三面各有各的形态（MCP 是长驻子进程、skill 可能是任意解释器、
git-auto 需要写 `.git`），不能套用 bash 那套包法。需要先定清楚各自的可写集，
再决定是包住还是显式声明「不包，因为 X」——**沉默地不包是最糟的一种**，用户
会以为 `mode: auto` 覆盖了一切。

另一处已知边界：`network: false` 用独立 netns，会把 localhost 一起断掉。

---

## 3. 大模块拆分 / Splitting the large modules

**现状**（`wc -l`）：

| 模块 | 行数 |
| --- | --- |
| `src/session/longagent-hybrid.mjs` | 2302 |
| `src/tool/registry.mjs` | 2571 |
| `src/repl.mjs` | 2049 |
| `src/session/loop.mjs` | 1355 |

`repl.mjs` 已从 4803 行拆到 2049（0.6.12 起）。

**判断标准**（0.6.12/0.6.14 两轮验证有效，值得沿用）：不看行数，看**大小
具体挡住了什么**。拆帧层的收益是「宽度相关行为第一次可测」，不是行数下降；
而机械拆分状态密集的大函数只会更难维护。`registry.mjs` 是工具清单式结构，
不建议拆。

拆之前先用脚本算目标函数的**自由变量集**，据此决定 deps 形状，避免硬拆成
二十参数的函数。

---

## 4. 跨平台真机验收 / Real-terminal acceptance

**现状**：`scripts/tty-acceptance.sh` + `docs/terminal-acceptance.md` 已固化
Linux 侧链路（这台开发机就是 Ubuntu，不需要虚拟机）。

**缺口**：Windows 与 macOS 两行的鼠标上报、剪贴板权限、IME 候选窗位置无法靠
自动化测试覆盖，也开虚拟机解决不了 —— 需要真机。`docs/terminal-experience-0.3.3.md`
里的手工验收矩阵是待跑清单。

---

## 5. 模型模板复核 / Model template review

**现状**：README 的九家 provider 默认模型表标注了复核日期（0.9.1 复核于
2026-08-06）。

模型目录是外部事实，会在项目没有任何改动的情况下过期。**复核时必须逐家查官方
文档**，不能凭印象改 —— 写错一个模型名是直接坑到用户的那种错误。

**这一轮留下的两笔欠账**：

1. **Zhipu GLM 没核实成**。文档站的模型清单是客户端渲染的，抓不到。GLM 那一行
   仍是 2026-05-27 的状态，README 里已注明。下次复核需要能跑 JS 的抓取方式，
   或者人工过一遍。
2. **`qwen3.7` 模板还没有**。阿里当前是 `qwen3.7-max` / `qwen3.7-plus` /
   `qwen3.6-flash`，而 `configs/config-qwen3.5.yaml` 是 3.5 系列专用模板 ——
   名副其实，所以这轮没有原地改。要跟上得**新增** `config-qwen3.7.yaml`，
   同时把单价补进 `src/usage/pricing.mjs`（这次没拿到阿里的定价页，缺价的模型
   会被标成 unknown 并按 default 估算）。

**价格表和模型名是两件事，都要跟**。`src/usage/pricing.mjs` 直接决定用量与成本
统计：0.9.1 这轮在里面抓到 `gpt-5.3-codex` 被记成 15/60（实际 1.75/14，高 8.6
倍），以及前缀回落取首个匹配导致 `gpt-5.4-mini-*` 串到 `gpt-5.4` 的价上。
两处都修了并有测试（`test/pricing-model-table.test.mjs`）—— 加新模型时连价格
一起加，别只改模型名。

---

## 6. MCP 协议版本升级 / MCP protocol version

**现状**：`src/mcp/constants.mjs` 的 `MCP_PROTOCOL_VERSION` 钉在
`2024-11-05`，`initialize` 请求的 `capabilities` 恒为空对象。
`client-http.mjs` 是项目自定义的 REST adapter，而 registry 目前把配置中的
`streamable-http` 映射到 SSE client；因此它还不是 MCP 规范的正式
Streamable HTTP 实现。可核对：`grep -n "2024-11-05" src/mcp/constants.mjs`
以及 `src/mcp/registry.mjs`的 transport 映射。

协议在这之后已有多轮修订（含 Streamable HTTP 的正式化、能力协商的扩展）。
现状能与主流服务器互通是因为服务器普遍向后兼容 —— 但这层兼容不受我们控制，
新服务器随时可以只接受新版本。

**下一步**：这不是改一个常量的事。升级意味着逐条核对新旧规范的差异
（initialize 握手、能力声明、通知语义、三种传输的帧格式），实现真正的
Streamable HTTP，并对 `client-stdio.mjs` / `client-sse.mjs` / 新 HTTP client
的解析路径做回归。0.9.2 时被评估为独立的兼容性工程，刻意不塞进补丁版本。

---

## 7. 弃用通知真正接入用户界面 / User-visible deprecations

**现状**：`src/core/deprecations.mjs` 已统一把现存兼容别名的移除目标记为
1.0.0，但生产路径没有消费 `onDeprecation()` / `drainDeprecations()`；这些目标
目前仍是内部元数据，不能宣称用户已看到弃用 notice。

**下一步**：CLI 无头模式将 notice 写到 stderr，TUI 以一次性 toast 展示，
两条路径都要有从真实旧配置到用户可见文案的集成测试。

---

## 8. 内核 / SDK 分层架构（1.0.0）/ Kernel & SDK layering

**现状**：仓库没有内核/SDK 分层 —— UI 层 76 个文件直接 import 47 个内核
文件，内核启动序列在 6+ 个入口复制，session/ 内有 8 文件静态循环，9 组
模块级单例。目标分层、`createKernel()` 公开 API 面、Codex / Kimi Code
对照分析、分阶段迁移路线图与回退策略见
[docs/architecture-kernel-sdk-1.0.0.md](architecture-kernel-sdk-1.0.0.md)。

**范围**：1.0.0 只做进程内分层（`src/kernel/`、`src/sdk/` 包内目录边界）；
独立 npm 包拆分（`packages/` workspace）是 1.x 评估项。迁移第一阶段是
不改任何行为的纯边界整理，全程 `npm run lint && npm run typecheck &&
npm test` 保持绿。
