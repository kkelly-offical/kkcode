/**
 * 永不自动放行的路径。
 *
 * 这些位置的写入是**唯一一类无法靠 git 回滚补救**的操作：
 *   - `.git` 被改坏 = 快照系统本身失效，git_snapshot / git_restore 一起报废
 *   - shell rc（`.bashrc`、`.zshrc`、`.envrc`…）影响的是 agent 之外的宿主环境
 *   - 包管理器配置（`.npmrc`、`.yarnrc`、`bunfig.toml`）能改变后续安装的来源
 *   - 钩子配置（`.pre-commit-config.yaml`、`lefthook`）会在别人的机器上执行
 *   - `.kkcode` / `.mcp.json` 是 kkcode 自己的治理面，能改它就能自我提权
 *
 * 清单与判定顺序都抄 Claude Code —— 五家里只有它把这件事写成了成文规则。
 *
 * **顺序是关键**：保护检查必须排在用户 allow 规则求值之前。否则仓库里
 * checked-in 的一条 `{tool: "write", pattern: ".git/**", action: "allow"}`
 * 就能把整套保护绕掉 —— 而那条规则可能来自你刚 clone 的别人的仓库。
 */

/** 目录：命中即整棵子树受保护 */
const PROTECTED_DIRS = Object.freeze([
  ".git",
  ".config/git",
  ".kkcode",
  ".github/workflows",
  ".husky",
  ".vscode",
  ".idea",
  ".devcontainer",
  ".cargo",
  ".yarn"
])

/** 文件：精确名（可在任意层级） */
const PROTECTED_FILES = Object.freeze([
  // shell 与环境
  ".bashrc", ".bash_profile", ".bash_login", ".profile",
  ".zshrc", ".zprofile", ".zshenv", ".zlogin",
  ".envrc",
  // 包管理器：能改变后续安装拉取的来源
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnpmfile.cjs", "bunfig.toml",
  // 构建与钩子：会在别人机器上执行
  ".bazelrc", ".bazelversion",
  ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml",
  "gradle-wrapper.properties", "maven-wrapper.properties",
  // kkcode 自己的治理面
  ".mcp.json", ".kkcode.json",
  // 其他能影响工具行为的
  ".ripgreprc", ".devcontainer.json", "pyrightconfig.json"
])

/**
 * `.kkcode` 下的例外：worktree 是 kkcode 自己创建的隔离副本，
 * 挡住它等于挡住 worktree 隔离本身。
 */
const PROTECTED_DIR_EXCEPTIONS = Object.freeze([".kkcode/worktrees"])

function normalize(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "")
}

/**
 * 这个路径是否受保护。
 *
 * @param {string} filePath 相对工作区的路径（绝对路径也可，只看片段）
 * @returns {{protected: boolean, reason?: string}}
 */
export function checkProtectedPath(filePath) {
  const normalized = normalize(filePath)
  if (!normalized) return { protected: false }

  for (const exception of PROTECTED_DIR_EXCEPTIONS) {
    if (normalized.includes(`${exception}/`) || normalized.endsWith(exception)) {
      return { protected: false }
    }
  }

  const segments = normalized.split("/").filter(Boolean)

  for (const dir of PROTECTED_DIRS) {
    const parts = dir.split("/")
    for (let i = 0; i + parts.length <= segments.length; i++) {
      if (parts.every((part, j) => segments[i + j] === part)) {
        return {
          protected: true,
          reason: `${dir}/ is protected — writes there cannot be undone with git and are never auto-approved`
        }
      }
    }
  }

  const basename = segments.at(-1) || ""
  if (PROTECTED_FILES.includes(basename)) {
    return {
      protected: true,
      reason: `${basename} is protected — it affects the host environment beyond this workspace and is never auto-approved`
    }
  }

  return { protected: false }
}

/**
 * 一次可能写入的调用涉及的所有路径里，有没有受保护的。
 * multiedit 传的是 changes 数组，所以要能吃多个路径。
 */
export function findProtectedTarget(paths = []) {
  for (const candidate of Array.isArray(paths) ? paths : [paths]) {
    const result = checkProtectedPath(candidate)
    if (result.protected) return { path: candidate, ...result }
  }
  return null
}

/**
 * 一条 shell 命令是否可能写入受保护位置。
 *
 * bash 是绕过所有路径校验的那条路 —— `echo x >> ~/.bashrc` 不经过 write 工具，
 * 也不经过 resolveWorkspacePath。这里做的是词法级的粗筛：命令里出现受保护
 * 名字、且看起来在写（重定向 / 已知的写命令），就要人确认。
 *
 * 故意宽松：误判的代价是多一次弹窗，漏判的代价是宿主环境被改且无法回滚。
 * 纯读命令（`cat .bashrc`、`git status`）不该被拦，所以要求「像在写」。
 */
const WRITE_ISH = /(^|\s)(rm|mv|cp|install|tee|truncate|dd|chmod|chown|ln|sed\s+-i|perl\s+-i|python3?\s+-c|node\s+-e)\b|>>?\s*\S/

export function bashTouchesProtected(command) {
  const cmd = String(command || "")
  if (!cmd.trim()) return null
  if (!WRITE_ISH.test(cmd)) return null

  const names = [...PROTECTED_FILES, ...PROTECTED_DIRS]
  for (const name of names) {
    // 词边界：`.git` 不该被 `.gitignore` 命中，`.npmrc` 不该被 `my.npmrcx` 命中
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(^|[\\s"'=/\\\\])${escaped}([\\s"'/\\\\:]|$)`).test(cmd)) {
      return {
        path: name,
        protected: true,
        reason: `this command appears to write to ${name}, which is never auto-approved — writes there cannot be undone with git`
      }
    }
  }
  return null
}

/**
 * 权限层的统一入口：按工具类型选择该查路径还是查命令。
 */
export function findProtectedAccess({ tool, pattern = "", command = "" }) {
  const name = String(tool || "")
  if (name === "bash") return bashTouchesProtected(command)
  if (PATH_WRITING_TOOLS.has(name)) {
    return findProtectedTarget(String(pattern || "").split(","))
  }
  return null
}

/**
 * 会按路径写文件的工具。比 file-edit-policy 的 SENSITIVE_EDIT_TOOLS 多出
 * 文件管理类工具 —— 那些是 0.7.0 阶段 3 新增的，`remove .git` 的破坏力
 * 不比 `write .git/config` 小。
 */
const PATH_WRITING_TOOLS = new Set([
  "write", "edit", "patch", "multiedit", "notebookedit",
  "move", "copy", "remove", "mkdir", "archive",
  "git_apply_patch", "git_restore"
])

export const PROTECTED_PATH_LIST = Object.freeze({
  dirs: PROTECTED_DIRS,
  files: PROTECTED_FILES,
  exceptions: PROTECTED_DIR_EXCEPTIONS
})
