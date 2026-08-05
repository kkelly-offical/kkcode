import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const WORKFLOWS = ["release.yml", "verify.yml"]

/**
 * 官方 action 的最低大版本。v7 起 actions/* 原生跑 Node 24（且改为 ESM）；
 * v4 是 Node 20 target，已被 runner 弃用。
 */
const MIN_ACTION_MAJOR = 7

function readWorkflow(name) {
  return readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")
}

for (const workflow of WORKFLOWS) {
  /**
   * 0.9.1 之前这条断言检查的是 `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` ——
   * 一个把 Node 20 的 action 强行拉到 Node 24 的 workaround。action 升到 v7
   * 之后 workaround 失去意义并被移除，于是断言改为守护它背后的**意图**：
   * 没有任何 action 退回 Node 20 的版本。
   *
   * 扫描全部 `uses:` 而不是手写一份 action 清单 —— 手写的那种在有人新增
   * action 时会静默失效。
   */
  test(`${workflow} pins every official action to a Node 24 runtime`, async () => {
    const text = await readWorkflow(workflow)
    const uses = [...text.matchAll(/uses:\s*(actions\/[\w-]+)@v(\d+)/g)]

    // 正则失配会让下面的循环零次执行、断言对着空气成立。先钉死「确实扫到了」。
    assert.ok(uses.length > 0, `${workflow} 里一个 actions/* 都没扫到 —— 正则失配比真的没有 action 更可能`)

    for (const [, action, major] of uses) {
      assert.ok(
        Number(major) >= MIN_ACTION_MAJOR,
        `${workflow}: ${action}@v${major} 低于 v${MIN_ACTION_MAJOR}，会退回已弃用的 Node 20 运行时`
      )
    }
  })

  test(`${workflow} no longer carries the obsolete Node 24 force flag`, async () => {
    const text = await readWorkflow(workflow)
    assert.doesNotMatch(
      text,
      /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/,
      "action 升到 v7 后这个 env 不再有任何作用 —— 留着会让人以为它还在兜底"
    )
  })
}

test("release workflow publishes with the npm-release environment token", async () => {
  const text = await readWorkflow("release.yml")
  assert.match(text, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/)
  assert.match(text, /npm publish --access public --tag "\$DIST_TAG"/)
  assert.doesNotMatch(text, /id-token:\s*write/)
  assert.doesNotMatch(text, /npm publish[^\n]*--provenance/)
})
