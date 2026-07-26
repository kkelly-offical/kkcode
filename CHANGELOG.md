# Changelog / 更新日志

## 0.6.6

### English

- **Protected paths, checked before your own allow rules.** Writes to `.git/`,
  `.kkcode/`, `.github/workflows/`, every shell rc (`.bashrc`, `.zshrc`,
  `.envrc`), package-manager configs (`.npmrc`, `.yarnrc`, `bunfig.toml`) and
  `.mcp.json` now always require confirmation — yolo included. These are the
  one class of change git cannot undo for you: break `.git` and the snapshot
  system that would have saved you is gone with it.
  The ordering is the security property. The check runs *before* `permission.
  rules` is evaluated, so a checked-in `{tool: "write", pattern: ".git/**",
  action: "allow"}` cannot switch it off — and that rule might have arrived in
  a repository you just cloned. `bash` is covered too, by scanning commands
  that look like writes; `cat ~/.bashrc` and `.gitignore` are deliberately not
  caught.
- **Long-running commands can finally go to the background.** The foreground
  block told the model "or use `run_in_background: true`" — and the background
  branch blocked the same commands again. The one escape hatch the tool
  documented did not exist. Now background accepts them, which is what
  background is for.
- **Thirteen git tools were unregistered, not restricted.** `TOOL_CAPABILITIES`
  covered 24 tools; every `git_*` tool, `task_group` and `task_parallel` fell
  through to `"unknown"`, which readonly denies wholesale and accept-edits asks
  about wholesale. `git_status` was denied in the readonly tier while
  `TRUSTED_BASH_PATTERNS` and exec-policy's `allow_git_status` both called it
  safe — three layers disagreeing about the same command. Read-only shell is
  now allowed in the readonly tier, which is what "readonly" should have meant.
- **`/plan` had no execution-layer gate.** It set `state.mode = "plan"` and
  injected a "do not edit source files" instruction, but the gate keyed off
  `_planMode`, which only the model's own `enter_plan` call ever set. Plan mode's
  entire binding force was the model choosing to comply. The gate now derives
  from the declared mode, and from tool capability rather than a hand-written
  list — that list had been missing `sysinfo`, `question`, `task_list` and
  `git_status`, all pure reads, blocked precisely when you are surveying a
  repository to plan against it.
- **`sensitive_file_patterns` merges instead of replacing.** Adding one pattern
  to protect `secrets/**` used to delete the protection for `.env` and five
  others, silently. Wanting one more should not cost you six. Pass
  `sensitive_file_patterns_replace: true` to actually drop the defaults.
  Both this and `skills.allowed_commands` were absent from
  `docs/config.example.yaml`; both are documented now.
- **`bash` reports exit codes and accepts `cwd` and `env`.** The exit code was
  swallowed by the catch block, so the model could not tell a failed command
  from one that succeeded while writing progress to stderr — which npm, pip and
  git all do. `cwd` is resolved through the workspace boundary, so `cwd: "../.."`
  cannot relocate the root that every later path check depends on. A third
  hard-coded output cap (30000 chars, missed in 0.6.4) now follows the model's
  context budget and says how to get the rest.
- **`git_apply_patch` checks the diff's target paths.** `git apply` refuses
  `.git/**` and `../` escapes on its own — verified, not assumed — but it will
  happily create a repo-local `.bashrc` or `.github/workflows/ci.yml`, and this
  tool never passes a path through `evaluatePermission`, so the protected-path
  list could not see them. One diff was enough to install a pre-commit hook.

### 中文

- **保护路径清单，且排在你自己的 allow 规则之前。** `.git/`、`.kkcode/`、
  `.github/workflows/`、全套 shell rc（`.bashrc`/`.zshrc`/`.envrc`）、包管理器
  配置（`.npmrc`/`.yarnrc`/`bunfig.toml`）、`.mcp.json` 的写入一律需要确认，
  yolo 也不例外。这是唯一一类 git 帮不了你的改动 —— `.git` 被改坏，本该救你的
  快照系统跟着一起没了。
  **顺序本身就是安全属性**：检查排在 `permission.rules` 求值之前，所以仓库里
  checked-in 的一条 `{tool: "write", pattern: ".git/**", action: "allow"}`
  关不掉它 —— 而那条规则可能来自你刚 clone 的别人的仓库。`bash` 同样覆盖，
  按"像在写"的命令特征扫描；`cat ~/.bashrc` 与 `.gitignore` 有意不拦。
- **长命令终于能进后台了。** 前台拦截的提示原文是「或者用
  `run_in_background: true`」，而后台分支把同一批命令又拦了一遍 —— 工具文档
  承诺的唯一逃生口在代码里不存在。现在后台接收它们，后台本来就是干这个的。
- **十三个 git 工具是漏登记，不是被限制。** `TOOL_CAPABILITIES` 只覆盖 24 个
  工具，全部 `git_*`、`task_group`、`task_parallel` 落到 `"unknown"` ——
  只读档一律拒、接受编辑档一律问。`git status` 在只读档被拒，而
  `TRUSTED_BASH_PATTERNS` 与 exec-policy 的 `allow_git_status` 都判它安全，
  三层对同一条命令的判定互相矛盾。现在只读 shell 在只读档放行，这才是
  「只读」该有的意思。
- **`/plan` 在执行层没有闸门。** 它设了 `state.mode = "plan"` 并注入一段
  「请勿修改源文件」的提示，但闸门认的是 `_planMode`，而那个只有模型自愿调
  `enter_plan` 才会被设 —— plan 模式的全部约束力来自模型听不听话。现在闸门
  从声明的 mode 推导，判定依据从手写名单改为工具能力：那份名单漏了
  `sysinfo`、`question`、`task_list`、`git_status`，全是纯读，偏偏在你勘察
  仓库准备制定计划时被拦。
- **`sensitive_file_patterns` 改为合并而非替换。** 此前为了保护 `secrets/**`
  加一条模式，会静默删掉 `.env` 等六条内置保护 —— 想加一条不该赔上六条。
  真要丢掉默认值，写 `sensitive_file_patterns_replace: true`。这一项与
  `skills.allowed_commands` 都从未出现在 `docs/config.example.yaml` 里，
  现在都补上了。
- **`bash` 上报 exit code，并支持 `cwd` 与 `env`。** exit code 此前被 catch
  整个吞掉，模型无法区分「命令失败」与「命令成功但往 stderr 写了进度」——
  后者在 npm、pip、git 里天天发生。`cwd` 过工作区边界解析，`cwd: "../.."`
  不能把后续所有路径判定所依赖的根挪走。第三处硬编码输出上限（30000 字符，
  0.6.4 漏掉的）改为跟随模型上下文预算，并说明怎么取剩下的部分。
- **`git_apply_patch` 检查 diff 的目标路径。** `git apply` 自己会拒
  `.git/**` 与 `../` 逃逸 —— 这是实测确认的，不是假设 —— 但它照样会凭空创建
  仓库内的 `.bashrc` 或 `.github/workflows/ci.yml`，而本工具从不带路径走
  `evaluatePermission`，保护清单看不到它们。一个 diff 就足够装上 pre-commit 钩子。

**关于计划的两处修正**：0.7.0 计划里写 `git_restore` 绕过路径校验 —— 它只吃
`snapshot_id`，没有路径入参，没有可校验的东西，这条不成立。另一条写
`git_apply_patch` 绕过路径校验，实测后发现只对了一半：路径遍历与 `.git` 写入
是 `git apply` 自己拦住的，真正漏的是仓库内的受保护文件。

## 0.6.5

### English

- **`multiedit` was silently dropping changes.** Every change computed its
  result from `snapshot.original` — the content as it was *before* the batch —
  so when the same file appeared twice, the second change overwrote the first.
  The tool reported `2 file(s) updated atomically` and produced two diffs that
  both claimed success, while only half the edit reached disk. That is the
  hardest kind of data loss to notice: nothing fails.
  Changes now accumulate through a working copy. If a later change's anchor was
  removed by an earlier one in the same batch — which the pre-flight check
  cannot see, since it validates against the original content — the whole batch
  rolls back and says so, rather than producing a half-applied file.
- **`edit` explains itself when it finds nothing.** It used to return two words:
  `no match`. The only move left to the model was re-reading the whole file and
  guessing again — the most expensive self-correction path there is. It now
  reports the file length, your snippet's size, the similarity of the closest
  block with its line number, that block with line numbers, and the surrounding
  window. When the difference is only whitespace it says so outright, which is
  the most common cause by far.
  Matching stays exact. A proportion guard is in place for the day loose
  matching arrives, because the dangerous failure there is not "no match" —
  which errors and can be recovered — but matching a much larger span and
  swallowing it silently.

**Note on 0.6.4:** the edit diagnosis code shipped in 0.6.4 without being
mentioned in its changelog. A background release ran `git add -A` while this
work was still in progress, so the commit captured it. It passed all six checks
on every platform, but its tests only arrive here — a release should contain
what its changelog says it contains, and that one did not.

### 中文

- **`multiedit` 在静默丢改动。** 每个 change 都从 `snapshot.original`（批次
  **之前**的内容）算起，于是同一文件出现两次时，第二个 change 覆盖掉第一个。
  工具报告 `2 file(s) updated atomically` 并给出两份都声称成功的 diff，而磁盘
  上只落了一半 —— 这是最难发现的一类数据丢失：什么都没有失败。
  改动现在通过一份工作副本逐个叠加。若后一个 change 的锚点已被同批次的前一个
  改掉（预检基于原始内容，看不到这种批次内相互作用），整批回滚并明说原因，
  而不是产出一个改了一半的文件。
- **`edit` 找不到时会解释自己。** 它此前只返回两个词 `no match`，模型唯一能做
  的是重读整个文件再猜一次 —— 最贵的自我纠正路径。现在给出文件行数、你的片段
  规模、最接近块的相似度与起始行号、带行号的该块、以及周边窗口。差异只在空白
  时直接说出来 —— 那是最常见的失配原因。
  匹配仍然是精确的。不成比例守卫已就位，为将来引入宽松匹配预备：那时危险的
  失败不是「匹配不到」（会报错、可恢复），而是匹配到一个大得多的块然后静默
  吞掉它。

