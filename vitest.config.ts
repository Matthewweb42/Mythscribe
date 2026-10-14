import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer') }

export default defineConfig({
  test: {
    // Full isolation nearly triples the run (measured 2026-10-01 on the WSL ext4 clone: 64 s
    // against 25 s), so workers are reused across files and every test file must reset module
    // state (stores, the IPC client, registries) in beforeEach. What leaks anyway, and how to
    // find the file that leaked it, is under Known gotchas in docs/ARCHITECTURE.md.
    maxWorkers: 4,
    isolate: false,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'src/**/*.perf.test.ts']
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'perf',
          environment: 'node',
          // The timing budgets (`*.perf.test.ts`: the findings recompute's 50 ms, the time views',
          // Step 0's) measure what the code costs, so they run once every other project is done
          // (`groupOrder`) and one file at a time: the contradictions eval's 20 s of work beside
          // them failed the 50 ms bar about one full run in two (P4 slice 6 review).
          include: ['src/**/*.perf.test.ts'],
          sequence: { groupOrder: 1 },
          fileParallelism: false
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
          name: 'probe',
          environment: 'node',
          // F-16.1: the live price probe, `npm run ai:probe` only (it needs OPENROUTER_API_KEY and
          // spends about 5¢); under `npm run test` its suites are skipped.
          include: ['src/main/ai/probe/**/*.probe.ts']
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
