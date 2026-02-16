import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const KNOWLEDGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const cache = new Map()

// Framework → knowledge files mapping
const FRAMEWORK_MAP = {
  vue: ["vue.txt"],
  react: ["react.txt"],
  next: ["next.txt", "react.txt"],
  nuxt: ["nuxt.txt", "vue.txt"],
  sveltekit: ["svelte.txt"],
  svelte: ["svelte.txt"],
  angular: [],
  astro: [],
  solid: [],
  "react-native": ["react-native.txt", "react.txt"],
  electron: ["electron.txt"],
  flutter: ["flutter.txt"],
  laravel: ["php.txt"],
  rails: ["ruby.txt"],
}

// Backend frameworks → language knowledge
const BACKEND_FRAMEWORK_LANG = {
  fastapi: "python.txt",
  django: "python.txt",
  flask: "python.txt",
  gin: "go.txt",
  fiber: "go.txt",
  echo: "go.txt",
  actix: "rust.txt",
  axum: "rust.txt",
  rocket: "rust.txt",
  spring: "java.txt",
  aspnet: "dotnet.txt",
  laravel: "php.txt",
  rails: "ruby.txt",
}

// Language → knowledge file (for non-JS ecosystems)
const LANGUAGE_MAP = {
  go: "go.txt",
  python: "python.txt",
  rust: "rust.txt",
  java: "java.txt",
  kotlin: "kotlin.txt",
  php: "php.txt",
  ruby: "ruby.txt",
  dart: "flutter.txt",
  swift: "swift.txt",
  cpp: "cpp.txt",
  dotnet: "dotnet.txt",
}

// Project type → scenario knowledge
const TYPE_MAP = {
  backend: ["api-design.txt"],
  fullstack: ["api-design.txt"],
}

// Feature → knowledge file
const FEATURE_MAP = {
  tailwind: "tailwind.txt",
  graphql: "graphql.txt",
  docker: "docker.txt",
  electron: "electron.txt",
  "react-native": "react-native.txt",
}

/**
 * Load knowledge files matching the detected project context.
 * Returns concatenated knowledge text, or empty string.
 */
export async function loadKnowledge({ framework, language, projectType, hasTests, features = [] }) {
  const files = new Set()

  // Tier 1: Framework knowledge
  if (framework) {
    for (const f of (FRAMEWORK_MAP[framework] || [])) files.add(f)
    // Backend framework → language file
    if (BACKEND_FRAMEWORK_LANG[framework]) files.add(BACKEND_FRAMEWORK_LANG[framework])
  }

  // Tier 1: Language knowledge
  if (language === "typescript") files.add("typescript.txt")
  if (!framework && language === "javascript") files.add("node.txt")
  // Non-JS languages
  if (LANGUAGE_MAP[language] && !files.has(LANGUAGE_MAP[language])) {
    files.add(LANGUAGE_MAP[language])
  }

  // Tier 2: Scenario knowledge
  if (projectType && TYPE_MAP[projectType]) {
    for (const f of TYPE_MAP[projectType]) files.add(f)
  }
  if (hasTests) files.add("testing.txt")

  // Tier 2: Feature knowledge
  for (const feat of features) {
    if (FEATURE_MAP[feat]) files.add(FEATURE_MAP[feat])
  }

  // Load and concatenate
  const sections = []
  for (const file of files) {
    const text = await loadFile(file)
    if (text) sections.push(text)
  }
  return sections.length ? sections.join("\n\n") : ""
}

async function loadFile(name) {
  if (cache.has(name)) return cache.get(name)
  try {
    const text = (await readFile(path.join(KNOWLEDGE_DIR, name), "utf8")).trim()
    cache.set(name, text)
    return text
  } catch {
    cache.set(name, "")
    return ""
  }
}