**关于 0.6.4：** 编辑诊断的代码随 0.6.4 发布了，但没写进它的更新日志 ——
后台发布任务的 `git add -A` 在这项工作还没完成时把它收走了。它在六个平台的
检查全都通过，但测试直到这一版才补上。一个版本应当包含它的更新日志所说的内容，
那一版没做到。

## 0.6.4

### English

- **Tool output was capped at 3000 characters, and truncation was silent.** A
  268-line source file is 12494 characters, so the model saw a quarter of any
  ordinary file — and read's 2000-line limit had never once taken effect,
  because the real ceiling was 1/25 of it. Against peers that is one to two
  orders of magnitude low: opencode caps at 50 KB, Codex at 1 MiB of shell
  output, Claude Code at roughly 100 KB.
  The budget now derives from the active model's context window instead of a
  frozen number: k3 gets 35840 characters, gpt-5 76160, a 64K model 17920.
  Floor 16000 so reading one ordinary file always fits; ceiling 200000 so one
  call cannot dominate the context and drag compaction forward.
  This is not "remove the limits" — a line cap is what every peer does and it
  is deliberate; Anthropic's own guidance is that truncation should steer the
  agent toward more targeted retrieval. What was missing is that ours never
  said so.
- **Every read now reports its own state**: `[complete: 340 lines]`, or
  `[truncated: showing 2000 of 3000 lines, 1000 remaining. Use read with
  offset=2001 to continue.]`. Silence was the worse half: a read of a 3000-line
  file stopped dead at line 2000 with no footer, so a quarter of a file passed
  for the whole thing — and it was separately marked a partial view, which then
  failed the model's later write for a reason it could not see.
- read also gains a 50 KB byte cap (line and per-line caps cannot stop a
  minified file), a size check before loading (nothing stopped a 2 GB file from
  going straight into memory), binary detection (a `.so` read as UTF-8 filled
  the context with replacement characters), and an error instead of a silent
  empty string for an out-of-range offset. The read-state cache now stores what
  the model actually saw rather than the untruncated original — that mismatch
  made edits against a truncated line fail with no way to work out why.
- **`BUILTIN_CONTEXT` gains the kimi family.** `k3` was falling through to the
  128000 default when it is a 1M model, so compaction fired eight times too
  early. Long prefixes are now ordered ahead of short ones, since the lookup
  walks in declaration order and `k3` would otherwise swallow `k3-256k`.

### 中文

- **工具输出被砍到 3000 字符，而且截断不发声。** 一个 268 行的源文件有 12494
  字符，模型只能看到普通文件的四分之一 —— 而 read 那个 2000 行的上限**从未
  生效过**，真正的天花板是它的 1/25。对比同行低了一到两个数量级：opencode
  50KB、Codex 1MiB shell 输出、Claude Code 约 100KB。
  预算现在按当前模型的上下文推算而非写死：k3 得 35840 字符、gpt-5 得 76160、
  64K 模型得 17920。下限 16000 保证读一个普通文件总能读全；上限 200000 防止
  单次调用主导上下文、把压缩提前拖来。
  这不是「取消上限」—— 行数上限是同行共识且刻意为之，Anthropic 自己的指导是
  截断应当把 agent 引向更精确的检索。我们缺的从来是「说出来」。
- **每次读取都自报状态**：`[complete: 340 lines]`，或 `[truncated: showing
  2000 of 3000 lines, 1000 remaining. Use read with offset=2001 to continue.]`。
  沉默是这个缺陷更糟的那一半：读 3000 行的文件在第 2000 行戛然而止、没有任何
  footer，四分之一就当成了全文 —— 而且它还被单独标记成部分读取，导致模型后续
  的写入失败，且它看不出原因。
- read 另补：50KB 字节帽（行数与单行上限都拦不住 minified 文件）、加载前的
  大小预检（此前没有任何东西阻止一个 2GB 文件直接进内存）、二进制探测（`.so`
  按 UTF-8 读会用替换字符填满上下文）、越界 offset 改为报错而非静默返回空串。
  读状态缓存现在存模型实际看到的内容而非未截断原文 —— 这个错位让「照着被截断
  的行去编辑」必然失败，且无从判断原因。
- **`BUILTIN_CONTEXT` 补上 kimi 族。** `k3` 此前落到 128000 默认值，而它是 1M
  模型 —— 压缩因此提前八倍触发。长前缀现在排在短前缀之前，因为查表按声明序
  遍历，否则 `k3` 会把 `k3-256k` 吃掉。

## 0.6.3

0.6.2 claimed to fix YOLO refusing commands. It did not — the fix landed in the
function and never reached the call sites. This release actually wires it, and
adds a check so this particular failure shape stops recurring.

### English

- **`checkBashAllowed` now receives the approval level at its call site.** The
  parameter was added in 0.6.2 but `src/tool/registry.mjs` still called it with
  two arguments, so the internal check read `undefined` and every tier behaved
  like the strictest one. The tests passed because they called the function
  directly and supplied the level themselves — the exact blind spot the fix was
  supposed to close.
  A new end-to-end assertion exercises the bash tool rather than the function,
  which is the only way to prove that turning on YOLO actually lets a commit
  through.
- **`write_scope: read-only` blocks `bash`.** The 0.6.2 check tested
  `["write","edit"].includes(capability)`, and `toolCapability` never returns
  `"write"` — half the condition was dead, and the half that worked missed the
  hole that mattered: bash reports as `risky-shell`, so a read-only subagent
  could still reshape the workspace through a shell. It now asks whether the
  call can mutate the workspace at all, defaulting to yes for anything not
  explicitly known to be read-only, with bash judged per command against the
  existing trusted-read-only patterns.
- **`test/wiring-contract.test.mjs`** scans for this failure shape: a security
  parameter that exists in a signature but is missing at a call site, and a
  comparison against a capability string the producing function can never
  return. Four defects in this repository have had exactly that shape
  (`setTrusted` in the background worker, and both of the above). Verified by
  reverting the fix and watching the check go red. Deliberate omissions are
  exempted by stating the reason next to the call — the criterion verifier
  omits the approval level on purpose, since a criterion that commits is a bad
  criterion regardless of which tier the user selected.

### 中文

- **`checkBashAllowed` 在调用点终于收到了审批档。** 这个参数是 0.6.2 加的，
  但 `src/tool/registry.mjs` 仍以两个实参调用，函数内部读到 `undefined`，
  于是任何档位都等同于最严格档。测试之所以全绿，是因为它们直接调函数并自己
  传档 —— 正是这个修复本该堵上的那个盲区。
  新增的端到端断言从 bash 工具而非函数出发，那是唯一能证明「用户开了 YOLO
  真的能提交」的方式。
- **`write_scope: read-only` 现在拦得住 `bash`。** 0.6.2 那版判的是
  `["write","edit"].includes(capability)`，而 `toolCapability` 从不返回
  `"write"` —— 一半条件是死值，能工作的另一半又恰好漏掉了真正要紧的口子：
  bash 的能力是 `risky-shell`，只读子智能体照样能用 shell 改工作区。现在改问
  「这次调用是否可能改动工作区」，未明确登记为只读的一律视为可能，bash 按命令
  对照既有的可信只读白名单单独判定。
- **`test/wiring-contract.test.mjs`** 专扫这一类缺陷形状：签名里有、调用点没传
  的安全参数；以及与一个永远不会被返回的能力名做比较。本仓库已有四个缺陷是这个
  形状（后台 worker 的 `setTrusted`，以及上面两条）。已用「撤销修复看它变红」
  反向验证。有意不传的情形在调用点旁写明理由即可豁免 —— 判据校验器就是有意不传，
  因为一条会提交的验收判据本身就是错的，与用户选了哪一档无关。

## 0.6.2

### English

- **YOLO was still refusing commands.** `checkBashAllowed` never looked at the
  approval level — it read only `config.git_auto` — so a mode documented as
  "every approval prompt is skipped" still denied `git commit` and `git push`.
  The level is passed in now and YOLO relaxes the `git_safety` category.
  It does not relax everything, and that distinction is the point: `rm -rf /`,
  writing to a device, formatting a filesystem, piping a download into a shell
  and privilege escalation stay forbidden at every tier. YOLO means "don't
  interrupt me", not "you may format the disk". Refusals now say which class
  they belong to, so you can tell a config flip from a genuine no.
- Writing that test exposed a real hole: the `mkfs` rule matched the bare token
  while what people actually run is `mkfs.ext4` / `mkfs.xfs`. Every variant
  slipped past. Now covered, along with `mke2fs` and the partitioners.
- **Thinking is visible while it happens** — a fixed two-line grey tail of the
  reasoning stream instead of a lone `Thinking · 5.1s`. Two lines is a hard
  constraint, not a taste call: the frame bills rows by their actual count, so
  a block that grows would make the transcript jitter with every token.
- **Writes read like a file, not a diff.** New files render with line numbers
  and syntax highlighting rather than `+` prefixes — a write is "this is what
  the file now is", and line numbers let you say "change line 57" while looking
  at the screen.
- **Thinking effort has four tiers** (low/medium/high/max, plus off), expressed
  as a proportion of the model's own output budget. Anthropic's `budget_tokens`
  was hardcoded at 10000: too timid for a 200K-context model, potentially over
  a small model's output ceiling. Model discovery reads max output tokens and
  declared capabilities from the catalog and writes them into the provider
  config, so switching models changes no numbers — the config states intent.
- **`Esc` `Esc` rewinds one conversation turn.** Said it wrong, or the model
  went sideways: back up and retry instead of pushing forward through context
  that already drifted. The withdrawn prompt returns to the composer so
  "rewind, tweak, ask again" is one step. It rewinds the conversation only —
  file changes remain, and `/undo` handles those; unwinding a sentence is
  cheap, unwinding a batch of edits is not, and one gesture should not do both.
  Two message shapes wear the `user` role without being user speech —
  compaction summaries and tool results — and treating either as a turn
  boundary would rewind half a turn or discard compacted history.
- `Ctrl+O` toggles the latest collapsed block alongside `Ctrl+E` and clicking.

### 中文

