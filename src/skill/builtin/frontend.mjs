import { readFile } from "node:fs/promises"
import path from "node:path"

export const name = "frontend"
export const description = "Frontend development guidance with framework awareness (usage: /frontend <task description>)"

async function detectCurrentFramework(cwd) {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.next) return "next"
    if (deps.nuxt) return "nuxt"
    if (deps["@sveltejs/kit"] || deps.svelte) return "svelte"
    if (deps["@angular/core"]) return "angular"
    if (deps.vue) return "vue"
    if (deps.react) return "react"
  } catch { /* no package.json */ }
  return null
}

const FRAMEWORK_GUIDES = {
  vue: `## Vue 3 Frontend Development Guide

### Component Architecture
- Break UI into small, focused single-file components (.vue)
- Use <script setup lang="ts"> for all components
- Props: defineProps<{ title: string }>()
- Events: defineEmits<{ (e: 'update', value: string): void }>()
- Slots: use <slot> for content projection

### State Management (Pinia)
- One store per domain (useUserStore, useCartStore)
- Use setup syntax: export const useXxxStore = defineStore('xxx', () => { ... })
- Access stores in components: const store = useXxxStore()

### Routing (Vue Router)
- Define routes in src/router/index.ts
- Use <RouterView> and <RouterLink>
- Lazy-load pages: () => import('../views/About.vue')
- Use route params: useRoute().params

### Styling
- <style scoped> for component styles (default)
- CSS variables for theming
- If Tailwind/UnoCSS is installed, use utility classes
- If Element Plus / Ant Design Vue is installed, use their components

### Data Fetching
- Use composables: useFetch(), useApi()
- Handle loading/error states in the component
- Use onMounted() or watchEffect() for side effects`,

  react: `## React Frontend Development Guide

### Component Architecture
- Functional components only (no class components)
- One component per file, named export
- Props interface: interface Props { title: string }
- Use React.memo() for expensive pure components

### State Management
- Local state: useState()
- Complex state: useReducer()
- Global state: React Context or Zustand/Jotai
- Server state: TanStack Query (React Query)

### Routing (React Router v6)
- createBrowserRouter with route objects
- Use <Outlet> for nested routes
- useParams(), useSearchParams(), useNavigate()
- Lazy routes: lazy(() => import('./pages/About'))

### Styling
- CSS Modules (.module.css) or Tailwind CSS
- Styled-components if already in deps
- Avoid inline styles for complex styling

### Data Fetching
- Use useEffect + fetch for simple cases
- Use TanStack Query for caching and deduplication
- Handle loading/error/success states`,

  next: `## Next.js Frontend Development Guide

### App Router Architecture
- Server Components by default (no 'use client')
- Add 'use client' ONLY for: useState, useEffect, onClick, onChange, etc.
- Layouts: app/layout.tsx (shared UI, persistent across navigation)
- Pages: app/page.tsx, app/[slug]/page.tsx

### Data Fetching
- Server Components: async function + direct fetch/db calls
- Client Components: use SWR or TanStack Query
- Server Actions: 'use server' functions for mutations

### Styling
- Tailwind CSS (default with create-next-app)
- CSS Modules for component-scoped styles
- Use next/font for optimized font loading

### Performance
- Use next/image for optimized images
- Use next/link for client-side navigation
- Use loading.tsx for streaming/suspense
- Use generateStaticParams for static generation`,

  nuxt: `## Nuxt 3 Frontend Development Guide

### Auto-imports
- No need to import: ref, computed, watch, onMounted, etc.
- No need to import components from components/ directory
- No need to import composables from composables/ directory

### Pages & Routing
- File-based: pages/index.vue, pages/users/[id].vue
- definePageMeta({ layout: 'admin', middleware: 'auth' })
- Use NuxtLink for navigation
- Use useRoute() for route params

### Data Fetching
- useFetch('/api/users') — SSR-friendly, auto-cached
- useAsyncData('key', () => $fetch('/api/data'))
- useLazyFetch for client-only fetching

### State
- useState('key', () => defaultValue) for SSR-safe state
- Pinia with @pinia/nuxt for complex state

### Server
- server/api/ for API routes
- server/middleware/ for server middleware
- defineEventHandler() for route handlers`,

  svelte: `## SvelteKit Frontend Development Guide

### Runes (Svelte 5)
- let count = $state(0) for reactive state
- let doubled = $derived(count * 2) for computed values
- $effect(() => { ... }) for side effects
- $props() for component props

### Routing
- src/routes/+page.svelte for pages
- src/routes/+layout.svelte for layouts
- src/routes/+page.server.ts for server-side data loading
- [param] for dynamic routes

### Data Loading
- +page.server.ts: export const load = async ({ params }) => { ... }
- Access in page: let { data } = $props()

### Styling
- <style> is scoped by default in Svelte
- Use Tailwind if installed
- Use CSS variables for theming`,
}

export async function run(ctx) {
  const task = (ctx.args || "").trim()
  const cwd = ctx.cwd || process.cwd()
  const framework = await detectCurrentFramework(cwd)

  const parts = []

  if (task) {
    parts.push(`Task: ${task}`)
    parts.push("")
  }

  if (framework && FRAMEWORK_GUIDES[framework]) {
    parts.push(FRAMEWORK_GUIDES[framework])
  } else if (framework) {
    parts.push(`Detected framework: ${framework}. Use its standard conventions and idioms.`)
  } else {
    parts.push(`No framework detected in this project. If you need to create a frontend project, use /init <framework> first.`)
    parts.push("")
    parts.push("For a quick single-page app without a framework, consider using Vite:")
    parts.push("  npm create vite@latest . -- --template vanilla-ts")
  }

  if (task) {
    parts.push("")
    parts.push("Now implement the task described above using the project's framework and conventions.")
    parts.push("Break the work into components, create proper file structure, and use the framework's idioms.")
  }

  return parts.join("\n")
}
