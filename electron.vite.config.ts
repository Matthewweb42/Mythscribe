import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  preload: {
    // Sandboxed preloads can only `require` Electron built-ins, so zod (pulled in via the IPC
    // contract) must be bundled rather than externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias: shared }
  },
  renderer: {
    resolve: { alias: { '@renderer': resolve('src/renderer'), ...shared } },
    plugins: [react(), tailwindcss()]
  }
})