- **YOLO 档下命令仍被拒。** `checkBashAllowed` 从不看审批档，只读
  `config.git_auto` —— 于是一个说明写着「每个审批提示都跳过」的模式，
  照样拒绝 `git commit` 与 `git push`。现在传入审批档，YOLO 放开 `git_safety`。
  但不是全部放开，这个区分正是重点：清空根目录、写裸设备、格式化文件系统、
  把下载管道进 shell、提权，在任何档位都禁止。YOLO 的含义是「不要打断我」，
  不是「可以格盘」。拒绝理由会说清属于哪一类，你才知道这是改个配置就行，
  还是我们真的不做。
- 写这条测试时发现一个真实漏洞：`mkfs` 规则匹配的是裸 token，而实际用的是
  `mkfs.ext4` / `mkfs.xfs` —— 所有变体全部溜过去了。现已覆盖，连同 `mke2fs`
  与分区工具。
- **思考过程可见** —— 固定两行灰字显示推理流的尾部，取代孤零零的
  `Thinking · 5.1s`。两行是硬约束而非审美取舍：帧按块的实际行数计费，
  会变高的块会让对话区随每个 token 抖动。
- **写入读起来像文件，不像 diff。** 新建文件带行号与语法高亮，而不是 `+`
  前缀 —— 写入是「文件现在就长这样」，行号让你能对着屏幕说「第 57 行改一下」。
- **思考强度分四档**（low/medium/high/max 与 off），表达为模型自身输出预算的
  比例。Anthropic 的 `budget_tokens` 此前硬编码 10000：对 200K 上下文的模型
  太保守，对小模型又可能超出它的输出上限。模型发现会从目录读出输出上限与
  声明的能力并写回 provider 配置，于是换模型不用改任何数字 —— 配置里写的是意图。
- **连按两下 `Esc` 回溯一轮对话。** 说错了、或模型跑偏了：退回去重来，而不是
  在一段已经歪掉的上下文里继续往前顶。撤回的那句会填回输入框，「退回去改一下
  再问」是一步。只回溯对话 —— 文件改动保留，由 `/undo` 负责；退一句话很轻，
  退一批改动不轻，一个手势不该同时做两件事。有两类消息挂着 `user` 角色却不是
  用户说的话（压缩摘要与工具结果），把它们当轮次边界会退半轮或丢掉压缩历史。
- `Ctrl+O` 与 `Ctrl+E`、鼠标点击并列，都能展开最近的折叠块。

## 0.6.1

Fixes a 0.6.0 regression found by running kkcode in an actual terminal on a
Linux desktop — the first time this release had been looked at rather than
asserted about.

### English

- **The status bar dropped `PERMISSION` to make room for a token count.**
  0.6.0 added absolute tokens to the context badge (`CONTEXT 20.2K (2%)`),
  about six characters wider. At 110 columns that pushed the rightmost segment
  past the edge, and the terminal clipped it — so the badge telling you whether
  the agent can edit files without asking was the one sacrificed for a
  decorative number. At 86 columns the bar had already been overflowing before
  0.6.0.
  Segments now carry a priority and the bar drops the least important ones
  until it fits, instead of being concatenated and cut from the right in an
  order that was historical rather than meaningful. Mode and permission are
  never dropped; context survives down to 70 columns; cost, token counters and
  the memory flag go first. Verified in a real 88-column xterm.
- `renderStatusBar`'s width tiers had never been tested — it reads
  `process.stdout.columns` directly, which is undefined in a test process, so
  every assertion silently exercised the widest layout. The new tests fake the
  column count and assert the bar fits at 70/86/100/110/120/160.
- `scripts/tty-acceptance.sh`: the harness used to find this. Xvfb plus a
  window manager, a real terminal emulator, synthetic input and screenshots —
  enough to check what unit tests structurally cannot.

### 中文

- **状态栏为了给 token 数腾地方，丢掉了 `PERMISSION`。** 0.6.0 给上下文徽章
  加了绝对 token 数（`CONTEXT 20.2K (2%)`），宽了约六个字符。110 列时最右边的
  段被挤出边界、被终端硬切 —— 于是「agent 能不能不问就改文件」这个信号，为一个
  装饰性的数字让了位。而 86 列下整条状态栏在 0.6.0 之前就已经溢出。
  现在每个段带优先级，装不下时从最不重要的开始丢，而不是拼接后从右边切
  （那个顺序是历史形成的，与重要性无关）。模式与权限永不丢弃，上下文一直保留到
  70 列，成本、token 计数与内存标记最先让路。已在真实的 88 列 xterm 中验证。
- `renderStatusBar` 的宽度分档从来没被测过 —— 它直读 `process.stdout.columns`，
  测试进程里恒为 undefined，所以此前所有断言走的都是最宽的那套布局。新测试伪造
  列数，断言 70/86/100/110/120/160 各档都装得下。
- `scripts/tty-acceptance.sh`：找出这个问题的工具。Xvfb 加窗口管理器、真实终端
  模拟器、合成输入与截图 —— 足以检查单元测试在结构上就检查不到的东西。

## 0.6.0

A release about the layer you actually look at: what the terminal shows, what
subagents are doing, whether anyone asked you before starting, and whether the
context window manages itself. Most of the capability was already in the tree —
unwired, duplicated, or silent when it failed.

### English

**Subagents you can control and see.** The tools allowlist is enforced where
tools execute, not just where the list is advertised to the model; `write_scope`
blocks mutating tools instead of being prose in a prompt; `budget_usd` and
`deadline_at` abort a delegation instead of being fields nothing reads. Config
overrides merge with the registry definition rather than replacing it — setting
`agent.subagents.explore.model` used to drop explore's readonly tier and its
allowlist with it. An unknown `subagent_type` now reports the available types
instead of quietly falling back to a full-permission agent. `maxTurns`,
`temperature` and `model: "inherit"` all reach their destinations for the first
time, and `agent.prompt` is read on the production path (`buildSystemPrompt`
looked the agent up by name; the function honouring an inline prompt was only
reachable from dead code the tests happened to cover). Ultra stage tasks carry
a runSpec, so a declared subagent keeps its permission tier in parallel stages.
Delegations emit start/finish events on the parent session, `/agents` and
`/tasks` bring the CLI surface into the REPL, and delegated replies come back
as text with a metadata footer rather than JSON truncated mid-escape.

**It asks before it starts.** `planner.intake_questions` never asked anyone
anything: its prompt tells the model to answer every question with its own best
assumption. Intake now separates what it can settle from the codebase from what
genuinely belongs to the user, and routes the latter through a real prompt that
borrows its shape from the blocked-decision flow — probe for a handler at the
moment of asking, never read an empty answer as a choice, fall back to a stated
assumption with an explicit reason. Plan mode gets a Phase 1.5 that clarifies
before designing rather than after. Dead config settled: `intake_questions.
enabled` is wired, `ask_user_after_plan_frozen` finally does something, and
`intake_user_confirm` is promoted out of hiding.

**The context window manages itself.** Model discovery keeps the context length
providers already report and merges it into `provider.model_context` (explicit
config always wins); startup refreshes the catalog asynchronously. Compaction
keys on 85% utilization — the old 50-message OR threshold fired first in nearly
every long session, which made the ratio knob dead — and reports through a
toast instead of interrupting. `modelContextLimit` follows the active provider;
it read `provider.default`, which `/provider` never changes, so switching
channels mid-session skewed the limit, the status bar and the compaction
trigger together. The status bar shows absolute tokens beside the percentage,
and headless chat finally passes its context meter through.

**Terminal experience.** Four hand-drawn pickers became one overlay component —
which surfaced a defect all four shared: item rows were one character narrower
than their borders, so every box had a ragged right edge. Frame accounting now
derives from the block list instead of a parallel hand-written sum, so adding a
UI block can no longer silently miscount the transcript height. Command output
declares its channel explicitly (`/help`, `/status`, `/board`, `/agents`,
`/tasks` collapse into expandable panels instead of flooding the transcript);
the previous mechanism sniffed message text for four English verbs, so any
Chinese or multi-line output leaked into the conversation. Toasts now trigger
their own repaint — nothing subscribed to expiry, so an idle toast lingered
until the next keypress. Eight commands that were dispatchable but missing from
completion are listed, with a test that compares the two lists.

**Colors and syntax highlighting.** Markdown's palette follows the theme
instead of being a hardcoded constant; bold, italic, strikethrough, heading
levels and horizontal rules all had no color at all. User and assistant text
take their color from `theme.roles` — `item.kind` was a first-class field the
renderer never read. Fenced code blocks are syntax-highlighted across ~17
languages plus diff, line by line with no cross-line state (the stream renderer
guarantees output cannot depend on chunk boundaries) and adding only SGR
sequences, so stripping color returns the source byte for byte.

**Breaking: the 0.4.0 permission vocabulary is gone.** `permission.mode`,
`permission.default_policy` and the legacy level names (`review`, `auto`,
`edit`, `full-auto`) are now rejected rather than mapped. They are rejected
rather than ignored on purpose: a permission tier decides which tools run
without asking, and silently falling back to a default would leave someone
believing they are still locked down while they may in fact be looser. Each
error names the exact replacement, so migrating is a one-line edit —
`mode` → `level`, `default_policy: allow` → `level: accept-edits`,
`review`/`auto` → `manual`, `edit`/`full-auto` → `accept-edits`. At runtime a
legacy value that bypasses validation resolves to the default tier, never the
wider tier it used to mean. `kkcode init` was still generating
`default_policy` — a config the tool would then refuse to load.

**Internals.** The streaming and non-streaming provider paths share one
preparation step instead of each carrying a copy of settings resolution,
outbound checks, credential checks and telemetry — a security check adjusted in
one copy and not the other would have failed silently. Seven self-contained
helpers move out of `longagent-hybrid.mjs`; they were only reachable by running
a whole Ultra pipeline, so they were effectively untested, and writing their
first direct assertions corrected three wrong assumptions about their
contracts. The orchestrator function itself is untouched — splitting it needs
the run-context extraction first.

### 中文

**子智能体可控、可见。** 工具白名单在执行处强制，而不只是过滤给模型看的清单；
`write_scope` 真的拦截写工具，不再只是提示词里的一句话；`budget_usd` 与
`deadline_at` 会中止委派，不再是无人读取的字段。配置覆盖与注册表定义**合并**
而非替换 —— 此前只改一个 model 会连带丢掉 explore 的只读档与白名单。未知的
`subagent_type` 会报出可用类型，不再静默回落成全权 agent。`maxTurns`、
`temperature`、`model: "inherit"` 首次真正生效；`agent.prompt` 接上生产路径
（此前测试覆盖的是一条无人调用的死路径）。Ultra 阶段任务带上 runSpec，声明的
子智能体在并行阶段保住自己的权限档。委派会在父会话发出起止事件，`/agents`
与 `/tasks` 把 CLI 能力带进 REPL，委派结果以正文加元数据返回，不再是被从中间
截断的 JSON。

