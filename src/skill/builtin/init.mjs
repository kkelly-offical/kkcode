export const name = "init"
export const description = "Initialize a new project with framework scaffolding (usage: /init <framework>)"

const GUIDES = {
  vue: `Initialize a Vue 3 project with Vite. Follow these steps exactly:

1. Run: npm create vite@latest . -- --template vue-ts
   (If the directory is not empty, create in a subdirectory or confirm overwrite)

2. Install dependencies: npm install

3. Install common extras:
   npm install vue-router@4 pinia
   npm install -D @vitejs/plugin-vue

4. Create the standard directory structure:
   src/
   ├── components/    # Reusable UI components
   ├── views/         # Page-level components (routed)
   ├── stores/        # Pinia stores
   ├── router/        # Vue Router config
   ├── composables/   # Shared composition functions
   ├── assets/        # Static assets (images, fonts)
   ├── styles/        # Global styles
   ├── App.vue        # Root component
   └── main.ts        # Entry point

5. Code conventions:
   - Use <script setup lang="ts"> in all .vue files
   - Use Composition API (ref, reactive, computed, watch)
   - Use defineProps<T>() and defineEmits<T>() for component interfaces
   - Use <style scoped> for component styles
   - Use Pinia for state management (defineStore with setup syntax)
   - Use vue-router with typed route params

6. Set up router in src/router/index.ts with createRouter + createWebHistory

7. Set up a root Pinia store in src/main.ts with createPinia()

After scaffolding, verify with: npm run dev (tell user to run manually)`,

  react: `Initialize a React project with Vite. Follow these steps exactly:

1. Run: npm create vite@latest . -- --template react-ts

2. Install dependencies: npm install

3. Install common extras:
   npm install react-router-dom
   npm install -D @types/react @types/react-dom

4. Create the standard directory structure:
   src/
   ├── components/    # Reusable UI components
   ├── pages/         # Page-level components (routed)
   ├── hooks/         # Custom React hooks
   ├── contexts/      # React context providers
   ├── services/      # API calls and external services
   ├── assets/        # Static assets
   ├── styles/        # Global styles
   ├── App.tsx        # Root component
   └── main.tsx       # Entry point

5. Code conventions:
   - Use functional components with TypeScript
   - Use hooks (useState, useEffect, useMemo, useCallback)
   - Use React.FC<Props> or explicit return types
   - Prefer named exports for components
   - Use React Router v6 with createBrowserRouter

After scaffolding, verify with: npm run dev (tell user to run manually)`,

  next: `Initialize a Next.js project. Follow these steps exactly:

1. Run: npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"

2. Directory structure (App Router):
   src/
   ├── app/
   │   ├── layout.tsx      # Root layout
   │   ├── page.tsx        # Home page
   │   ├── globals.css     # Global styles
   │   └── [feature]/
   │       └── page.tsx    # Feature pages
   ├── components/         # Shared components
   ├── lib/                # Utility functions
   └── types/              # TypeScript types

3. Code conventions:
   - Server Components by default (no 'use client' unless needed)
   - Add 'use client' only for interactive components (useState, onClick, etc.)
   - Use Next.js Image, Link, and metadata APIs
   - Use Route Handlers (app/api/) for API endpoints

After scaffolding, verify with: npm run dev (tell user to run manually)`,

  nuxt: `Initialize a Nuxt 3 project. Follow these steps exactly:

1. Run: npx nuxi@latest init .

2. Install dependencies: npm install

3. Directory structure:
   ├── pages/          # File-based routing (auto-registered)
   ├── components/     # Auto-imported components
   ├── composables/    # Auto-imported composables
   ├── layouts/        # Layout components
   ├── stores/         # Pinia stores (install @pinia/nuxt)
   ├── server/         # Server routes and middleware
   ├── assets/         # Build-processed assets
   ├── public/         # Static files
   └── nuxt.config.ts  # Nuxt configuration

4. Code conventions:
   - Auto-imports: no need to import ref, computed, useState, etc.
   - Pages auto-register routes based on file structure
   - Components auto-register based on file name
   - Use useFetch() or useAsyncData() for data fetching
   - Use definePageMeta() for page-level metadata

After scaffolding, verify with: npm run dev (tell user to run manually)`,

  svelte: `Initialize a SvelteKit project. Follow these steps exactly:

1. Run: npx sv create . (select skeleton project + TypeScript)

2. Install dependencies: npm install

3. Directory structure:
   src/
   ├── routes/         # File-based routing
   │   ├── +layout.svelte
   │   ├── +page.svelte
   │   └── [feature]/
   │       └── +page.svelte
   ├── lib/
   │   ├── components/ # Shared components
   │   └── server/     # Server-only modules
   └── app.html        # HTML template

4. Code conventions:
   - Use +page.svelte for pages, +layout.svelte for layouts
   - Use +page.server.ts for server-side data loading
   - Use $state, $derived, $effect runes (Svelte 5)
   - Use <script lang="ts"> for TypeScript

After scaffolding, verify with: npm run dev (tell user to run manually)`,

  node: `Initialize a Node.js project. Follow these steps exactly:

1. Run: npm init -y

2. Update package.json: set "type": "module" for ESM

3. Install TypeScript (recommended):
   npm install -D typescript @types/node tsx
   npx tsc --init

4. Directory structure:
   src/
   ├── index.ts       # Entry point
   ├── lib/            # Core logic
   ├── utils/          # Utility functions
   └── types/          # TypeScript types

5. Add scripts to package.json:
   "dev": "tsx watch src/index.ts",
   "build": "tsc",
   "start": "node dist/index.js"`,

  express: `Initialize an Express.js API project. Follow these steps exactly:

1. Run: npm init -y

2. Update package.json: set "type": "module"

3. Install dependencies:
   npm install express cors
   npm install -D typescript @types/node @types/express tsx

4. Initialize TypeScript: npx tsc --init

5. Directory structure:
   src/
   ├── index.ts        # Server entry + app.listen()
   ├── routes/          # Route handlers
   ├── middleware/       # Custom middleware
   ├── controllers/     # Request handlers
   ├── services/        # Business logic
   ├── models/          # Data models
   └── types/           # TypeScript types

6. Add scripts:
   "dev": "tsx watch src/index.ts",
   "build": "tsc",
   "start": "node dist/index.js"`,
}

const AVAILABLE = Object.keys(GUIDES)

export async function run(ctx) {
  const arg = (ctx.args || "").trim().toLowerCase()

  if (!arg) {
    return `Please specify a framework to initialize. Available options:

${AVAILABLE.map(f => `- /init ${f}`).join("\n")}

Example: /init vue`
  }

  const guide = GUIDES[arg]
  if (!guide) {
    return `Unknown framework "${arg}". Available options: ${AVAILABLE.join(", ")}

Example: /init vue`
  }

  return guide
}
