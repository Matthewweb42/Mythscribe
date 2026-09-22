import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  // One monolithic smoke test that gains a step per feature; F-4.12b's scan waits took it past
  // 90 s on the author's machine, and the step it then timed out in was nowhere near its own.
  timeout: 150_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' }
})
