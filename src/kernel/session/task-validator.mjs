import { exec as execCb, execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { access, readFile } from "node:fs/promises"
import path from "node:path"

const exec = promisify(execCb)
const execFile = promisify(execFileCb)

async function fileExists(p) {
  try { await access(p); return true } catch { return false }
}

export class TaskValidator {
  constructor({ cwd, configState }) {
    this.cwd = cwd
    this.configState = configState
  }

  async checkTodoCompletion(todoState) {
    if (!todoState || !Array.isArray(todoState)) {
      return {
        passed: true,
        message: "No todo list found"
      }
    }

    const incomplete = todoState.filter(t => t.status !== "completed")
    if (incomplete.length === 0) {
      return {
        passed: true,
        message: "All todo items completed"
      }
    }

    const items = incomplete.map(t => `- ${t.content}`).join("\n")
    return {
      passed: false,
      message: `Incomplete todo items:\n${items}`
    }
  }

  async checkJavaScriptSyntax() {
    const jsFiles = await this.findFilesByExtension(["js", "mjs", "cjs"])
    if (jsFiles.length === 0) {
      return {
        passed: true,
        message: "No JavaScript files to check"
      }
    }

    const errors = []
    for (const file of jsFiles.slice(0, 20)) {
      try {
        await execFile("node", ["--check", file], { cwd: this.cwd, timeout: 10000 })
      } catch (error) {
        errors.push(`${file}: ${(error.stderr || error.message || "").trim()}`)
      }
    }

    return {
      passed: errors.length === 0,
      message: errors.length === 0 ? "JavaScript syntax check passed" : `JavaScript syntax errors:\n${errors.join("\n")}`
    }
  }

  async checkTypeScript() {
    const tsconfigPath = path.join(this.cwd, "tsconfig.json")
    if (!(await fileExists(tsconfigPath))) {
      return {
        passed: true,
        message: "No tsconfig.json found"
      }
    }

    try {
      await exec("npx tsc --noEmit", {
        cwd: this.cwd,
        timeout: 30000
      })
      return {
        passed: true,
        message: "TypeScript check passed"
      }
    } catch (error) {
      const output = (error.stdout || error.stderr || "").trim()
      return {
        passed: false,
        message: `TypeScript errors:\n${output.slice(0, 2000)}`
      }
    }
  }

  async checkPythonSyntax() {
    const pyFiles = await this.findFilesByExtension(["py"])
    if (pyFiles.length === 0) {
      return {
        passed: true,
        message: "No Python files to check"
      }
    }

    const errors = []
    for (const file of pyFiles.slice(0, 20)) {
      try {
        await execFile("python", ["-m", "py_compile", file], { cwd: this.cwd, timeout: 10000 })
      } catch (error) {
        errors.push(`${file}: ${(error.stderr || error.message || "").trim()}`)
      }
    }

    return {
      passed: errors.length === 0,
      message: errors.length === 0 ? "Python syntax check passed" : `Python syntax errors:\n${errors.join("\n")}`
    }
  }

  async runTests() {
    const packageJsonPath = path.join(this.cwd, "package.json")
    if (!(await fileExists(packageJsonPath))) {
      return {
        passed: true,
        message: "No package.json found"
      }
    }

    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"))
      const hasTestScript = packageJson.scripts?.test
      if (!hasTestScript) {
        return {
          passed: true,
          message: "No test script found"
        }
      }

      await exec("npm test", {
        cwd: this.cwd,
        timeout: 120000
      })
      return {
        passed: true,
        message: "Tests passed"
      }
    } catch (error) {
      const output = (error.stdout || error.stderr || "").trim()
      return {
        passed: false,
        message: `Test failures:\n${output.slice(0, 2000)}`
      }
    }
  }

  async findFilesByExtension(extensions) {
    const files = []
    for (const ext of extensions) {
      try {
        const matches = await this.globPattern(`**/*.${ext}`)
        files.push(...matches)
      } catch {
      }
    }
    return files
  }

  async globPattern(pattern) {
    try {
      const { Glob } = await import("glob")
      const g = new Glob(pattern, {
        cwd: this.cwd,
        ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"]
      })
      const matches = []
      for await (const match of g) {
        matches.push(path.join(this.cwd, match))
      }
      return matches
    } catch {
      return []
    }
  }

  async checkBuild() {
    const packageJsonPath = path.join(this.cwd, "package.json")
    if (!(await fileExists(packageJsonPath))) {
      return { passed: true, message: "No package.json found", severity: "skip" }
    }
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"))
      if (!pkg.scripts?.build) {
        return { passed: true, message: "No build script", severity: "skip" }
      }
      await exec("npm run build --silent", { cwd: this.cwd, timeout: 60000 })
      return { passed: true, message: "Build succeeded", severity: "pass" }
    } catch (error) {
      const output = (error.stdout || error.stderr || "").trim()
      return { passed: false, message: `Build failed:\n${output.slice(0, 1500)}`, severity: "critical" }
    }
  }

  async checkLint() {
    const packageJsonPath = path.join(this.cwd, "package.json")
    if (!(await fileExists(packageJsonPath))) {
      return { passed: true, message: "No package.json found", severity: "skip" }
    }
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"))
      if (!pkg.scripts?.lint) {
        return { passed: true, message: "No lint script", severity: "skip" }
      }
      await exec("npm run lint --silent", { cwd: this.cwd, timeout: 30000 })
      return { passed: true, message: "Lint passed", severity: "pass" }
    } catch (error) {
      const output = (error.stdout || error.stderr || "").trim()
      return { passed: false, message: `Lint issues:\n${output.slice(0, 1500)}`, severity: "warning" }
    }
  }

  async validate({ todoState, level = "standard" }) {
    const results = []

    const todoResult = await this.checkTodoCompletion(todoState)
    results.push({ name: "Todo", ...todoResult, severity: todoResult.passed ? "pass" : "critical" })

    const jsResult = await this.checkJavaScriptSyntax()
    results.push({ name: "JS Syntax", ...jsResult, severity: jsResult.passed ? "pass" : "critical" })

    if (level !== "quick") {
      const tsResult = await this.checkTypeScript()
      results.push({ name: "TypeScript", ...tsResult, severity: tsResult.passed ? "pass" : "critical" })

      const buildResult = await this.checkBuild()
      results.push({ name: "Build", ...buildResult })

      const testResult = await this.runTests()
      results.push({ name: "Tests", ...testResult, severity: testResult.passed ? "pass" : "critical" })
    }

    if (level === "strict") {
      const lintResult = await this.checkLint()
      results.push({ name: "Lint", ...lintResult })

      const pyResult = await this.checkPythonSyntax()
      results.push({ name: "Python", ...pyResult, severity: pyResult.passed ? "pass" : "warning" })
    }

    const critical = results.filter(r => !r.passed && r.severity === "critical").length
    const warnings = results.filter(r => !r.passed && r.severity === "warning").length
    const verdict = critical > 0 ? "BLOCK" : warnings > 0 ? "WARNING" : "APPROVE"
    const allPassed = verdict !== "BLOCK"

    const lines = [
      "VERIFICATION REPORT",
      "===================",
      ...results.map(r => `${r.passed ? "PASS" : "FAIL"} ${r.name}: ${r.message}`),
      "",
      `VERDICT: ${verdict}`,
      `CRITICAL: ${critical}  WARNING: ${warnings}`,
      allPassed ? "Ready to proceed." : "Must fix critical issues before proceeding."
    ]

    return { passed: allPassed, verdict, results, message: lines.join("\n") }
  }
}

export async function createValidator({ cwd, configState }) {
  return new TaskValidator({ cwd, configState })
}
