import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { access, readFile } from "node:fs/promises"
import path from "node:path"

const exec = promisify(execCb)

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
        const content = await readFile(file, "utf8")
        new Function(content)
      } catch (error) {
        errors.push(`${file}: ${error.message}`)
      }
    }

    if (errors.length === 0) {
      return {
        passed: true,
        message: "JavaScript syntax check passed"
      }
    }

    return {
      passed: false,
      message: `JavaScript syntax errors:\n${errors.join("\n")}`
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

    try {
      await exec("python -m py_compile", {
        cwd: this.cwd,
        timeout: 30000
      })
      return {
        passed: true,
        message: "Python syntax check passed"
      }
    } catch (error) {
      const output = (error.stdout || error.stderr || "").trim()
      return {
        passed: false,
        message: `Python syntax errors:\n${output.slice(0, 2000)}`
      }
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

  async validate({ todoState }) {
    const results = []

    const todoResult = await this.checkTodoCompletion(todoState)
    results.push({ name: "Todo Check", ...todoResult })

    const jsResult = await this.checkJavaScriptSyntax()
    results.push({ name: "JavaScript Syntax", ...jsResult })

    const tsResult = await this.checkTypeScript()
    results.push({ name: "TypeScript Check", ...tsResult })

    const testResult = await this.runTests()
    results.push({ name: "Test Run", ...testResult })

    const allPassed = results.every(r => r.passed)
    const messages = results.map(r => `${r.passed ? "✅" : "❌"} ${r.name}: ${r.message}`).join("\n")

    return {
      passed: allPassed,
      results,
      message: messages
    }
  }
}

export async function createValidator({ cwd, configState }) {
  return new TaskValidator({ cwd, configState })
}
