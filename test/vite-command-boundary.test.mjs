import test from 'node:test'
import assert from 'node:assert/strict'
import { isLongRunningCommand } from '../src/kernel/tool/registry.mjs'

test('finite Vite invocations and quoted references do not become dev servers', () => {
  for (const command of [
    'npx vite build', 'npx --no-install vite build', 'vite build', 'vite optimize',
    'npm exec -- vite build', 'pnpm exec vite build', 'yarn vite build',
    'npx vite@6 build --mode production', 'env CI=1 npx vite build',
    'node node_modules/vite/bin/vite.js build',
    'cd app && npx tsc --noEmit && npx vite build',
    "bash -lc 'npx vite build'", 'cmd /c npx vite build', "pwsh -Command 'npx vite build'",
    'npx vite --help', 'npx vite --version', 'vite build --watch=false',
    'echo "npx vite"', 'rg "npx vite" README.md',
    'npx vite build --outDir watch', 'vite --config build.js build'
  ]) assert.equal(isLongRunningCommand(command), false, command)
})

test('Vite development, preview and watch retain foreground ownership protection', () => {
  for (const command of [
    'vite', 'npx vite', 'vite dev', 'vite serve', 'vite preview',
    'vite build --watch', 'npx vite build -w', 'vite build --watch=true',
    'vite --mode build', 'vite --config build', 'vite --base build',
    'vite --config --help', 'vite -- --help',
    'node node_modules/vite/bin/vite.js preview',
    'npx vite build && npx vite preview', 'npx cross-env CI=1 vite build --watch',
    "bash -lc 'vite preview'", 'cmd /k npx vite build',
    String.raw`C:\repo\node_modules\.bin\vite.cmd preview`
  ]) assert.equal(isLongRunningCommand(command), true, command)
})
