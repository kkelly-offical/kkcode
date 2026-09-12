/**
 * src/kernel/index.mjs —— 内核白名单 facade
 * （docs/architecture-kernel-sdk-1.0.0.md §4.2.1）。
 *
 * 只再导出 §4 定义的 API 面入口；内核其余文件一律视为私有，
 * frontends 只允许 import 本文件（与 src/sdk/），禁止 deep-import。
 */
export { createKernel } from "./kernel.mjs"