**开工前会问你。** `planner.intake_questions` 从不问任何人 —— 它的提示词要求
模型对每个问题「给出自己的最佳假设」。现在 intake 区分「能从代码里查到的」与
「只有你能定的」，后者走真实提问，收口语义沿用受阻交互那套成熟做法：提问那一
刻探测、空答案绝不当成选择、回落到明示的假设并记录原因。plan 模式新增
Phase 1.5，先澄清后设计。死配置一并清理。

**上下文自己管好。** 模型发现保留 provider 已经返回的上下文长度并合并进
`provider.model_context`（手工配置优先）；启动异步刷新目录。压缩以 85% 占用为
判据 —— 旧的 50 条消息 OR 阈值在长会话里几乎总是先撞线，让比例形同虚设 ——
并以提示条告知而不打断。`modelContextLimit` 跟随当前 provider：它此前读的是
配置默认值，而 `/provider` 切换从不改那个键。状态栏显示绝对 token 数，headless
也终于能看到上下文占用。

**终端体验。** 四个手绘选单合并为一个浮层组件，并暴露出它们共有的缺陷：项目行
比边框窄一个字符，方框右边缘一直是参差的。帧的行数记账改为由块列表推导，新增
UI 块不再可能算错对话区高度。命令输出显式声明通道（`/help`、`/status`、
`/board`、`/agents`、`/tasks` 折叠成可展开面板，不再灌进对话记录）—— 此前靠
嗅探四个英文动词，中文与多行输出一律漏网。提示条到期会自己触发重绘。八个能
执行却不在补全里的命令已补齐，并有测试比对两份清单。

**配色与语法高亮。** markdown 配色跟随主题；粗体、斜体、删除线、标题层级、
水平线此前完全没有颜色。用户与模型文本取自 `theme.roles`。围栏代码块支持
约 17 种语言加 diff 的语法高亮，逐行独立、只加颜色不改字符 —— 去掉颜色能逐字
还原源码。

**破坏性变更：0.4.0 的旧权限词汇已移除。** `permission.mode`、
`permission.default_policy` 与旧等级名（`review`、`auto`、`edit`、`full-auto`）
不再被映射，而是**报错**。选择报错而非静默忽略是有意的：权限档决定哪些工具
不经确认就能跑，悄悄回落到默认值会让人以为自己还锁着、实际可能更松。报错会
指出确切的新写法，改一行即可 —— `mode` → `level`，`default_policy: allow` →
`level: accept-edits`，`review`/`auto` → `manual`，`edit`/`full-auto` →
`accept-edits`。运行时若有旧值绕过校验，回落到默认档，绝不解析成它当年那个
更宽松的档位。`kkcode init` 此前仍在生成 `default_policy` —— 一份 kkcode
自己会拒绝加载的配置。

**内部。** provider 的流式与非流式路径共用同一段准备逻辑，不再各自持有一份
设置解析、出网校验、凭据校验与遥测 —— 只改其中一份的安全校验不会有任何报错。
七个自包含的辅助函数从 `longagent-hybrid.mjs` 抽出：它们此前只能靠跑完整条
Ultra 流水线间接覆盖，等于基本没被测过；补上第一批直接断言时纠正了我对它们
契约的三处误解。编排主体本身未动 —— 拆它需要先做 run context 抽取。

## 0.5.8

Every background subagent had been unable to use tools. This is the first
slice of the 0.6.0 work, shipped early because the defect is live.

### English

- **Background workers could not use any tool.** The worker is a separate
  process entry point, but it never called `PermissionEngine.setTrusted()` —
  and the engine's first line refuses every check when its module-level trust
  flag is false, which is its default. So each tool call raised
  `workspace not trusted`, the loop swallowed it as a tool error, the subagent
  answered from text alone, and the task was still recorded as `completed`.
  This affected every `task(run_in_background: true)` delegation and every
  parallel Ultra stage task. The same two-layer trap was fixed for
  `ultra start/resume` in 0.5.0; that fix reached the CLI entry point and
  missed this one.
  The regression test now makes the mock provider issue a real `write` call
  and asserts the file lands on disk — the previous end-to-end test only ever
  returned plain text, which is why a completely broken tool path stayed green
  through four releases. Verified by reverting the fix: the file is absent.
- Permission denials join the silent-error patterns, so a subagent that can
  only talk is reported as failed rather than completed.
- `paint()` gains an explicit color switch (`setColorEnabled`). It read
  `process.stdout.isTTY` directly, so in a test process it always returned
  plain text — meaning **color regressions were invisible to CI**: structural
  breakage turned red, wrong colors never did. Markdown's hand-written
  strikethrough now follows the same switch instead of testing the environment
  on its own.

### 中文

- **后台子智能体的工具调用全都是坏的。** worker 是独立进程入口，却从不调用
  `PermissionEngine.setTrusted()`，而权限引擎第一行就在模块级信任标志为假时
  拒绝一切检查（默认正是假）。于是每次工具调用都抛 `workspace not trusted`，
  被会话循环吞成 tool error，子智能体只能凭文本作答，任务却照样记为
  `completed`。影响每一个 `task(run_in_background: true)` 委派与全部 Ultra
  并行阶段任务。同样的两层陷阱 0.5.0 为 `ultra start/resume` 修过一次 ——
  那次补上了 CLI 入口，漏了这个。
  回归测试现在让 mock provider 发出一次真实的 `write` 调用并断言产物落盘 ——
  此前的端到端测试永远只回纯文本，所以一条完全断掉的工具链路绿了四个版本。
  已用「撤销修复」反向验证：产物确实不存在。
- 权限拒绝加入静默错误模式表，只会说话的子智能体今后报失败而不是完成。
- `paint()` 增加显式上色开关（`setColorEnabled`）。它原先直读
  `process.stdout.isTTY`，测试进程里恒返回原文 —— 意味着**配色回归在 CI 中
  完全不可见**：结构坏了会红，颜色错了不会。markdown 里手写的删除线也改为
  跟随同一个开关，不再自行判断环境。

## 0.5.7

Works through the CodeQL backlog. Three real findings fixed, seven false
positives dismissed with reasons — and the most interesting defect was one
CodeQL did not report.

### English

- **A project config file could replace the merged config's prototype.**
  YAML and JSON both turn `__proto__:` into an own enumerable property, so the
  deep merge's `out[key] = ...` hit the prototype setter instead of writing a
  key. A `.kkcode/config.yaml` in any repository you opened could therefore
  make keys absent from the defaults resolve to attacker-supplied values —
  invisibly, since they never appear as own properties and `JSON.stringify`
  does not show them. The schema does not reject unknown top-level keys, so
  nothing stopped it earlier in the chain. Global `Object.prototype` was never
  affected. Four byte-identical copies of that merge function (config loading,
  config import, the REPL, theme loading) are now one implementation in
  `src/config/merge.mjs` that skips `__proto__`, `constructor` and `prototype`
  — the same key set `config set` has guarded since 0.3.x.
- Registry lookups encode the package name with `replaceAll` instead of
  `replace`, which substitutes only the first match.
- `verify.yml` declares `permissions: contents: read`; a test matrix that runs
  third-party dependency code has no business holding the default token scope.
- Dismissed as false positives, with reasons recorded on each alert: the
  "clear-text logging" pair (both print the *name* of an api-key env var and
  a set/missing flag, never a key), the "weak password hash" pair (sha256 as a
  model-cache fingerprint, not password storage), the "bad HTML filtering"
  finding (output goes to a terminal and to JSON; the repository renders no
  HTML), the URL-substring finding (a test assertion), and the prototype
  pollution finding in `config set` (already guarded since 0.3.x; the rule
  does not recognize a `.some()` precondition).

### 中文

- **项目配置文件可以替换合并后配置对象的原型。** YAML 与 JSON 都会把
  `__proto__:` 变成自有可枚举属性，深度合并的 `out[key] = ...` 因此命中原型
  setter 而不是写入一个键。于是你打开的任意仓库里的 `.kkcode/config.yaml`
  都能让**默认配置里不存在的键**读出攻击者写的值 —— 而且无声无息：它们从不
  作为自有属性出现，`JSON.stringify` 也看不见。schema 不拦顶层未知键，链路
  上游同样没有阻挡。全局 `Object.prototype` 始终未受影响。四份逐字相同的
  合并函数（配置加载、配置导入、REPL、主题加载）现已收敛为
  `src/config/merge.mjs` 一份实现，跳过 `__proto__`、`constructor`、
  `prototype` —— 与 `config set` 自 0.3.x 起就有的守卫同一套键。
- 版本检查对包名改用 `replaceAll` 编码；字符串模式的 `replace` 只替换第一处匹配。
- `verify.yml` 声明 `permissions: contents: read`：一个会执行第三方依赖代码的
  测试矩阵没有理由持有默认的令牌权限。
- 以下告警判为误报并在每条上记录了理由：两条「明文记录敏感信息」（打印的是
  api_key 环境变量**名**与 set/missing 状态，从不打印密钥）、两条「口令哈希
  强度不足」（sha256 用作模型缓存指纹，非口令存储）、「HTML 过滤正则有缺陷」
  （输出去向是终端与 JSON，全仓无 HTML 渲染）、URL 子串校验（一条测试断言）、
  以及 `config set` 的原型污染（自 0.3.x 已有守卫，规则未识别 `.some()` 前置校验）。

## 0.5.6

Closes seven ways the tool failed without saying so. Every item here shares a
shape: the code took a wrong turn and nothing — no error, no warning, no log
line — told anyone.

### English

- **`models.ultra.*` was unusable from YAML.** The schema knew only the three
  model roles, so any config file spelling out `models.ultra` was rejected as
  an unknown role — and a rejected file is discarded *whole*, taking every
  other setting in it along. Per-stage overrides now validate (with per-stage
  key checking), and a new test asserts the invariant that broke this:
  `DEFAULT_CONFIG` must pass its own schema.
