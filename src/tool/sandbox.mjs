/**
 * OS 级 sandbox —— 模型侧 bash 的第三层防护。
 *
 * 前两层是审批（permission）与声明式规则 + mutation-guard，它们都在 kkcode
 * 进程内判断「这条命令该不该跑」。问题是判断的对象是命令**文本**：一旦命令
 * 跑起来，它写哪、连哪，进程内的规则一律看不见（`make install`、
 * `python setup.py`、任意脚本里的第二跳全都是盲区）。这一层把边界下沉到内核：
 * 工作区之外整个文件系统只读，网络可选断开，越界由 OS 拒绝而不是靠我们猜。
 *
 * 三条硬约束：
 * 1. **opt-in**：默认 off。0.8.1 是 patch 版本，不能改变现有用户的执行行为。
 * 2. **只包模型侧 bash**：`!` 直通（repl/shell-passthrough.mjs）是用户自己敲的
 *    命令，永远不包。
 * 3. **不静默回落**：包装成功就是包装成功，bwrap 起不来就把错误原样透出。
 *    「以为在沙箱里跑，其实没有」比「没有沙箱」危险得多。
 *
 * 本模块除 probe 外全是纯函数：Windows/macOS 形态在 Linux 上喂数据即可测
 * （见 test/tool-sandbox.test.mjs）—— Windows 分歧已经栽过四次，不再靠真机。
 */

import os from "node:os"
import path from "node:path"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { userRootDir } from "../storage/paths.mjs"

const execFile = promisify(execFileCb)

export const SANDBOX_BACKENDS = Object.freeze(["bwrap", "sandbox-exec", "none"])

/** probe 超时：探测本身卡住的话，整个 bash 工具就跟着卡住了 */
const PROBE_TIMEOUT_MS = 5000

/**
 * 后端选择。纯函数 —— 探测（hasBwrap）由调用方注入，这样平台矩阵可以在
 * 任意一台机器上测全。
 */
export function resolveSandboxBackend({
  platform = process.platform,
  hasBwrap = false,
  // sandbox-exec 是 macOS 自带的（虽被标记 deprecated，至今仍可用），
  // 所以默认 true；留个开关是为了让「macOS 上它不在」这一支也可测。
  hasSandboxExec = true
} = {}) {
  if (platform === "linux") return hasBwrap ? "bwrap" : "none"
  if (platform === "darwin") return hasSandboxExec ? "sandbox-exec" : "none"
  return "none"
}

/**
 * 归一可写目录：去空、绝对化、去重，顺序保持调用方给的优先级。
 * 去重不是洁癖 —— 参数表是要逐条断言的，重复的 --bind 会让断言随环境漂移
 * （比如 KKCODE_HOME 被指到工作区里的时候）。
 */
