import { readFile, access, readdir } from "node:fs/promises"
import path from "node:path"
import { loadKnowledge } from "../knowledge/loader.mjs"

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")) } catch { return null }
}

async function readText(file) {
  try { return (await readFile(file, "utf8")).trim() } catch { return null }
}

// ── JS/TS ecosystem detection ──

function detectFramework(deps) {
  if (!deps) return null
  if (deps.next) return { name: "next", version: deps.next }
  if (deps.nuxt) return { name: "nuxt", version: deps.nuxt }
  if (deps["@sveltejs/kit"]) return { name: "sveltekit", version: deps["@sveltejs/kit"] }
  if (deps.svelte) return { name: "svelte", version: deps.svelte }
  if (deps["@angular/core"]) return { name: "angular", version: deps["@angular/core"] }
  if (deps.astro) return { name: "astro", version: deps.astro }
  if (deps["solid-js"]) return { name: "solid", version: deps["solid-js"] }
  if (deps.vue) return { name: "vue", version: deps.vue }
  if (deps.react && deps["react-native"]) return { name: "react-native", version: deps["react-native"] }
  if (deps.react) return { name: "react", version: deps.react }
  if (deps.electron) return { name: "electron", version: deps.electron }
  return null
}

function detectBuildTool(devDeps) {
  if (!devDeps) return null
  if (devDeps.vite) return "vite"
  if (devDeps["@rspack/core"]) return "rspack"
  if (devDeps.esbuild) return "esbuild"
  if (devDeps.turbopack || devDeps["@vercel/turbopack"]) return "turbopack"
  if (devDeps.webpack) return "webpack"
  if (devDeps.rollup) return "rollup"
  return null
}

async function detectPackageManager(cwd) {
  if (await exists(path.join(cwd, "bun.lockb")) || await exists(path.join(cwd, "bun.lock"))) return "bun"
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn"
  if (await exists(path.join(cwd, "package-lock.json"))) return "npm"
  return null
}

async function detectLanguage(cwd) {
  if (await exists(path.join(cwd, "tsconfig.json"))) return "typescript"
  if (await exists(path.join(cwd, "jsconfig.json"))) return "javascript"
  return "javascript"
}

function detectProjectType(pkg, framework) {
  if (!pkg) return null
  if (pkg.workspaces) return "monorepo"
  const hasServer = !!(pkg.dependencies?.express || pkg.dependencies?.fastify || pkg.dependencies?.koa || pkg.dependencies?.hono || pkg.dependencies?.["@nestjs/core"])
  const hasFrontend = !!framework
  if (hasServer && hasFrontend) return "fullstack"
  if (hasServer) return "backend"
  if (hasFrontend) return "frontend"
  if (pkg.main || pkg.exports) return "library"
  return null
}

/** Detect extra features from JS deps for knowledge loading */
function detectFeatures(allDeps) {
  const features = []
  if (allDeps.tailwindcss) features.push("tailwind")
  if (allDeps.graphql || allDeps["@apollo/server"] || allDeps["@apollo/client"]) features.push("graphql")
  if (allDeps.electron) features.push("electron")
  if (allDeps["react-native"]) features.push("react-native")
  return features
}

/** Detect CSS framework used in the project */
function detectCssFramework(allDeps) {
  if (allDeps.tailwindcss) return "tailwind"
  if (allDeps.unocss || allDeps["@unocss/core"]) return "unocss"
  if (allDeps["styled-components"]) return "styled-components"
  if (allDeps["@emotion/react"]) return "emotion"
  if (allDeps.sass || allDeps["sass-loader"]) return "sass"
  return null
}

/** Detect UI component library */
function detectComponentLib(allDeps) {
  if (allDeps["@shadcn/ui"] || allDeps["shadcn-ui"]) return "shadcn/ui"
  if (allDeps["antd"]) return "antd"
  if (allDeps["element-plus"]) return "element-plus"
  if (allDeps["@mui/material"]) return "mui"
  if (allDeps["@chakra-ui/react"]) return "chakra-ui"
  if (allDeps["@radix-ui/react-dialog"] || allDeps["@radix-ui/themes"]) return "radix"
  if (allDeps["@headlessui/react"]) return "headless-ui"
  if (allDeps["@mantine/core"]) return "mantine"
  if (allDeps["naive-ui"]) return "naive-ui"
  if (allDeps["vuetify"]) return "vuetify"
  if (allDeps["@arco-design/web-react"] || allDeps["@arco-design/web-vue"]) return "arco-design"
  return null
}

