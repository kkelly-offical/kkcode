import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm, access } from "node:fs/promises"
import { runStrictCommand, buildStrictDockerArgs } from "../src/kernel/isolation/docker-executor.mjs"

const image = process.env.KKCODE_OFFICE_TEST_IMAGE
const real = { skip: !image, timeout: 60000 }
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "kk-office-transfer-"))
  const workspace = path.join(base, "workspace"), outside = path.join(base, "outside")
  await mkdir(workspace); await mkdir(outside)
  t.after(() => rm(base, { recursive: true, force: true }))
  return { base, workspace, outside }
}
const prefix = "import sys,os,time;sys.path.insert(0,'/opt/kkcode-office');import transfer as t\n"

test("private transfer mount has explicit independent write permissions", () => {
  const args = buildStrictDockerArgs({ name: "synthetic", token: "synthetic", imageId: `sha256:${"a".repeat(64)}`,
    workspace: "/task", transfer: { workspace: "/private-job" }, transferReadOnly: true, readOnly: false, argv: ["true"] })
  assert.ok(args.includes("type=bind,src=/private-job,dst=/transfer,bind-propagation=rprivate,readonly"))
  assert.ok(args.includes("type=bind,src=/task,dst=/workspace,bind-propagation=rprivate"))
  assert.ok(args.includes("none")); assert.ok(args.includes("no-new-privileges=true"))
})

test("fixed transfer helper pins input parents across a real host symlink swap", real, async t => {
  const { workspace, outside } = await fixture(t)
  await mkdir(path.join(workspace, "input"))
  await writeFile(path.join(workspace, "input", "doc.md"), "inside")
  await writeFile(path.join(outside, "doc.md"), "OUTSIDE CANARY")
  let changed = false, change
  const result = await runStrictCommand({ image, workspaceDir: workspace, transferDir: outside, readOnly: true,
    argv: ["/opt/office-venv/bin/python", "-c", prefix + [
      "root=os.open('/workspace',t.DIRECTORY);held=t.descend(root,['input'])",
      "assert open('/transfer/doc.md').read()=='OUTSIDE CANARY'",
      "print('READY',flush=True)",
      "for _ in range(500):",
      " if os.path.exists('/workspace/go'):break",
      " time.sleep(.01)",
      "assert t.read_file(held,'doc.md')[0]==b'inside'",
      "try:t.read_file(root,'input/doc.md');raise AssertionError('followed attacker symlink')",
      "except OSError:pass",
      "os.close(held);os.close(root);print('SAFE',flush=True)"
    ].join("\n")], onStdout: text => {
      if (!changed && text.includes("READY")) {
        changed = true
        change = (async () => {
          await rename(path.join(workspace, "input"), path.join(workspace, "retired"))
          await symlink("/transfer", path.join(workspace, "input"))
          await writeFile(path.join(workspace, "go"), "go")
        })()
      }
    } })
  await change
  assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout, /SAFE/)
  assert.equal(await readFile(path.join(outside, "doc.md"), "utf8"), "OUTSIDE CANARY")
})

test("fixed publication helper cannot redirect an output to a host canary directory", real, async t => {
  const { workspace, outside } = await fixture(t)
  let changed = false, change
  const result = await runStrictCommand({ image, workspaceDir: workspace, transferDir: outside, transferReadOnly: false,
    argv: ["/opt/office-venv/bin/python", "-c", prefix + [
      "root=os.open('/workspace',t.DIRECTORY);held=t.reserve_directory(root,'deliveries/report')",
      "print('READY',flush=True)",
      "for _ in range(500):",
      " if os.path.exists('/workspace/go'):break",
      " time.sleep(.01)",
      "t.write_file(held,'artifact.md',b'only the pinned directory')",
      "try:t.read_file(root,'deliveries/report/artifact.md');raise AssertionError('followed attacker symlink')",
      "except OSError:pass",
      "os.close(held);os.close(root);print('SAFE',flush=True)"
    ].join("\n")], onStdout: text => {
      if (!changed && text.includes("READY")) {
        changed = true
        change = (async () => {
          await rename(path.join(workspace, "deliveries"), path.join(workspace, "retired"))
          await symlink("/transfer", path.join(workspace, "deliveries"))
          await writeFile(path.join(workspace, "go"), "go")
        })()
      }
    } })
  await change
  assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout, /SAFE/)
  assert.equal(await access(path.join(outside, "report", "artifact.md")).then(() => true, () => false), false)
  assert.equal(await readFile(path.join(workspace, "retired", "report", "artifact.md"), "utf8"), "only the pinned directory")
})

test("transfer job cannot overlap the source workspace", real, async t => {
  const { workspace } = await fixture(t)
  await mkdir(path.join(workspace, "nested"))
  await assert.rejects(runStrictCommand({ image, workspaceDir: workspace, transferDir: path.join(workspace, "nested"), argv: ["true"] }), /必须与任务工作区分离/)
})
