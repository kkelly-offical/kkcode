import { makeEventEnvelope } from "./types.mjs"
import { deprecatedSingletonAlias } from "./deprecations.mjs"

/**
 * EventBus 工厂（1.0.0 阶段 2a）：每个 kernel 实例持有自己的事件总线
 * （listeners/sinks 不再是模块级共享态，M3 §四.2）。
 */
export function createEventBus() {
  const listeners = new Set()
  const sinks = new Set()

  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    registerSink(fn) {
      sinks.add(fn)
      return () => sinks.delete(fn)
    },
    /**
     * 当前监听器数量。诊断与测试用 —— 长跑的编排器（Ultra）会在启动时订阅
     * stop 事件，如果某条返回路径漏了退订就会每跑一次泄漏一个监听器，
     * 而这种泄漏没有别的办法能观察到。
     */
    listenerCount() {
      return listeners.size
    },
    async emit(input) {
      const event = makeEventEnvelope(input)
      for (const sink of sinks) {
        try { await sink(event) } catch (err) {
          console.error("[events] sink error:", err?.message || err)
        }
      }
      for (const fn of listeners) {
        try { await fn(event) } catch (err) {
          console.error("[events] listener error:", err?.message || err)
        }
      }
      return event
    }
  }
}

// 进程级默认实例。阶段 2b 期间 engine/loop 等内核执行路径仍向它发射事件，
// kernel 实例的总线经事件桥从它取流（src/kernel/kernel.mjs）；2c/阶段 3 改
// 为实例注入后，它将只服务旧 import 路径。
export const defaultEventBus = createEventBus()

/**
 * 兼容别名（deprecated）：旧 import 路径继续工作，每次方法调用经
 * deprecations.mjs 记录一次。新代码请用 createKernel() 句柄的 events。
 */
export const EventBus = deprecatedSingletonAlias(
  "kernel.singleton.event-bus",
  "模块级单例 `EventBus` 已收编为 kernel 实例字段：新代码改用 createKernel() 句柄的 `events` 命名空间",
  defaultEventBus
)