async function detectStructure(cwd) {
  const dirs = []
  try {
    const entries = await readdir(path.join(cwd, "src"), { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(`src/${e.name}/`)
    }
  } catch { /* no src dir */ }
  return dirs.slice(0, 12)
}

function keyDeps(deps, limit = 10) {
  if (!deps) return []
  const skip = new Set(["vue", "react", "react-dom", "next", "nuxt", "svelte", "@angular/core", "solid-js", "astro"])
  return Object.entries(deps)
    .filter(([name]) => !skip.has(name))
    .slice(0, limit)
    .map(([name, ver]) => `${name}@${String(ver).replace(/^[\^~]/, "")}`)
}

// ── Non-JS ecosystem detection ──

async function detectNonJsProject(cwd) {
  // Go
  if (await exists(path.join(cwd, "go.mod"))) {
    const mod = await readText(path.join(cwd, "go.mod"))
    const moduleName = mod?.match(/^module\s+(.+)/m)?.[1] || ""
    const goVer = mod?.match(/^go\s+(.+)/m)?.[1] || ""
    const framework = detectGoFramework(mod)
    const hasTests = await hasGoTests(cwd)
    return buildNonJsContext({
      language: "go", version: goVer, module: moduleName,
      framework, projectType: framework ? "backend" : null,
      hasTests, hasDocker: await exists(path.join(cwd, "Dockerfile")),
      cwd
    })
  }

  // Python
  if (await exists(path.join(cwd, "pyproject.toml")) || await exists(path.join(cwd, "requirements.txt"))) {
    const framework = await detectPythonFramework(cwd)
    const hasTests = await exists(path.join(cwd, "tests")) || await exists(path.join(cwd, "test"))
    return buildNonJsContext({
      language: "python", framework,
      projectType: framework ? "backend" : null,
      hasTests, hasDocker: await exists(path.join(cwd, "Dockerfile")),
      cwd
    })
  }

  // Rust
  if (await exists(path.join(cwd, "Cargo.toml"))) {
    const cargo = await readText(path.join(cwd, "Cargo.toml"))
    const framework = detectRustFramework(cargo)
    return buildNonJsContext({
      language: "rust", framework,
      projectType: framework ? "backend" : null,
      hasTests: true, // Rust has inline tests
      hasDocker: await exists(path.join(cwd, "Dockerfile")),
      cwd
    })
  }

  // Java / Kotlin (Maven or Gradle)
  if (await exists(path.join(cwd, "pom.xml")) || await exists(path.join(cwd, "build.gradle")) || await exists(path.join(cwd, "build.gradle.kts"))) {
    const isKotlin = await exists(path.join(cwd, "build.gradle.kts")) || await exists(path.join(cwd, "src", "main", "kotlin"))
    const lang = isKotlin ? "kotlin" : "java"
    const buildTool = await exists(path.join(cwd, "pom.xml")) ? "maven" : "gradle"
    return buildNonJsContext({
      language: lang, buildTool, framework: "spring",
      projectType: "backend", hasTests: true,
      hasDocker: await exists(path.join(cwd, "Dockerfile")),
      cwd
    })
  }

  // PHP (Composer)
  if (await exists(path.join(cwd, "composer.json"))) {
    const composer = await readJson(path.join(cwd, "composer.json"))
    const isLaravel = !!(composer?.require?.["laravel/framework"])
    return buildNonJsContext({
      language: "php", framework: isLaravel ? "laravel" : null,
      projectType: "backend", hasTests: await exists(path.join(cwd, "tests")),
      hasDocker: await exists(path.join(cwd, "Dockerfile")),
      cwd
    })
  }

  // Ruby
  if (await exists(path.join(cwd, "Gemfile"))) {
    const gemfile = await readText(path.join(cwd, "Gemfile"))
    const isRails = gemfile?.includes("'rails'") || gemfile?.includes('"rails"')
    return buildNonJsContext({
      language: "ruby", framework: isRails ? "rails" : null,
      projectType: isRails ? "backend" : null,
      hasTests: await exists(path.join(cwd, "spec")) || await exists(path.join(cwd, "test")),
      hasDocker: await exists(path.join(cwd, "Dockerfile")),
      cwd
    })
  }

  // Flutter / Dart
  if (await exists(path.join(cwd, "pubspec.yaml"))) {
    const pubspec = await readText(path.join(cwd, "pubspec.yaml"))
    const isFlutter = pubspec?.includes("flutter:")
    return buildNonJsContext({
      language: "dart", framework: isFlutter ? "flutter" : null,
      projectType: "frontend",
      hasTests: await exists(path.join(cwd, "test")),
      hasDocker: false, cwd
    })
  }

  // Swift
  if (await exists(path.join(cwd, "Package.swift")) || await exists(path.join(cwd, "*.xcodeproj"))) {
    return buildNonJsContext({
      language: "swift", framework: null,
      projectType: "frontend", hasTests: false,
      hasDocker: false, cwd
    })
  }

  // C/C++ (CMake or Makefile)
  if (await exists(path.join(cwd, "CMakeLists.txt")) || await exists(path.join(cwd, "Makefile"))) {
    const buildTool = await exists(path.join(cwd, "CMakeLists.txt")) ? "cmake" : "make"
    return buildNonJsContext({
      language: "cpp", buildTool, framework: null,
      projectType: null, hasTests: false,
      hasDocker: await exists(path.join(cwd, "Dockerfile")),
      cwd
    })
  }

  // .NET (C#)
  const csprojFiles = await globSimple(cwd, ".csproj")
  if (csprojFiles.length || await exists(path.join(cwd, "*.sln"))) {
    return buildNonJsContext({
      language: "dotnet", framework: "aspnet",
      projectType: "backend", hasTests: false,
      hasDocker: await exists(path.join(cwd, "Dockerfile")),
      cwd
    })
  }

  return ""
}

function detectGoFramework(modContent) {
  if (!modContent) return null
  if (modContent.includes("github.com/gin-gonic/gin")) return "gin"
  if (modContent.includes("github.com/gofiber/fiber")) return "fiber"
  if (modContent.includes("github.com/labstack/echo")) return "echo"
  return null
}

async function hasGoTests(cwd) {
  try {
    const entries = await readdir(cwd)
    return entries.some(e => e.endsWith("_test.go"))
  } catch { return false }
}

async function detectPythonFramework(cwd) {
  const files = [
    path.join(cwd, "pyproject.toml"),
    path.join(cwd, "requirements.txt")
  ]
  for (const file of files) {
    const content = await readText(file)
    if (!content) continue
    if (content.includes("fastapi")) return "fastapi"
    if (content.includes("django")) return "django"
    if (content.includes("flask")) return "flask"
  }
  return null
}

function detectRustFramework(cargoContent) {
  if (!cargoContent) return null
  if (cargoContent.includes("actix-web")) return "actix"
  if (cargoContent.includes("axum")) return "axum"
  if (cargoContent.includes("rocket")) return "rocket"
  return null
}

/** Simple glob: find files with extension in cwd (non-recursive) */
async function globSimple(cwd, ext) {
  try {
    const entries = await readdir(cwd)
    return entries.filter(e => e.endsWith(ext))
  } catch { return [] }
}

async function buildNonJsContext({ language, version, module, buildTool, framework, projectType, hasTests, hasDocker }) {
  const lines = ["<project>"]
  lines.push(`  language: ${language}`)
  if (version) lines.push(`  version: ${version}`)
  if (module) lines.push(`  module: ${module}`)
  if (framework) lines.push(`  framework: ${framework}`)
  if (buildTool) lines.push(`  build_tool: ${buildTool}`)
  if (projectType) lines.push(`  type: ${projectType}`)
  if (hasDocker) lines.push(`  docker: true`)
  lines.push("</project>")

  const knowledge = await loadKnowledge({
    framework: framework || null,
    language,
    projectType,
    hasTests: !!hasTests,
    features: hasDocker ? ["docker"] : []
  })

  if (knowledge) {
    lines.push("")
    lines.push(knowledge)
  }

  return lines.join("\n")
}

// ── Main entry ──

/**
 * Detect project context from cwd. Returns formatted string for system prompt injection,
 * or empty string if no project detected.
 */
export async function detectProjectContext(cwd) {
  // Try JS/TS ecosystem first
  const pkgPath = path.join(cwd, "package.json")
  const pkg = await readJson(pkgPath)

  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const framework = detectFramework(allDeps)
    const buildTool = detectBuildTool(pkg.devDependencies || {})
    const features = detectFeatures(allDeps)
    const [packageManager, language, structure] = await Promise.all([
      detectPackageManager(cwd),
      detectLanguage(cwd),
      detectStructure(cwd)
    ])
    const projectType = detectProjectType(pkg, framework)
    const scripts = pkg.scripts || {}
    const deps = keyDeps(pkg.dependencies)

    const lines = ["<project>"]
    if (framework) {
      const ver = String(framework.version || "").replace(/^[\^~]/, "")
      const fwLabel = buildTool ? `${framework.name} ${ver} (with ${buildTool})` : `${framework.name} ${ver}`
      lines.push(`  framework: ${fwLabel}`)
    }
    lines.push(`  language: ${language}`)
    if (packageManager) lines.push(`  package_manager: ${packageManager}`)
    const pm = packageManager || "npm"
    if (scripts.build) lines.push(`  build: ${pm} run build`)
    if (scripts.dev) lines.push(`  dev: ${pm} run dev`)
    if (scripts.test) lines.push(`  test: ${pm} run test`)
    if (scripts.lint) lines.push(`  lint: ${pm} run lint`)
    if (deps.length) lines.push(`  key_deps: ${deps.join(", ")}`)
    if (structure.length) lines.push(`  structure: ${structure.join(", ")}`)
    if (projectType) lines.push(`  type: ${projectType}`)
    if (features.length) lines.push(`  features: ${features.join(", ")}`)
    const cssFramework = detectCssFramework(allDeps)
    if (cssFramework) lines.push(`  css_framework: ${cssFramework}`)
    const componentLib = detectComponentLib(allDeps)
    if (componentLib) lines.push(`  component_lib: ${componentLib}`)
    const hasDocker = await exists(path.join(cwd, "Dockerfile"))
    if (hasDocker) lines.push(`  docker: true`)
    lines.push("</project>")

    // Load matching knowledge (Tier 1 + Tier 2)
    const knowledge = await loadKnowledge({
      framework: framework?.name || null,
      language,
      projectType,
      hasTests: !!scripts.test,
      features: [...features, ...(hasDocker ? ["docker"] : [])]
    })

    if (knowledge) {
      lines.push("")
      lines.push(knowledge)
    }

    return lines.join("\n")
  }

  // Try non-JS ecosystems
  return detectNonJsProject(cwd)
}