- **`agent.ultra.goal_mode` silently did nothing.** `agent.ultra` is the 0.4.0
  alias for `agent.longagent`, so goal-mode keys written there landed at a path
  nothing reads; only the counter-intuitive `agent.ultra.ultra.goal_mode`
  worked. Misplaced keys are now hoisted into the section that runs them, with
  a deprecation notice; correctly placed values still win.
- **Preflight reported OK on a discarded config.** It read
  `configState.warnings`, a field `loadConfig` never produces, while the real
  `errors` array went unread — so the check that exists to catch a broken
  config passed with exit code 0. It now fails, names the offending key, and
  says the file was ignored in full. Startup and `doctor` say so too, instead
  of calling a whole-file discard a "warning".
- **The fast channel could burn tokens forever with nothing to show.** A
  thinking-only model spends the 32-token helper budget on reasoning and
  returns empty text, so ghost text requested a completion after every typing
  pause, rendered nothing, and — by design — recorded nothing in the audit
  chain or cost stats. Three consecutive empty replies now disable that model
  for the fast channel; `preflight` surfaces it. Network failures do not count,
  and one good reply resets it.
- The Kimi preset no longer points `models.fast` at a thinking-only model; it
  ships unset with a comment showing the cross-channel form
  (`fast: aliyun/qwen3.7-flash`).
- Release gating: publishing now also verifies `package-lock.json` matches the
  tag version and that the tagged commit is an ancestor of `origin/main`, so a
  tag on a side branch cannot bypass main's checks.
- The v0.4.0 GitHub Release, lost to a failed release run, has been recreated
  from the changelog.

### 中文

- **`models.ultra.*` 在 YAML 里根本用不了。** 校验器只认三个模型角色，写出
  `models.ultra` 的配置文件会以「未知角色」被拒 —— 而被拒的文件是**整份丢弃**，
  同一文件里其他设置一并失效。现在分阶段覆盖可以通过校验（并逐个校验阶段名），
  同时新增测试锁住肇事的不变量：`DEFAULT_CONFIG` 必须通过自己的 schema。
- **`agent.ultra.goal_mode` 静默无效。** `agent.ultra` 是 0.4.0 给
  `agent.longagent` 起的别名，写在那里的 goal 模式键会落到没人读的位置，
  只有反直觉的 `agent.ultra.ultra.goal_mode` 才真正生效。现在错位的键会自动
  归位到运行时读取的段并给出弃用提示；已经写对位置的值优先。
- **Preflight 对被丢弃的配置报 OK。** 它读的是 `configState.warnings` ——
  `loadConfig` 从不产生这个字段，而真正的 `errors` 无人读取，于是专门用来
  发现配置损坏的自检以退出码 0 通过。现在会报 fail、指出出错的键、并说明
  文件已被整份忽略；启动横幅与 `doctor` 同样不再把整份丢弃称作 warning。
- **fast 通道可能长期烧 token 却什么都产不出。** thinking-only 模型会把 32
  token 的辅助预算全花在推理上、正文为空，于是 ghost text 每次打字停顿都发
  一次请求、什么都不显示，而这类调用按设计不进审计链与成本统计。现在连续
  三次空回复即停用该模型，`preflight` 会显示原因；网络失败不计入，一次正常
  回复即清零。
- Kimi 预设不再把 `models.fast` 指向 thinking-only 模型，改为留空并在注释里
  给出跨渠道写法（`fast: aliyun/qwen3.7-flash`）。
- 发布门槛加严：现在还会校验 `package-lock.json` 与 tag 版本一致、且被打
  tag 的提交必须是 `origin/main` 的祖先，杜绝在旁支上打 tag 绕过 main 的检查。
- 补建了因发布工作流失败而缺失的 v0.4.0 GitHub Release。

## 0.5.4

Makes the CI verify matrix trustworthy again — and green on every platform.

### English

- Fix the stage-objective test stat helper matching paths with forward-slash
  `endsWith` while Windows `path.resolve` produces backslashes. Seven subtests
  had been failing on the verify matrix's Windows job since 0.4.2; separators
  are now normalized before matching. Production code was never affected —
  real filesystem paths stat correctly on every platform.
- Process change: releases are now gated on the full verify matrix
  (ubuntu 22/24, windows 22, macos 22) plus CodeQL being green on the release
  commit — previous releases only watched the ubuntu-only release workflow,
  which is how the red Windows job went unnoticed across four releases.

### 中文

- 修复 stage-objective 测试的 stat 替身用正斜杠 `endsWith` 匹配路径的问题 ——
  Windows 的 `path.resolve` 产生反斜杠，导致 verify 矩阵的 Windows job 上
  七个用例自 0.4.2 起持续失败；现比较前先归一化分隔符。生产代码从未受影响，
  真实文件系统路径在各平台均正常。
- 流程变更：发布现在以发布提交上完整 verify 矩阵（ubuntu 22/24、windows 22、
  macos 22）加 CodeQL 全绿为门槛 —— 此前只盯 ubuntu 单 job 的 release 工作流，
  红着的 Windows job 因此连续四个版本无人察觉。

## 0.5.3

Settles the debts 0.5.0 left to itself: every config key it introduced now
does what it says, and three behavioural gaps found during real-model
acceptance are closed.

### English

- Wire the five 0.5.0 config keys that were shipped inert:
  `ultra.criteria.allow_shell` (criterion commands may opt into shell
  interpretation; still off by default), `ultra.report.write_markdown`,
  `ultra.ledger.enabled`, `ultra.ledger.max_rounds_kept` (round records are
  trimmed; blocker aggregation is unaffected), and `models.ultra.report`
  (summary model priority ultra.report → fast, with provider/model qualifiers).
  The board's heartbeat-stale warning now reads `heartbeat_timeout_ms` instead
  of a hardcoded 120s.
- `ultra resume` resumes on the original run's provider and model, recorded in
  the ledger — previously a session started with `--provider aliyun` silently
  resumed on the default channel.
- Silent-error detection no longer skips tasks with no planned files. The
  fallback plan's tasks have none, so a worker reply of "provider error:
  authentication failed" was recorded as completed with zero work — the exact
  vacuous-completion shape seen in real-model acceptance. Error signatures are
  now checked regardless; file-based heuristics still require planned files.
  (`ETIMEDOUT` also joins the transient error class.)
- A manual-only goal no longer surrenders after round one while executable
  work remains. Work that is unfinished — including "completed" tasks whose
  claimed artifacts are missing — keeps the loop going under the usual stall
  and budget constraints; the final status still honestly reports
  blocked_manual.
- Repeatedly failing criteria are distilled into
  `project_memory.knownPitfalls` (≤5 per run, write-only; feeding them back
  into planning stays opt-in and off by default).
- Worktree-isolated workers inherit workspace trust from the parent repo. Trust
  is keyed by path, a worktree is a new path, so in any repo whose project
  config defines a provider the supply-chain guard refused inference inside
  worktrees — every worktree task span was a vacuous no-op that the new
  silent-error detection immediately exposed. The temporary trust record is
  revoked when the worktree is cleaned up.

### 中文

- 接通 0.5.0 引入却未生效的五个配置键：`ultra.criteria.allow_shell`（判据
  命令可显式启用 shell 解释，默认仍关）、`ultra.report.write_markdown`、
  `ultra.ledger.enabled`、`ultra.ledger.max_rounds_kept`（轮次记录裁剪，
  受阻点聚合不受影响）、`models.ultra.report`（摘要模型优先级
  ultra.report → fast，支持 provider/model 跨渠道限定）。看板的心跳超时
  提示改读 `heartbeat_timeout_ms`，不再硬编码 120 秒。
- `ultra resume` 按台账里记录的原渠道与模型续跑 —— 此前用
  `--provider aliyun` 起的会话续跑时会悄悄换回默认渠道。
- 静默错误检测不再放过没有 plannedFiles 的任务。兜底计划的任务恰好都没有，
  于是 worker 回复「provider error: authentication failed」也被记成 completed
  零产物空转 —— 真实模型验收里撞见的正是这个形态。错误签名现在一律先查；
  文件类启发式仍只对声明了文件的任务生效。（`ETIMEDOUT` 同时归入瞬时错误。）
- manual-only 目标不再在第一轮就交卷：只要还有可执行的工作没做完 ——
  包括「标记完成但产物缺失」的任务 —— 循环在停滞与预算约束下继续；
  终局状态仍如实报 blocked_manual。
- 反复失败的判据提炼进 `project_memory.knownPitfalls`（每次 ≤5 条，只写
  不读；回注规划仍是默认关闭的显式开关）。
- worktree 隔离的 worker 继承父仓库的工作区信任。信任按路径哈希存储，
  worktree 是新路径 —— 项目配置里定义了 provider 的仓库，供应链防护会在
  worktree 里拒绝一切推理，每个 worktree 任务都在空转，而新的静默错误
  检测立刻揭穿了这一点。临时信任记录随 worktree 清理一并撤销。


## 0.5.2

### English

- Add `kkcode provider` — list / switch / current for configured providers,
  plus an interactive numbered picker, all persisting through the shared
  field-merging save path (contributed by @MrMark019, thanks!). The REPL's
  `/provider` grows the same picker: bare `/provider` lists everything with the
  active model and takes a number or name; the wizard now auto-switches the
  session to a provider it just configured.
- Straighten the subcommand vocabulary from the contribution before it ships:
  `add` now *adds* (opens the wizard) and picking lives on bare `/provider` —
  upstream had `add` meaning "list & switch" and `set` meaning "add", inverted
  from what anyone would type first. `set` prints a one-line pointer for one
  release. The picker also releases any `/`-prefixed input back to normal
  command handling instead of matching it as a provider name.
- Deduplicate the config write path: the wizard's field-merging
  `saveProviderConfig` is exported and shared, so the 0.5.1 fix for wiped
  `api_key`/timeouts cannot regress in a second implementation. Covered by new
  command-level tests.

### 中文

- 新增 `kkcode provider` —— 列出 / 切换 / 查看当前 provider，外加编号交互
  选择，全部经共用的逐字段合并路径写回（来自 @MrMark019 的贡献，感谢！）。
  REPL 的 `/provider` 获得同款选择器：裸 `/provider` 列出全部（带当前模型），
  输入编号或名称即切换；向导配置完成后自动把会话切到新 provider。
