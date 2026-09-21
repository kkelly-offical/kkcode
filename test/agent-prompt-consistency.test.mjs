import test from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PROMPT_DIRS = [
  path.join(ROOT, "src", "kernel", "agent", "prompt"),
  path.join(ROOT, "src", "kernel", "session", "prompt"),
  path.join(ROOT, "src", "kernel", "tool", "prompt")
]

async function promptCorpus() {
  const files = []
  for (const dir of PROMPT_DIRS) {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".txt")) continue
      files.push({ name: `${path.basename(path.dirname(dir))}/${name}`, text: await readFile(path.join(dir, name), "utf8") })
    }
  }
  return files
}

test("the large-write rule has exactly one canonical wording across all prompts", async () => {
  const corpus = await promptCorpus()
  // G1: three contradictory rules coexisted ("ALL content in a single call" vs
  // "append to build incrementally" vs "never write a large file in one call").
  const legacyContradictions = corpus.filter(({ text }) =>
    /Never attempt to write an entire large file in a single tool call/i.test(text)
    || /write no more than 200 lines per tool call/i.test(text)
  )
  assert.deepEqual(legacyContradictions.map((f) => f.name), [])

  const canonical = corpus.filter(({ text }) => /genuinely too large for a single call|genuinely too large for one call/i.test(text))
  assert.ok(canonical.length >= 1 && canonical.length <= 3, `canonical chunking rule should live in write.txt (+ at most the strategy block/agent prompt), found in: ${canonical.map((f) => f.name).join(", ")}`)
})

test("the tool-selection list and git protocol each live in exactly one prompt file", async () => {
  const corpus = await promptCorpus()
  // G2: both rules used to be copied into 3-5 files each, and the copies had
  // already drifted apart.
  const selectionRules = corpus.filter(({ text }) => /not style preferences/i.test(text)).map((f) => f.name)
  assert.deepEqual(selectionRules, ["tool/bash.txt"], "tool-selection rationale lives only in bash.txt")

  const gitProtocol = corpus.filter(({ text }) => /Co-Authored-By/.test(text)).map((f) => f.name)
  assert.deepEqual(gitProtocol, ["tool/bash.txt"], "git commit protocol lives only in bash.txt")
})

test("provider prompts stay provider-scoped (identity, tone, verification) and delegate workflow rules", async () => {
  const corpus = await promptCorpus()
  for (const name of ["session/beast.txt", "session/qwen.txt", "session/anthropic.txt"]) {
    const file = corpus.find((f) => f.name === name)
    assert.ok(file, `${name} exists`)
    assert.ok(!/CRITICAL — tool selection rules|Codebase exploration discipline/i.test(file.text), `${name} must not re-carry workflow rule lists`)
    assert.match(file.text, /canonical/i, `${name} points at the canonical copies`)
  }
})
