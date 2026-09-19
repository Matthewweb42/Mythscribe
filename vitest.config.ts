import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer') }

export default defineConfig({
  test: {
    // The repo lives on a slow /mnt/c mount: spawning a fork per file in parallel makes worker
    // startup time out ("Failed to start forks worker"), and full isolation triples the run.
    // Workers are reused across files, so every test file must reset module state (stores,
    // the IPC client, registries) in beforeEach.
    maxWorkers: 4,
    isolate: false,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts']
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'eval',
          environment: 'node',
          // The prompt eval harness (F-5.12): offline by default (token report against the
          // committed baseline), live against the provider with MYTHSCRIBE_EVAL_LIVE=1.
          include: ['src/main/ai/eval/**/*.eval.ts']
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'cloud',
          environment: 'node',
          // The MythScribe Cloud Worker (F-15.2): plain fetch handlers over injected
          // dependencies, so they run under Node with no Worker runtime.
          include: ['cloud/src/**/*.test.ts']
        }
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/test/setup.ts']
        }
      }
    ]
  }
})