- 上线前把贡献里的子命令词汇归位：`add` 现在就是**添加**（打开向导），
  列出并选择归裸 `/provider` —— 上游分支里 add 是「列出切换」而 set 是
  「添加」，与任何人的第一直觉相反。`set` 保留一个版本的指路提示。
  选择模式对 `/` 开头的输入放行回正常命令处理，不再当 provider 名去匹配。
- 写回路径去重：向导的逐字段合并 `saveProviderConfig` 导出共用 ——
  0.5.1 修掉的「抹掉 api_key/超时」事故不可能在第二份实现里复活。
  新增命令级测试覆盖。


## 0.5.1

### English

- Fix the provider wizard ignoring an inline `api_key` (issue #3). Model-catalog
  discovery only checked the preset's environment variable and failed with
  "environment variable not set" even when the user had already put `api_key`
  directly in `~/.kkcode/config.yaml`. The wizard now sees the existing provider
  config: an inline key is used for discovery (with a notice), and the error
  message — shown only when neither source exists — names both ways out.
- Fix the wizard's save step wiping fields it never touched. Saving replaced the
  whole provider entry, so re-running the wizard for an existing provider erased
  the stored `api_key`, timeout tuning and models list. Entries are now merged
  per field: what the wizard set wins, everything else survives.

### 中文

- 修复 provider 向导无视内联 `api_key`（issue #3）。模型目录发现只查预设的
  环境变量，用户明明已在 `~/.kkcode/config.yaml` 里直接写了 `api_key`，向导
  仍报「环境变量未设置」。现在向导能看到现有配置：内联密钥直接用于发现
  （并有提示），两个来源都没有时错误信息会把两条出路都说清楚。
- 修复向导保存时抹掉没动过的字段。写回原先是整条目替换 —— 对已有 provider
  重跑向导会把存好的 `api_key`、超时调优、models 列表全部清掉。现在逐字段
  合并：向导设置的生效，其余原样保留。


## 0.5.0

Ultra becomes goal-driven: it keeps working while it makes progress, and
reports honestly — with evidence — the moment it stops.

### English

- **An executable definition of done.** Acceptance criteria are now structures
  the system runs — file existence, content match, command exit codes, tests,
  gates — not prose pasted into prompts. Anything that cannot be mechanised
  becomes a `manual` criterion that no code path can auto-pass: the goal parks
  at `blocked_manual` until a human answers. `[TASK_COMPLETE]` is demoted from
  verdict to self-report; alone it never yields `completed`.
- **The goal loop.** `max_rounds` defaults to unlimited; the constraint is
  evidence of progress (criteria/gate transitions, newly completed tasks, file
  changes without verbatim-repeated errors), backed by stall detection
  (2 rounds), a 2h deadline and the token budget. `goal_mode: false` restores
  the exact 0.4.x single-round behaviour.
- **Failure is triaged, not fatal.** Stage failures route through a decision
  table — retry / degrade / defer / skip / replan — instead of 0.4.x's
  "retry or abandon everything". Permanent errors no longer burn 12 hopeless
  backoff retries; a replan feeds the ledger's failure evidence back to the
  blueprint agent, capped and deduplicated by plan signature.
- **Honest reporting.** Every round is recorded in
  `.kkcode/ultra/<session>/ledger.json`; the blocked report shows each
  criterion's verdict with the twelve lines of command output 0.4.x discarded,
  attempt counts across rounds, any dropped acceptance criterion with its
  stated reason, and optional fast-model "key judgment / next steps". Rendered
  in the REPL, `kkcode ultra report`, and `report.md`.
- **When blocked, it asks.** In a TTY: continue / give guidance / deliver
  what's done / stop — guidance steers the next round. Headless runs close over
  explicitly: an empty answer is never "continue", and a stalled unattended run
  with nothing achieved exits 2 (`blocked`), never a quiet success.
- **Sub-goals and the board.** Blueprints may decompose the objective into
  ≤6 independently deliverable sub-goals; rounds re-execute only the pending
  ones. `/board` and `kkcode ultra board --watch` render five columns — todo /
  doing / blocked / pending-check / done — where "pending-check" holds work the
  model claims but criteria have not verified.
- **Machinery that finally works**: cross-process `ultra stop` takes effect
  (the flag was written but never read); `ultra resume` actually resumes from
  the checkpoint — H0/H1/H2 are skipped, the interrupted stage continues, and
  `--guidance` steers it (0.4.x resume only cleared a flag); worker log lines
  are forwarded so H4 is no longer minutes of silence; checkpoints carry the
  plan context that makes restore real; `checkpoint_interval` and the heartbeat
  event are implemented; `models.ultra.*` per-stage overrides land.
- Statuses now tell the truth: `completed` / `partial` / `blocked` /
  `blocked_manual` / `user_stopped` / `budget_exhausted` / `deadline_exhausted`
  / `needs_objective` / `fatal`, with meaningful exit codes. Session state
  `failed` is reserved for fatal errors. H7 merges to the base branch only on
  `completed`. Research / docs / ops objectives are first-class: they skip
  scaffold and build gates and verify against document-shaped criteria.
- Deprecated with one-time notices: `no_progress_limit` / `no_progress_warning`
  (superseded by `ultra.no_progress_rounds` — note the semantic change from
  iterations to rounds). The 0.4.0 legacy mode/permission aliases keep working
  with notices; their removal moves to 0.6.0 — pulling the rug now, mid-upgrade,
  costs users more than the vocabulary costs us.

### 中文

- **可执行的「完成」定义。** 验收判据成为系统会执行的结构 —— 文件存在、内容
  匹配、命令退出码、测试、门禁 —— 而不是贴进提示词的散文。无法机器化的判据
  一律成为 `manual`：没有任何代码路径能把它自动判过，目标会停在
  `blocked_manual` 等人点头。`[TASK_COMPLETE]` 从判据降级为自我声明，单独
  永远不产生 `completed`。
- **目标循环。** `max_rounds` 默认不限；约束是进展证据（判据/门禁跃迁、新完成
  的任务、错误没有原样重复的文件变更），由停滞检测（2 轮）、2 小时时限与
  token 预算兜底。`goal_mode: false` 一行退回 0.4.x 单轮行为。
- **失败分档处置，不再一票崩塌。** stage 失败走决策表 —— 重试/降级/延后/跳过/
  重规划 —— 取代 0.4.x 的「重试，或放弃当前与所有后续 stage」。永久性错误不再
  烧 12 次无望的退避；重规划把台账里的失败证据喂回 blueprint，有次数上限，
  且按计划签名去重。
- **如实汇报。** 每一轮记入 `.kkcode/ultra/<会话>/ledger.json`；受阻报告逐条
  展示判据结论与 0.4.x 丢弃的那 12 行命令输出、跨轮尝试次数、被删除的验收
  判据及其理由，以及可选的快速模型「关键判断 / 下一步」。REPL、
  `kkcode ultra report` 与落盘的 report.md 三处同源。
- **受阻时会问你。** TTY 下四个选项：继续 / 给指引 / 交付已完成部分 / 停止 ——
  指引直接进入下一轮。无终端运行显式收口：空答案绝不当「继续」，零达成的
  停滞运行以退出码 2（blocked）结束，绝不静默通过。
- **子目标与看板。** blueprint 可把目标分解为 ≤6 个可独立交付的子目标，
  后续轮次只重跑未达成的部分。`/board` 与 `kkcode ultra board --watch` 渲染
  五列：待办 / 进行中 / 受阻 / 待验收 / 已达成 ——「待验收」收纳模型声称完成
  但判据尚未核验的工作。
- **终于真的能用的机制**：跨进程 `ultra stop` 生效（旧版把标志写盘但无人读）；
  `ultra resume` 真的从 checkpoint 续跑 —— 跳过 H0/H1/H2、从中断的 stage
  继续，`--guidance` 可以指路（0.4.x 的 resume 只清一个标志）；worker 日志
  逐行转发，H4 不再是几分钟的空白；checkpoint 补齐了让恢复成立的计划上下文；
  `checkpoint_interval` 与心跳事件落地；`models.ultra.*` 分阶段模型上线。
- 状态说真话：`completed` / `partial` / `blocked` / `blocked_manual` /
  `user_stopped` / `budget_exhausted` / `deadline_exhausted` /
  `needs_objective` / `fatal`，退出码各有含义。会话 `failed` 只留给内部错误。
  H7 只在 `completed` 时并入主干。调研 / 文档 / 运维目标成为一等公民：跳过
  脚手架与 build 门禁，按文档形态的判据核验。
- 一次性弃用提示：`no_progress_limit` / `no_progress_warning`（由
  `ultra.no_progress_rounds` 取代 —— 注意语义从迭代变为轮次）。0.4.0 的旧模式
  与权限别名继续可用并带提示；移除推迟到 0.6.0 —— 升级进行到一半抽走梯子，
  用户付出的代价远大于我们维护几个别名的成本。


## 0.4.3

Everything here is a repair to Ultra machinery that existed but did not work.
No new features; no configuration changes.

### English

- Make the stage objective check reachable. It read the gate result as
  `gates.results.build` while `runUsabilityGates` returns the gate at
  `gates.gates.build`; both paths yielded `undefined`, and the resulting empty
  object both passed the "gate is decisive" filter and failed the "gate is
  passing" one. A stage with every planned file on disk and every gate green
  still came back unmet with the reason `gates failed: ; `. The escape hatch
  0.4.2 announced was never reachable in production. Gate results now go through
  a single `readGate()` that throws on shape drift instead of reading
  `undefined`, all gate test doubles come from one factory, and a contract test
  compares that factory against the real function key by key.
- Make the degradation chain degrade. It only advanced its level when a strategy
  reported success, and the default `fallback_model: null` made the first
  strategy always fail, so the level never moved off zero, `graceful_stop` was
  unreachable, and the four breaks that waited for it — H4 phase timeout, token
  budget ceiling, max-recoveries abort, H5 phase timeout — were all dead. The
  level now advances unconditionally, skipping strategies that do not apply.
  `degradation.enabled`, previously read by no code at all, now switches the
  chain off. The "degradation applied" notice is only emitted when something was
  actually degraded; under the default config it used to be false.
- Stop a headless run from disabling every quality gate a user has. The gate
  preference prompt ran with no TTY, where the answer is an empty string, which
  parsed as "all five gates off" and was written to the user-level
  `~/.kkcode/gate-preferences.json` — silently, for every project on that
  machine. The prompt is now skipped when the user cannot be reached, an
  unparseable answer writes nothing, and an all-off record without an explicit
  marker is treated as damage from 0.4.x and re-asked once.
- Deliver Ultra's failure diagnosis. `generateRecoverySuggestions` has produced
  a structured post-mortem since 0.3.x — failed tasks with error categories,
  manual investigation steps, a resume hint — and `engine.mjs` dropped it in both
  of the two places that enumerated the result fields. The repo had zero
  consumers. Those two enumerations are now one function, and the REPL and
  `kkcode ultra start` both render the diagnosis.
- Guarantee teardown. The stop-event listener was unsubscribed on three of four
  return paths, and thrown errors skipped teardown entirely, leaving a leaked
  listener and a session pinned at `running-longagent`. A single `finally` now
  owns it, and `runStageBarrier`'s throws for dependency cycles and file-ownership
  overlap are caught as plan defects rather than discarding the whole turn.
- Give alerts a reason. Seven of twelve `LONGAGENT_ALERT` emitters never set the
  field the renderer reads, so the terminal showed a bare `alert [stuck_warning]`
  with nothing after it. A static check now enforces the field. Two declared
  events that had a renderer and no emitter are now emitted, and three that were
  emitted with no renderer are now shown.
- Give the gate-repair prompt the error output it is told to read. It instructed
  the model to find the root cause from output it was never given —
  `build:build failed with code 1` — while the captured twelve lines sat unread
  in the gate result.
- `kkcode ultra start` printed `done` for every run because it read a field that
  does not exist on the result; it now reports the real status and exits non-zero
  on failure. `currentStageId` was read by the status bar but never returned, so
  the bar always degraded to `2/5` instead of naming the stage.

### 中文

- 让 stage 目标核验重新可达。它把门禁结果读作 `gates.results.build`，而
  `runUsabilityGates` 返回的门禁在 `gates.gates.build`；两条路径都取到
  `undefined`，得到的空对象既通过了「门禁有发言权」的过滤，又被判为「没通过」。
  于是文件全部落地、门禁全绿的 stage 仍然返回未达成，理由是毫无意义的
  `gates failed: ; `。0.4.2 宣称的那道逃生门在生产路径上从未可达。现在门禁结果
  统一经 `readGate()` 读取——形状不对会抛而不是取到 `undefined`，全仓门禁替身
  只能由一个工厂构造，契约测试拿真函数的输出与它逐键比对。
- 让降级链真的会降级。它只在策略生效时才推进档位，而默认的
  `fallback_model: null` 让第一档恒定失败——档位永远停在 0，`graceful_stop`
  不可达，依赖它的四处 break（H4 阶段超时、token 预算上限、重试次数耗尽、
  H5 阶段超时）全部失效。现在档位无条件前进，跳过不适用的策略。
  `degradation.enabled` 此前没有任何代码读取，现在能真正关闭整条链。
  「已降级」的提示只在确实降了级时才发——默认配置下它一直在说谎。
- 阻止无终端运行关掉用户的全部质量门禁。门禁偏好询问在没有 TTY 时照样执行，
  而那里的答案是空串，被解析成「五个门禁全关」并写进用户级的
  `~/.kkcode/gate-preferences.json`——静默生效，影响该机器上的所有项目。
  现在问不到用户就跳过，解析不出答案就不写盘，而没有显式标记的「全关」记录
  会被当作 0.4.x 的事故遗留，重新询问一次。
- 把 Ultra 的失败诊断送到用户面前。`generateRecoverySuggestions` 从 0.3.x 起就
  在生成结构化的事后分析——失败任务及其错误分类、手动排查步骤、恢复提示——而
  `engine.mjs` 在两处逐字段枚举结果的地方都把它丢掉了，全代码库零消费者。
  两处枚举现已收敛为一个函数，REPL 与 `kkcode ultra start` 都会渲染这份诊断。
- 保证收尾。stop 事件的监听器只在四条返回路径中的三条退订，而抛出的异常会
  完全跳过收尾——监听器泄漏，会话永久停在 `running-longagent`。现在退订只有
  一处 `finally`；`runStageBarrier` 因依赖环与文件所有权冲突抛出的错误会被
  当作计划缺陷捕获，而不是让整个回合连同已完成的工作一起丢掉。
- 让告警说出原因。十二个 `LONGAGENT_ALERT` 发射点里有七个从不设置渲染器要读
  的那个字段，终端上只会出现一行 `alert [stuck_warning]`，后面空空如也。
  现在有静态检查兜底。两个「有渲染器没有发射者」的事件补上了发射，三个
  「有发射者没有渲染器」的事件补上了显示。
- 让门禁修复提示词拿到它被要求阅读的错误输出。它一边让模型「从错误输出里找出
  根因」，一边只给出 `build:build failed with code 1`，而采集好的末 12 行输出
  就躺在门禁结果里没人读。
- `kkcode ultra start` 因为读了一个结果对象上并不存在的字段，对每一次运行都打印
  `done`；现在会报告真实状态并在失败时以非零码退出。`currentStageId` 被状态栏
  读取却从未被返回，所以状态栏永远退化成 `2/5` 而不是阶段名。

## 0.4.2

### English

- Restore the Ultra stage prompts. `preview-agent`, `blueprint-agent`,
  `coding-agent` and `debugging-agent` derive their prompt file from the agent
  name, but the files ship under a `longagent-` prefix, so `getAgentPrompt()`
  silently returned an empty string and all four stages had been running with no
  role instructions at all. 229 lines of specialist prompting are live again.
- Stop injecting the mode contract twice. `modeReminder()` prepended it while a
  dedicated `mode_contract` block emitted the same text, so roughly 8% of every
  system prompt was a verbatim duplicate paid for on every request.
- Update the CLI assistant contract to the 0.4.0 vocabulary and state explicitly
  that Agent, Agent · Auto and YOLO differ by approval level, not by lane, so a
  wider mode is never read as pre-approval for edits.
- Add `kkcode preflight`: a fast startup self-check covering config, provider
  credentials, MCP, skills and version. It stays deliberately lighter than
  `doctor`, which also runs session fsck and audit-chain verification. The TUI
  runs it on startup and prints only what is wrong.
- Honour `KKCODE_AUTO_UPDATE` for startup auto-install, overriding
  `update.auto_install` in both directions. The default remains notify-only.
- Stop Ultra from re-running a finished stage. `stageIndex` only advanced when
  every task reported `[TASK_COMPLETE]`, so a stage whose files were already
  written and whose tests already passed would loop until the phase timed out —
  and each degradation reset the recovery counter to zero, removing the only
  ceiling. Stages now verify the objective directly (declared files present,
  build and test passing) before retrying, and a separate running total caps
  total attempts at `max_stage_attempts` regardless of degradations.
- Remove the orphaned `max-steps.txt` prompt.

### 中文

- 恢复 Ultra 的阶段提示词。`preview-agent`、`blueprint-agent`、`coding-agent`、
  `debugging-agent` 的提示词文件名默认取 agent 名，而文件实际带 `longagent-`
  前缀，`getAgentPrompt()` 一直静默返回空串——四个阶段从来没有加载过角色指令。
  229 行专家提示词重新生效。
- 模式契约不再重复注入。`modeReminder()` 会拼接它，而 `mode_contract` 块又发
  一遍同样的文字，约占系统提示词的 8%，每个请求都在为这份重复付费。
- CLI assistant 契约同步到 0.4.0 词汇，并明确写出 Agent、Agent · Auto、YOLO
  的区别在审批档而非航道，避免模型把更宽的模式当成编辑已获批准。
- 新增 `kkcode preflight`：快速启动自检，覆盖配置、provider 凭据、MCP、skills
  与版本。它刻意比 `doctor` 轻——后者还会做 session fsck 与审计链校验。TUI
  启动时会自动跑一遍，只在有问题时打印。
- 支持用 `KKCODE_AUTO_UPDATE` 控制启动自动升级，双向覆盖 `update.auto_install`；
  默认仍然只提示不自装。
- Ultra 不再重跑已经完成的 stage。`stageIndex` 只在所有 task 都报出
  `[TASK_COMPLETE]` 时推进，于是文件早已写好、测试早已通过的 stage 会一直
  重跑到阶段超时；而每次降级又把 recovery 计数清零，唯一的上限也随之失效。
  现在重试前会直接核验目标是否达成（声明的文件是否落地、build/test 是否通过），
  并用一个不清零的累计计数把总尝试次数限制在 `max_stage_attempts`。
- 删除零引用的 `max-steps.txt`。

## 0.4.1

### English

- Fix a CLI end-to-end test that still expected `permission.default_policy` in
  `kkcode permission show`. The key was removed from `DEFAULT_CONFIG` in 0.4.0,
  so a clean install no longer prints it; the test only passed locally because a
  stale user config supplied the field. No runtime behaviour changed.

### 中文

- 修复一条仍然期待 `kkcode permission show` 输出 `permission.default_policy`
  的端到端测试。该键在 0.4.0 已从 `DEFAULT_CONFIG` 移除，干净安装不再打印；
  此前只因本地遗留的用户配置提供了该字段才通过。运行时行为不变。

## 0.4.0

### English

- Collapse the mode vocabulary into a single flat cycle. `Shift+Tab` walks
  Plan, Agent, Agent · Auto, Ultra and YOLO; `/mode` opens a picker. Each mode
  is a (lane, approval) pair, and the lane identifiers stay on the 0.3.x
  vocabulary so sessions, hooks and permission rules keep working.
- Merge the six permission levels into four: `readonly`, `manual`,
  `accept-edits` and `yolo`. The new third level is deliberately not named
  `auto` — in 0.3.x `auto` meant edits still ask, so reusing the name would
  have silently widened existing configs on upgrade.
- Delete the unreachable `permission.mode` and `permission.default_policy`
  decision branches, and fix `/permission allow|ask|deny`, which previously
  wrote only those fields and was therefore a silent no-op.
- Add **Always Allow** to the approval prompt. Grants persist as ordinary
  `permission.rules[]` entries in the user config, scoped by `workspace` so
  they neither leak into other repositories nor into a user's git history.
  Manage them with `/permission list` and `/permission forget`.
- Keep one Ultra orchestration. The 4stage and parallel implementations are
  removed along with their config keys and the `/longagent 4stage|hybrid`
  subcommands; `/ultra` is the new name and `/longagent` a deprecated alias.
- Make the plan handoff real: choosing Build or Ultra Build after `exit_plan`
  now switches mode and runs the build turn, instead of asking the user to
  start it themselves.
- Add a top-level `models` block with `main`, `fast` and `subagent`, replacing
  five disconnected model override mechanisms. `fast` powers a cheap
  non-streaming, audit-bypassed channel used by inline ghost text and session
  titles; it never falls back to `main`.
- Predict the next phrase inline in the composer when `models.fast` is set.
  Ghost text produces no cells, never moves the cursor and never adds a row,
  so mouse hit-testing and IME placement are unchanged.
- Scroll the transcript while dragging past the edge of the log area. Selection
  anchors moved to transcript-absolute coordinates, so a selection now survives
  scrolling mid-drag and can extend beyond the visible viewport.
- Every 0.3.x mode name, permission level and config key still works, mapping
  automatically with a one-time deprecation notice. Removal is planned for
  0.5.0.

### 中文

- 将模式词汇收敛为一条扁平循环：`Shift+Tab` 依次切换 Plan、Agent、
  Agent · Auto、Ultra、YOLO，`/mode` 打开选择面板。每个模式都是
  (航道, 审批档) 二元组，航道标识保持 0.3.x 不变，会话、hooks 与权限规则
  全部照常工作。
- 权限六级合并为四级：`readonly`、`manual`、`accept-edits`、`yolo`。第三档
  刻意不叫 `auto`——0.3.x 的 `auto` 语义是「编辑仍需确认」，沿用同名会在升级时
  静默放宽已有配置。
- 删除 `permission.mode` 与 `permission.default_policy` 两条永不可达的判定
  分支；修复 `/permission allow|ask|deny`，它此前只写这两个字段，实际是空操作。
- 审批弹窗新增 **Always Allow**。授权以普通 `permission.rules[]` 形式写入用户级
  配置，并带 `workspace` 限定，既不会跨仓库误放行，也不会进入用户的 git 历史。
  可用 `/permission list` 与 `/permission forget` 管理。
- Ultra 只保留一套编排：删除 4stage 与 parallel 两套实现及其配置键和
  `/longagent 4stage|hybrid` 子命令；`/ultra` 为新名称，`/longagent` 保留为
  弃用别名。
- Plan 交接真正落地：`exit_plan` 后选择 Build 或 Ultra Build 会直接切换模式并
  开始执行，而不再只是提示用户自己去启动。
- 新增顶层 `models` 配置（`main` / `fast` / `subagent`），取代此前五套互不相通的
  模型覆盖机制。`fast` 提供廉价的非流式、旁路审计通道，供输入框预测与会话标题
  使用；它不会回退到 `main`。
- 配置 `models.fast` 后，输入框会内联预测下一句。Ghost text 不产生 cells、
  不移动光标、不新增行，鼠标点击与输入法定位与之前完全一致。
- 拖动选择文字到日志区边缘外时自动滚动。选区锚点改用 transcript 绝对坐标，
  边选边滚不再错位，选区也可以超出当前可见区域。
- 0.3.x 的模式名、权限等级与配置键全部继续可用并自动映射，首次使用时打印一次性
  弃用提示，计划在 0.5.0 移除。

## 0.3.3

### English

- Rebuild the full-screen terminal renderer around row-addressed updates and a
  real hardware cursor at the composer coordinates, allowing supported terminal
  IME and accessibility integrations to use the actual input position.
- Add incremental SGR mouse and bracketed-paste decoding for transcript
  selection, cross-platform clipboard requests with honest confirmation state,
  wheel scrolling, composer cursor placement, and click-to-expand Thinking/tool
  blocks. Preserve CJK and emoji input when UTF-8 bytes cross stdin chunks, and
  include the final visible composer row in mouse hit-testing.
- Restore cooked mode, mouse tracking, bracketed paste, and the alternate
  screen before Unix job-control suspension; reactivate them on `SIGCONT`.
  Final teardown also drains pending prompts, pauses stdin, and awaits MCP child
  shutdown so `/exit` cannot leave the process or terminal hanging. A synchronous
  exit guard and Windows `SIGBREAK` handling restore the shell after abrupt exits.
- Render assistant Markdown incrementally without chunk-boundary artifacts.
  Move mode/model/provider/permission changes into transient bottom toasts,
  mute tool activity, and expose bounded red/green mutation diffs on demand.
- Show animated elapsed `Thinking · Ns` state during model reasoning and retain
  the completed reasoning as a collapsed, inspectable transcript block. Promote
  the waiting animation into native reasoning without emitting a duplicate empty
  block, and preserve readable Anthropic thinking in non-streaming responses
  without retaining signatures or redacted payloads.
- Treat `retry_attempts: 5` as five reconnects after the initial request.
  OpenAI, Anthropic, compatible gateways, Kimi, and Ollama retry transient
  connection/rate/server failures before the first streamed event, honor
  `Retry-After`, fast-fail deterministic client errors, and never replay a
  request after outward stream content begins.
- Correlate retry events with session, turn, trace, and request identities while
  preserving the final provider error classification for audit records.
- Keep real-desktop mouse, clipboard, and IME behavior in the pre-release manual
  acceptance matrix for Windows, macOS, and Linux terminal emulators.
- Harden native Windows execution: await MCP shutdown in one-shot commands,
  keep argv-form MCP servers out of `cmd.exe`, launch npm/npx and local Prettier
  through safe platform-aware paths, and make branch-review hashes stable across
  Git for Windows path quoting.
- Hold an ambiguous standalone ESC for 35 ms so mouse and paste reports remain
  intact across transport chunks, then deliver a bare Escape without Readline's
  extra delay. Native clipboard fallbacks now run asynchronously, cancel stale
  copies, and use PowerShell UTF-8/Base64 transport for CJK and emoji on Windows.
- Read Linux Wayland image and text clipboards through `wl-paste`, retaining
  `xclip`/`xsel` fallbacks and bounded, timeout-protected reads. Leave detached
  worktrees before cleanup so Windows does not hold the directory open; on
  Windows, validate the registered non-primary worktree, remove its directory
  and exact administrative entry directly, then verify the registration is gone
  without invoking the hanging `git worktree remove` path. Source the splash
  version directly from the package release metadata.
- Stop injecting and preloading Context7 at startup, so a clean KK Code install
  does not invoke `npx` or download an MCP package. Context7 and every other MCP
  server remain available through explicit user, workspace, or plugin configuration.

### 中文

- 将全屏终端渲染重构为逐行更新，并在输入框坐标恢复真实硬件光标，让支持该机制的
  终端输入法与辅助功能使用实际输入位置。
- 新增增量 SGR 鼠标与 bracketed paste 解码，支持对话拖选、跨平台复制请求与
  确认状态区分、滚轮浏览、点击定位输入光标，以及点击展开/收起 Thinking 与工具详情；
  中文与 emoji 的 UTF-8 字节即使跨 stdin 分片也不会损坏，输入框最后一行也可正确点击。
- Unix 挂起前会恢复 cooked mode、鼠标、bracketed paste 与主屏幕，`SIGCONT`
  后再完整激活；最终退出会收口待决交互、暂停 stdin 并等待 MCP 子进程关闭，
  避免 `/exit` 后进程或终端仍被占用；同步退出保护和 Windows `SIGBREAK`
  处理也会在异常退出时恢复 Shell。
- 增量解析模型 Markdown，避免流式分片破坏格式；模式、模型、Provider、权限切换
  改为底部瞬时 Toast；工具日志降为浅灰色，代码修改可按需查看受限长度的红绿 Diff。
- 模型思考时显示带动效和耗时的 `Thinking · Ns`，完成后保存为默认折叠、可检查的
  对话块；等待动画会直接升级为原生 reasoning，不再额外生成空白 Thinking 行。
  Anthropic 非流式响应也会保留可读思考内容，但不会记录签名或 redacted 密文。
- 将 `retry_attempts: 5` 明确定义为首次请求之后最多重连 5 次。OpenAI、
  Anthropic、兼容网关、Kimi 与 Ollama 会在首个流式事件前重试网络、限流与服务端
  瞬时错误，遵循 `Retry-After`；确定性客户端错误立即失败，流式内容开始后绝不重放。
- 重试事件关联 session、turn、trace 与 request 身份，并为审计记录保留最终模型错误分类。
- Windows、macOS、Linux 真实桌面终端的鼠标、剪贴板和输入法表现仍列入发布前
  手工验收矩阵，不以伪终端自动化测试替代。
- 补齐 Windows 原生执行兼容性：一次性命令会等待 MCP 完整关闭，argv 形式的 MCP
  不再经过 `cmd.exe`，npm/npx 与项目 Prettier 使用安全的平台感知启动路径，并消除
  Git for Windows 临时路径转义造成的分支审查哈希漂移。
- 对单独到达的 ESC 保留 35 ms 判定窗口，避免鼠标与粘贴协议跨分片时被拆散；
  确认为裸 Escape 后不再叠加 Readline 延迟。原生剪贴板回退改为异步执行并取消
  过期复制，Windows 通过 PowerShell UTF-8/Base64 通道可靠复制中文与 emoji。
- Linux Wayland 的图片与文本剪贴板优先通过 `wl-paste` 读取，同时保留
  `xclip`/`xsel` 回退、超时和大小限制；清理 detached worktree 前先离开该目录，
  避免 Windows 持有目录锁；Windows 还会先校验目标是已登记且非主工作树，再直接
  删除目录及对应的精确 Git 管理项并复核登记已移除，绕开会卡死的
  `git worktree remove` 路径；启动动画版本号统一读取 package 发布元数据。
- 移除启动时自动注入并预加载的 Context7，干净安装的 KK Code 不再调用 `npx`
  或下载 MCP 包；用户仍可通过个人、工作区或插件配置显式启用 Context7 及其他
  任意 MCP Server。

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
