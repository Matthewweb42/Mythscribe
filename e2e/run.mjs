import { spawnSync } from 'node:child_process'
import process from 'node:process'

/**
 * Runs Playwright for `npm run test:e2e`. On Linux with `xvfb-run` installed the app is driven
 * on a virtual display: its window never appears on the author's desktop, so it cannot take the
 * keyboard focus, and what the author types cannot land in the test. `MYTHSCRIBE_E2E_VISIBLE=1`
 * shows the window anyway (to watch a step); without Xvfb, or on another platform, it is shown.
 */
const args = ['playwright', 'test', ...process.argv.slice(2)]
const hidden =
  process.platform === 'linux' &&
  process.env.MYTHSCRIBE_E2E_VISIBLE !== '1' &&
  spawnSync('sh', ['-c', 'command -v xvfb-run']).status === 0

const env = { ...process.env }
// Electron picks Wayland when the variable is set, and Xvfb only speaks X11.
if (hidden) delete env.WAYLAND_DISPLAY

const result = hidden
  ? spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'npx', ...args], {
      stdio: 'inherit',
      env
    })
  : spawnSync('npx', args, { stdio: 'inherit', env, shell: process.platform === 'win32' })

process.exit(result.status ?? 1)
