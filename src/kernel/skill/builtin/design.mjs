import { readFile } from "node:fs/promises"
import path from "node:path"

export const name = "design"
export const description = "Frontend design mode — generates polished, distinctive UI with strong aesthetics (usage: /design <task>)"

async function detectDesignContext(cwd) {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const ctx = {}
    // Framework
    if (deps.next) ctx.framework = "next"
    else if (deps.nuxt) ctx.framework = "nuxt"
    else if (deps.vue) ctx.framework = "vue"
    else if (deps.react) ctx.framework = "react"
    else if (deps.svelte || deps["@sveltejs/kit"]) ctx.framework = "svelte"
    // CSS
    if (deps.tailwindcss) ctx.css = "tailwind"
    else if (deps.unocss) ctx.css = "unocss"
    else if (deps["styled-components"]) ctx.css = "styled-components"
    // Component lib
    if (deps.antd) ctx.lib = "antd"
    else if (deps["element-plus"]) ctx.lib = "element-plus"
    else if (deps["@mui/material"]) ctx.lib = "mui"
    else if (deps["@chakra-ui/react"]) ctx.lib = "chakra-ui"
    else if (deps["@mantine/core"]) ctx.lib = "mantine"
    else if (deps["naive-ui"]) ctx.lib = "naive-ui"
    return ctx
  } catch { return {} }
}

const AESTHETICS_PROMPT = `<frontend_aesthetics>
You are in DESIGN MODE. Create polished, distinctive frontends — NOT generic AI output.

Typography: Avoid Inter/Roboto/Arial. Use distinctive fonts (Space Grotesk, Playfair Display, Satoshi, IBM Plex). Extreme weight contrast (200 vs 800), 3x+ size jumps.

Color: CSS variables for ALL colors. Dominant color + sharp accent. Draw from IDE themes (Nord, Catppuccin), cultural aesthetics. AVOID purple-gradient-on-white.

Motion: One high-impact staggered reveal per page. Micro-interactions on hover/focus/press. CSS transitions + animation-delay.

Layout: CSS Grid for pages, Flexbox for components. Generous whitespace. Consistent 4px spacing scale. Mobile-first.

Depth: Layered gradients, backdrop-filter glass, box-shadow elevation hierarchy.

NEVER: cookie-cutter card grids, generic hero sections, border-radius:9999px everywhere, gray wireframe text, no visual rhythm.
</frontend_aesthetics>`

export async function run(ctx) {
  const task = (ctx.args || "").trim()
  const cwd = ctx.cwd || process.cwd()
  const design = await detectDesignContext(cwd)

  const parts = [AESTHETICS_PROMPT, ""]

  if (Object.keys(design).length) {
    parts.push("## Project Design Context")
    if (design.framework) parts.push(`- Framework: ${design.framework}`)
    if (design.css) parts.push(`- CSS: ${design.css}`)
    if (design.lib) parts.push(`- Component Library: ${design.lib}`)
    parts.push("")
    parts.push("Read the project's existing styles/theme before writing new code. Extend, don't replace.")
    parts.push("")
  }

  if (task) {
    parts.push(`## Task`)
    parts.push(task)
    parts.push("")
    parts.push("Implement this with production-grade design quality. Make it look like a professional designer built it.")
  } else {
    parts.push("No task specified. Usage: /design <description of what to build>")
  }

  return parts.join("\n")
}