function normalizeDirs(dirs = []) {
  const seen = new Set()
  const out = []
  for (const dir of dirs) {
    if (!dir) continue
    const resolved = path.resolve(String(dir))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}

/**
 * 组装沙箱化的执行形态。返回 { command, args }，或 null 表示「没有沙箱，
 * 走原路径」。
 *
 * 返回数组而不是字符串：命令文本原样作为 `sh -c` 的**一个 argv**传下去，
 * 不参与任何拼接，所以命令里的引号、`$`、换行都不需要转义 —— 字符串拼接
 * 方案在这里必然出事。
 *
 * shell 默认 /bin/sh 而不是 bash：node 的 exec() 在 POSIX 上就是用 /bin/sh，
 * 保持一致才能让「开沙箱」只改变隔离性、不改变 shell 方言（否则 `[[ ]]`
 * 之类会出现「开沙箱能跑、关沙箱报错」的诡异分歧），而且 /bin/sh 在任何
 * 发行版都在。
 */
export function buildSandboxedCommand({
  backend = "none",
  command = "",
  workspaceDir = "",
  tmpDir = os.tmpdir(),
  homeStateDir = userRootDir(),
  extraWritableDirs = [],
  network = true,
  shell = "/bin/sh"
} = {}) {
  const text = String(command || "")
  if (!text.trim()) return null
  const writable = normalizeDirs([workspaceDir, tmpDir, homeStateDir, ...extraWritableDirs])

  if (backend === "bwrap") {
    const args = [
      // 整个根只读 bind：默认拒绝写，可写目录随后逐个 bind 覆盖回来
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc"
    ]
    for (const dir of writable) args.push("--bind", dir, dir)
    // --unshare-pid：沙箱里看不到宿主进程，也就 kill 不到
    // --die-with-parent：kkcode 被杀时沙箱不留孤儿进程
    args.push("--unshare-pid", "--die-with-parent")
    if (!network) args.push("--unshare-net")
    args.push(shell, "-c", text)
    return { command: "bwrap", args }
  }

  if (backend === "sandbox-exec") {
    const profile = buildSandboxExecProfile({ writableDirs: writable, network })
    return { command: "sandbox-exec", args: ["-p", profile, shell, "-c", text] }
  }

  return null
}

function quoteProfilePath(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`
}

/**
 * macOS sandbox-exec 的 profile 文本。
 *
 * profile 语言是「后匹配的规则覆盖先匹配的」，所以顺序是
 * allow default → deny file-write* → allow 指定 subpath → （可选）deny network*。
 *
 * 注意：subpath 必须是**真实路径**。macOS 上 /tmp 与 /var 都是符号链接
 * （→ /private/tmp、/private/var），传软链进来的话规则不会命中，写入照样被拒。
 * 解析交给调用方（registry 那边 realpath 过），这里保持纯函数。
 */
export function buildSandboxExecProfile({ writableDirs = [], network = true } = {}) {
  const dirs = normalizeDirs(writableDirs)
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)"
  ]
  if (dirs.length) {
    lines.push("(allow file-write*")
    for (const dir of dirs) lines.push(`  (subpath ${quoteProfilePath(dir)})`)
    lines.push(")")
  }
  // /dev/null 之类不放行的话，`cmd > /dev/null` 这种最常见的写法直接失败
  lines.push(
    "(allow file-write-data",
    "  (literal \"/dev/null\")",
    "  (literal \"/dev/zero\")",
    "  (literal \"/dev/random\")",
    "  (literal \"/dev/urandom\")",
    "  (literal \"/dev/stdout\")",
    "  (literal \"/dev/stderr\")",
    "  (literal \"/dev/tty\")",
    ")"
  )
  if (!network) lines.push("(deny network*)")
  return lines.join("\n")
}

let supportCache = null

export function resetSandboxSupportCache() {
  supportCache = null
}

/**
 * bwrap 可用性探测：不看「文件在不在」，而是真跑一次最小沙箱。
 * 二进制存在但内核禁用了非特权 user namespace（Debian 的
 * kernel.unprivileged_userns_clone=0 等）时，前者会给出错误答案，
 * 而错误答案的代价是用户以为自己在沙箱里。
 */
export async function probeBwrap({ exec = execFile } = {}) {
  try {
    await exec(
      "bwrap",
      ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--die-with-parent", "/bin/true"],
      { timeout: PROBE_TIMEOUT_MS }
    )
    return true
  } catch {
    return false
  }
}

/**
 * 平台能力探测，进程内缓存 —— 每次 bash 调用都 spawn 一次探测太贵。
 * 测试用 force / resetSandboxSupportCache 绕开缓存。
 */
export async function probeSandboxSupport({
  platform = process.platform,
  probe = probeBwrap,
  force = false
} = {}) {
  if (!force && supportCache) return supportCache
  const hasBwrap = platform === "linux" ? await probe() : false
  const support = { hasBwrap, hasSandboxExec: platform === "darwin" }
  if (!force) supportCache = support
  return support
}

/**
 * 面向展示的状态归一：/status 与 doctor 共用同一套词汇，
 * 免得两处各说各话。
 */
export function describeSandboxStatus({
  config = null,
  platform = process.platform,
  hasBwrap = false,
  hasSandboxExec = true
} = {}) {
  const raw = readSandboxConfig(config)
  if (raw.mode !== "auto") {
    return { mode: raw.mode, backend: "none", network: raw.network, status: "off", available: false }
  }
  const backend = resolveSandboxBackend({ platform, hasBwrap, hasSandboxExec })
  if (backend === "none") {
    return {
      mode: "auto",
      backend: "none",
      network: raw.network,
      status: "auto-but-unavailable",
      available: false,
      reason: platform === "linux"
        ? "bwrap not available (install bubblewrap, or the kernel disallows unprivileged user namespaces)"
        : `no sandbox backend on ${platform}`
    }
  }
  return { mode: "auto", backend, network: raw.network, status: backend, available: true }
}

/** 探测 + 归一，给 doctor / status 面板一次调用拿全 */
export async function inspectSandboxStatus(config = null, { platform = process.platform } = {}) {
  const raw = readSandboxConfig(config)
  // mode=off 时不探测：省掉一次 spawn，而且「没开」的展示不需要知道后端在不在
  if (raw.mode !== "auto") return describeSandboxStatus({ config, platform })
  const support = await probeSandboxSupport({ platform })
  return describeSandboxStatus({ config, platform, hasBwrap: support.hasBwrap, hasSandboxExec: support.hasSandboxExec })
}

/**
 * 读配置。形状是 permission.sandbox = { mode: "off"|"auto", network: bool }。
 * 任何认不出来的 mode 一律当 off —— 沙箱这种东西，读不懂的配置只能往严
 * （不跑）或往现状（不包）落，往「以为包了」落是最坏的。
 */
export function readSandboxConfig(config = null) {
  const raw = config?.permission?.sandbox
  const mode = raw?.mode === "auto" ? "auto" : "off"
  const network = raw?.network !== false
  const writableDirs = Array.isArray(raw?.writable_dirs)
    ? raw.writable_dirs.filter((item) => typeof item === "string" && item.trim())
    : []
  return { mode, network, writableDirs }
}

/**
 * 把 `~` 与相对路径落成绝对路径。相对路径按工作区解 —— 配置里写
 * `node_modules/.cache` 时，用户想的显然是工作区里的那个。
 */
export function resolveWritableDir(entry, { workspaceDir = process.cwd(), homeDir = os.homedir() } = {}) {
  const text = String(entry || "").trim()
  if (!text) return ""
  if (text === "~") return homeDir
  if (text.startsWith("~/")) return path.join(homeDir, text.slice(2))
  return path.resolve(workspaceDir, text)
}

let unavailableNoticeShown = false

export function resetSandboxNotices() {
  unavailableNoticeShown = false
}

/**
 * 「想开但开不了」的提示：每进程只发一次。
 *
 * 取舍：这行提示是给模型看的（它需要知道自己**没有**被隔离，否则会按
 * 沙箱假设去解释后续报错），但每条命令都带一行就是纯粹烧 token —— 同一个
 * 会话里后端不会中途变可用。所以首次发一次，之后沉默。
 */
export function takeSandboxUnavailableNotice(status) {
  if (!status || status.status !== "auto-but-unavailable") return ""
  if (unavailableNoticeShown) return ""
  unavailableNoticeShown = true
  return `[sandbox] requested (mode=auto) but unavailable: ${status.reason}. Command ran WITHOUT OS-level isolation.`
}

/**
 * 单行状态文案，doctor 与 /status 共用一份 —— 两处各写各的话，用户就得
 * 自己判断「面板说 on、doctor 说 unavailable」到底哪个算数。
 */
export function formatSandboxLine(status = null) {
  if (!status || status.status === "off") return "sandbox: off (bash runs unsandboxed)"
  if (status.status === "auto-but-unavailable") {
    return `sandbox: auto-but-unavailable — ${status.reason || "no backend"}`
  }
  return `sandbox: ${status.backend} network=${status.network ? "on" : "off"}`
}

/** 沙箱内命令失败时补的解释行：EROFS/EACCES 在沙箱里是预期行为，不是环境坏了 */
export function sandboxFailureHint({ backend, network, writableDirs = [] }) {
  const roots = writableDirs.length ? writableDirs.join(", ") : "(none)"
  return `[sandbox] active (${backend}, network=${network ? "on" : "off"}): writes are allowed only under ${roots}`
}
