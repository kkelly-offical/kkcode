import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { writeFile, readFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import YAML from "yaml"
import { paint } from "./theme/color.mjs"
import { profilePath } from "./storage/paths.mjs"

function ln(text = "", color, opts) {
  console.log(color ? paint(text, color, opts) : text)
}

function termWidth() {
  return Math.max(60, Math.min(process.stdout.columns || 100, 120))
}

function hr(char = "─", color = "#444") {
  ln(paint(char.repeat(termWidth()), color))
}

function header() {
  ln()
  ln(paint("  ██╗  ██╗██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗", "#4af5f0", { bold: true }))
  ln(paint("  ██║ ██╔╝██║ ██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝", "#38c8ff", { bold: true }))
  ln(paint("  █████╔╝ █████╔╝ ██║     ██║   ██║██║  ██║█████╗  ", "#58a0ff", { bold: true }))
  ln(paint("  ██╔═██╗ ██╔═██╗ ██║     ██║   ██║██║  ██║██╔══╝  ", "#8876ff", { bold: true }))
  ln(paint("  ██║  ██╗██║  ██╗╚██████╗╚██████╔╝██████╔╝███████╗", "#d037ff", { bold: true }))
  ln(paint("  ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝", "#e828f0", { bold: true }))
  ln()
  ln(paint("  Welcome to kkcode — AI Coding Agent", "#ffffff", { bold: true }))
  ln(paint("  Let's set up your profile so kkcode knows how to work with you.", "#aaaaaa"))
  ln()
  hr()
}

// Single-choice menu: returns selected index (0-based)
async function menu(rl, prompt, choices) {
  ln()
  ln(paint(`  ${prompt}`, "#ffffff", { bold: true }))
  for (let i = 0; i < choices.length; i++) {
    ln(paint(`    ${i + 1}) `, "#888") + paint(choices[i], "#dddddd"))
  }
  ln()
  while (true) {
    const raw = await rl.question(paint("  Enter number: ", "#4af5f0"))
    const n = parseInt(raw.trim(), 10)
    if (n >= 1 && n <= choices.length) return n - 1
    ln(paint("  Please enter a valid number.", "#ff6b6b"))
  }
}

// Multi-choice menu: returns array of selected indices
async function multiMenu(rl, prompt, choices, hint = "comma-separated, e.g. 1,3") {
  ln()
  ln(paint(`  ${prompt}`, "#ffffff", { bold: true }))
  for (let i = 0; i < choices.length; i++) {
    ln(paint(`    ${i + 1}) `, "#888") + paint(choices[i], "#dddddd"))
  }
  ln(paint(`  (${hint}, or press Enter to skip)`, "#888"))
  ln()
  const raw = await rl.question(paint("  Your choice: ", "#4af5f0"))
  if (!raw.trim()) return []
  return raw.split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((n) => n >= 0 && n < choices.length)
}

// Free-text input
async function ask(rl, prompt, placeholder = "") {
  ln()
  if (placeholder) ln(paint(`  e.g. ${placeholder}`, "#666"))
  const raw = await rl.question(paint(`  ${prompt}: `, "#4af5f0"))
  return raw.trim()
}

// ─── Section renderers ────────────────────────────────────────────────────────

function sectionTitle(title) {
  ln()
  hr("─", "#333")
  ln(paint(`  ${title}`, "#2ac26f", { bold: true }))
  hr("─", "#333")
}

// ─── Default profile ──────────────────────────────────────────────────────────

export function defaultProfile() {
  return {
    beginner: true,
    tech_stack: [],
    languages: [],
    design_style: "clean and minimal",
    extra_notes: "",
    created_at: new Date().toISOString()
  }
}

// ─── Save / load ──────────────────────────────────────────────────────────────

export async function saveProfile(profile) {
  const p = profilePath()
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, YAML.stringify(profile), "utf8")
}

export async function loadProfile() {
  try {
    const raw = await readFile(profilePath(), "utf8")
    return YAML.parse(raw) || null
  } catch {
    return null
  }
}

export function isFirstRun() {
  // Resolved lazily — call loadProfile() to check
  return loadProfile().then((p) => p === null)
}

