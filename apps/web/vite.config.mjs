import { defineConfig } from 'vite'
export default defineConfig({ build: { outDir: '../../src/web', emptyOutDir: true }, server: { proxy: { '/api': 'http://127.0.0.1:18271', '/auth': 'http://127.0.0.1:18271' } } })
