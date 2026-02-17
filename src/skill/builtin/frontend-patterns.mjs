export const name = "frontend-patterns"
export const description = "Frontend development patterns reference: React/Vue/Svelte components, state management, performance, accessibility"

export async function run(ctx) {
  const topic = (ctx.args || "").trim().toLowerCase()

  const sections = {
    components: `## Component Patterns

### Single Responsibility
Each component does ONE thing. Split when:
- Component exceeds ~150 lines
- It has multiple unrelated state variables
- It renders multiple distinct UI sections

### Composition over Inheritance
\`\`\`jsx
// BAD: prop drilling
<App user={user} theme={theme} locale={locale}>
  <Page user={user} theme={theme} locale={locale}>
    <Widget user={user} theme={theme} locale={locale} />

// GOOD: composition + context
<UserProvider><ThemeProvider><LocaleProvider>
  <App><Page><Widget /></Page></App>
</LocaleProvider></ThemeProvider></UserProvider>
\`\`\`

### Container vs Presentational
- **Container**: fetches data, manages state, passes props down
- **Presentational**: renders UI from props, no side effects, easily testable

### Naming Conventions
- Components: PascalCase (UserProfile, SearchBar)
- Hooks: camelCase with "use" prefix (useAuth, useDebounce)
- Utils: camelCase (formatDate, parseQuery)
- Constants: UPPER_SNAKE_CASE (MAX_RETRIES, API_BASE_URL)`,

    state: `## State Management

### Local State First
Use component state (useState/ref) until you NEED to share:
- Form inputs, toggles, UI state → local
- User session, theme, locale → global context
- Server data → query cache (React Query / SWR / TanStack Query)

### State Categories
1. **UI State**: modals, tabs, scroll position → component state
2. **Form State**: input values, validation → form library (react-hook-form, vee-validate)
3. **Server State**: API responses → query cache with stale-while-revalidate
4. **URL State**: filters, pagination → URL search params (source of truth)
5. **Global State**: auth, theme → Context API or lightweight store (Zustand, Pinia)

### Anti-Patterns
- Don't put everything in global store
- Don't duplicate server state in client store
- Don't derive state that can be computed from existing state
- Don't sync state between components — lift it to common parent`,

    performance: `## Performance Patterns

### Rendering
- **Memoize expensive computations**: useMemo / computed
- **Prevent unnecessary re-renders**: React.memo, shouldComponentUpdate
- **Virtualize long lists**: react-window, vue-virtual-scroller (1000+ items)
- **Lazy load routes and heavy components**: React.lazy, defineAsyncComponent

### Network
- **Debounce search inputs**: 300ms delay before API call
- **Cache API responses**: stale-while-revalidate pattern
- **Prefetch next page**: on hover or intersection observer
- **Compress images**: WebP/AVIF, srcset for responsive, lazy loading

### Bundle
- **Code split by route**: dynamic import() for each route
- **Tree shake**: use ESM imports, avoid barrel re-exports
- **Analyze bundle**: webpack-bundle-analyzer, vite-plugin-visualizer
- **External large deps**: load from CDN if rarely changing`,

    a11y: `## Accessibility (a11y)

### Semantic HTML First
- Use \`<button>\` not \`<div onClick>\`
- Use \`<nav>\`, \`<main>\`, \`<aside>\`, \`<article>\` landmarks
- Use \`<label>\` with \`htmlFor\` for form inputs
- Use heading hierarchy (h1 → h2 → h3, don't skip levels)

### ARIA When Needed
- \`aria-label\` for icon-only buttons
- \`aria-expanded\` for accordions/dropdowns
- \`aria-live="polite"\` for dynamic content updates
- \`role="alert"\` for error messages

### Keyboard Navigation
- All interactive elements must be focusable (tab order)
- Escape closes modals/dropdowns
- Enter/Space activates buttons
- Arrow keys navigate within lists/menus
- Visible focus indicators (never \`outline: none\` without replacement)

### Testing
- aXe browser extension for automated checks
- Screen reader testing (VoiceOver, NVDA)
- Keyboard-only navigation testing
- Color contrast ratio: 4.5:1 for text, 3:1 for large text`
  }

  if (topic && sections[topic]) {
    return sections[topic]
  }

  const overview = Object.values(sections).join("\n\n---\n\n")
  return `# Frontend Development Patterns

Use \`/frontend-patterns <topic>\` for a specific section: components, state, performance, a11y

---

${overview}`
}