// ─── Main onboarding flow ─────────────────────────────────────────────────────

export async function runOnboarding() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Non-interactive: write default profile silently
    await saveProfile(defaultProfile())
    return defaultProfile()
  }

  const rl = createInterface({ input, output, terminal: true })

  try {
    header()

    ln(paint("  Quick start options:", "#ffffff", { bold: true }))
    ln()
    ln(paint("    1) ", "#888") + paint("I'm new — use kkcode defaults (recommended for beginners)", "#dddddd"))
    ln(paint("    2) ", "#888") + paint("Set up my profile now", "#dddddd"))
    ln()

    const modeRaw = await rl.question(paint("  Enter number [1]: ", "#4af5f0"))
    const mode = modeRaw.trim() === "2" ? "custom" : "default"

    if (mode === "default") {
      const profile = defaultProfile()
      await saveProfile(profile)
      ln()
      ln(paint("  ✓ Default profile saved. You can update it anytime with /profile.", "#2ac26f", { bold: true }))
      ln()
      return profile
    }

    // ── Custom setup ──────────────────────────────────────────────────────────
    const profile = { beginner: false, created_at: new Date().toISOString() }

    // 1. Programming languages
    sectionTitle("1 / 4  Programming Languages")
    const langChoices = ["JavaScript / TypeScript", "Python", "Rust", "Go", "Java / Kotlin", "C / C++", "Ruby", "PHP", "Swift", "Other"]
    const langIdxs = await multiMenu(rl, "Which languages do you mainly use?", langChoices)
    profile.languages = langIdxs.map((i) => langChoices[i])
    if (langIdxs.includes(langChoices.length - 1) || profile.languages.length === 0) {
      const extra = await ask(rl, "Specify languages (optional)", "Elixir, Dart, ...")
      if (extra) profile.languages = [...profile.languages.filter((l) => l !== "Other"), extra]
    }

    // 2. Tech stack / frameworks
    sectionTitle("2 / 4  Tech Stack & Frameworks")
    const stackChoices = ["React", "Vue", "Next.js", "Node.js / Express", "FastAPI / Django", "Spring Boot", "Docker / Kubernetes", "AWS / GCP / Azure", "PostgreSQL / MySQL", "MongoDB", "Other"]
    const stackIdxs = await multiMenu(rl, "Which frameworks / tools do you use?", stackChoices)
    profile.tech_stack = stackIdxs.map((i) => stackChoices[i])
    if (stackIdxs.includes(stackChoices.length - 1) || profile.tech_stack.length === 0) {
      const extra = await ask(rl, "Specify stack (optional)", "Svelte, Prisma, Redis, ...")
      if (extra) profile.tech_stack = [...profile.tech_stack.filter((s) => s !== "Other"), extra]
    }

    // 3. Design / code style
    sectionTitle("3 / 4  Design & Code Style")
    const styleChoices = [
      "Clean and minimal — less is more",
      "Functional — prefer pure functions, immutability",
      "Object-oriented — classes and patterns",
      "Performance-first — optimize aggressively",
      "Pragmatic — whatever works best for the task"
    ]
    const styleIdx = await menu(rl, "What's your preferred coding style?", styleChoices)
    profile.design_style = styleChoices[styleIdx]

    // 4. Extra notes
    sectionTitle("4 / 4  Anything Else?")
    ln(paint("  Tell kkcode anything else it should remember about you.", "#aaaaaa"))
    ln(paint("  e.g. \"Always write tests\", \"I prefer concise code\", \"Use Chinese for comments\"", "#666"))
    const notes = await ask(rl, "Extra notes (optional, press Enter to skip)")
    profile.extra_notes = notes

    // ── Save ──────────────────────────────────────────────────────────────────
    await saveProfile(profile)

    ln()
    hr()
    ln()
    ln(paint("  ✓ Profile saved!", "#2ac26f", { bold: true }))
    ln(paint("  kkcode will use this context in every conversation.", "#aaaaaa"))
    ln(paint("  You can update it anytime with /profile.", "#aaaaaa"))
    ln()

    return profile
  } finally {
    rl.close()
  }
}
