# Review Notes: kkcode Agent / LongAgent Compatibility Catch-up

This review summarizes the highest-value quality and documentation concerns surfaced while reviewing the approved catch-up scope against the current `kkcode` runtime.

## Overall verdict

The catch-up direction is sound **if it stays compatibility-first**:

- keep LongAgent as the structured implementation path
- improve the lighter delegated-task experience instead of replacing LongAgent
- formalize extension/package boundaries before widening them

## Highest-priority findings

### 1. Public extension docs still need one canonical vocabulary

Current repo evidence shows a terminology mismatch:

- `src/plugin/hook-bus.mjs` loads hook scripts from `.kkcode/hooks`
- `README.md` and some UI/help strings still present `.kkcode/plugins` as the hook location
- `src/tool/registry.mjs` already treats plugin directories as a separate concept for tool loading

**Risk:** users will keep conflating hooks with plugins, and plugin-manifest work will inherit that confusion.

**Recommendation:** release the compatibility slice with one canonical split:

- hooks = `.kkcode/hooks`
- plugin packages = `.kkcode-plugin/plugin.json` or `.kkcode/plugins/<name>/plugin.json`

### 2. Delegation policy is under-specified relative to LongAgent policy

LongAgent prompts already encode strong file ownership and stage rules. The lighter `task` path is much thinner.

**Risk:** prompt-only upgrades help, but without a clear contract users may still misuse delegated tasks for work that belongs in LongAgent.

**Recommendation:** document and test four explicit modes:

- stay local
- fresh delegated agent
- forked-context agent
- background delegated work

The documentation should make it clear that forked-context work is for sidecar research/audit/verification, not for replacing structured LongAgent implementation.

### 3. Skill compatibility needs support-level labels, not just field parsing

The current skill runtime already supports a small safe subset (`model`, `allowed-tools`, `user-invocable`, `disable-model-invocation`, `context-fork`). Claude-style compatibility will likely introduce more fields than `kkcode` can safely act on in one pass.

**Risk:** parsing extra fields without documenting support levels creates false portability confidence.

**Recommendation:** every newly accepted frontmatter field should be documented as one of:

- enforced
- accepted but ignored
- rejected

### 4. Plugin manifest MVP must stay capability-bounded

A local manifest layer is the right next step, but it should reuse existing loaders and keep permissions explicit.

**Risk:** if plugin bundles can silently expand agent/tool privileges, the MVP will add ambiguity rather than portability.

**Recommendation:** keep the MVP narrow:

- explicit directories only
- no hidden capability expansion
- deterministic name/precedence behavior
- no marketplace/update semantics in v1 docs

## Medium-priority findings

### 5. Stable prompt blocks should stay stable

`src/session/system-prompt.mjs` already separates cacheable blocks from dynamic ones. Delegation guidance upgrades should preserve that split.

**Why it matters:** stuffing fast-changing runtime details into stable blocks will hurt prompt caching and make behavior drift harder to reason about.

### 6. Background completion semantics need user-facing clarity

The background task runtime is already stronger than the public docs suggest.

**Recommendation:** documentation should explicitly say that background delegated work returns a task id and must be observed via deterministic status/result retrieval, not guessed from partial logs.

## Recommended merge gate

Treat the catch-up work as ready only when all of the following are true:

- extension docs/runtime use a consistent hooks-vs-plugins vocabulary
- delegation docs explain when not to delegate
- forked-context work is positioned as a sidecar lane, not a LongAgent replacement
- skill compatibility docs include support-level labels
- plugin manifest docs state a bounded local MVP

## Suggested follow-up after this release

After the MVP lands and stabilizes, the next review pass should focus on:

1. whether background/forked-context delegated work needs stronger status UX
2. whether imported skill metadata should surface in slash-command discovery/help output
3. whether plugin package precedence rules need namespacing rather than override behavior
