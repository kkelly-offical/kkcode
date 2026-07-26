import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createListenerRegistry } from "../src/repl/listener-registry.mjs"

/**
 * 退出时要摘掉八个进程级监听器。此前挂载散在四处、释放是 `finally` 里十行
 * `if (onX) removeListener(...)` —— 一份必须和挂载保持同步的手写清单。
 * 漏掉一项的后果是进程不退出，或者退出后仍在响应信号。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

test("everything registered gets released", () => {
  const registry = createListenerRegistry()
  const a = new EventEmitter()
  const b = new EventEmitter()
  registry.on(a, "one", () => {})
  registry.on(a, "two", () => {})
  registry.on(b, "three", () => {})
  assert.equal(a.listenerCount("one") + a.listenerCount("two") + b.listenerCount("three"), 3)

  registry.disposeAll()
  assert.equal(a.listenerCount("one"), 0)
  assert.equal(a.listenerCount("two"), 0)
  assert.equal(b.listenerCount("three"), 0)
  assert.equal(registry.size(), 0)
})

test("releasing is idempotent — a second disposeAll is harmless", () => {
  const registry = createListenerRegistry()
  const emitter = new EventEmitter()
  registry.on(emitter, "x", () => {})
  registry.disposeAll()
  assert.doesNotThrow(() => registry.disposeAll())
  assert.equal(emitter.listenerCount("x"), 0)
})

test("a listener released early is not released twice", () => {
  // 提前释放（比如 onProcessExit 在 finally 里被单独摘掉）之后，
  // disposeAll 不该再摘一次别人的同名监听器
  const registry = createListenerRegistry()
  const emitter = new EventEmitter()
  const handler = () => {}
  emitter.on("x", handler)          // 一个不归登记本管的同名监听器
  const release = registry.on(emitter, "x", () => {})
  assert.equal(emitter.listenerCount("x"), 2)
  release()
  release()                          // 重复调用应无害
  assert.equal(emitter.listenerCount("x"), 1, "不该顺带摘掉别人的监听器")
  registry.disposeAll()
  assert.equal(emitter.listenerCount("x"), 1)
})

test("one failing disposer does not block the rest", () => {
  // 退出路径上必须尽力摘干净：一个失败拖住其余的会留下悬挂的监听器
  const registry = createListenerRegistry()
  const emitter = new EventEmitter()
  const broken = {
    on() {},
    removeListener() { throw new Error("boom") }
  }
  registry.on(emitter, "first", () => {})
  registry.on(broken, "bad", () => {})
  registry.on(emitter, "last", () => {})
  assert.doesNotThrow(() => registry.disposeAll())
  assert.equal(emitter.listenerCount("first"), 0)
  assert.equal(emitter.listenerCount("last"), 0)
})

test("registering a null handler is a no-op, not a crash", () => {
  // 平台分支下有些处理器就是 null（win32 没有 SIGTSTP）
  const registry = createListenerRegistry()
  const emitter = new EventEmitter()
  assert.doesNotThrow(() => registry.on(emitter, "x", null))
  assert.equal(registry.size(), 0, "没挂上的东西不该占一个释放项")
})

test("listeners are released in reverse registration order", () => {
  const order = []
  const registry = createListenerRegistry()
  const make = (id) => ({ on() {}, removeListener() { order.push(id) } })
  registry.on(make("first"), "e", () => {})
  registry.on(make("second"), "e", () => {})
  registry.on(make("third"), "e", () => {})
  registry.disposeAll()
  assert.deepEqual(order, ["third", "second", "first"], "后挂的先摘，与挂载顺序对称")
})

// --- 结构性：退出路径不该再手写释放清单 ---

test("the REPL no longer hand-removes one-shot process listeners", async () => {
  const src = await readFile(path.join(ROOT, "src", "repl.mjs"), "utf8")

  // 全文件扫描，不靠定位某个块 —— 上一版这条断言锚在 `  } finally {` 上，
  // 而文件里有两个，indexOf 取到了前一个，于是**空洞通过**（还没改代码就绿了）。
  // 这正是本次拆分中修掉的同一种陷阱。
  const remaining = src.split("\n")
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter(({ line }) => /process(?:\.\w+)?\.removeListener\(/.test(line))
    // 两类例外，都是「反复装卸」而非「挂一次摘一次」：
    //   - keypress / data 随终端激活与挂起来回装卸
    //   - SIGTSTP / SIGCONT 在作业控制里被**有意**临时摘掉：Ctrl+Z 时先摘掉
    //     自己的处理器，把信号按默认行为重发一次，SIGCONT 恢复时再挂回来
    .filter(({ line }) => !/"keypress"|"data"|"SIGTSTP"|"SIGCONT"/.test(line))

  assert.deepEqual(remaining.map((r) => `第 ${r.no} 行: ${r.line}`), [],
    "一次性进程级监听器的释放应交给登记本，而不是手写清单")
})

test("the registry is what the REPL uses to attach them", async () => {
  const src = await readFile(path.join(ROOT, "src", "repl.mjs"), "utf8")
  assert.match(src, /createListenerRegistry\(/, "repl.mjs 应当建立一个登记本")
  // 挂载也必须走登记本 —— 直接 process.on 就是没登记，退出时摘不掉
  const directAttach = src.split("\n")
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter(({ line }) => /^process(?:\.\w+)?\.on\(/.test(line))
    .filter(({ line }) => !/"keypress"|"data"|"SIGTSTP"|"SIGCONT"/.test(line))
  assert.deepEqual(directAttach.map((r) => `第 ${r.no} 行: ${r.line}`), [],
    "这些监听器绕过了登记本，退出时不会被摘掉")
})
