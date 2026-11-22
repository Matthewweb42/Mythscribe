// `npm run smoke`: starts the stand-in AI service and a throwaway `wrangler dev` (its own data
// folder, AUTH_MODE=none, no real key), runs the smoke checks, then stops both.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '..', '..')
const state = mkdtempSync(path.join(tmpdir(), 'mythscribe-smoke-'))
const procs = []
const stop = () => { for (const p of procs) try { p.kill() } catch {} ; rmSync(state, { recursive: true, force: true }) }
process.on('exit', stop)
const wrangler = path.join(web, 'node_modules', '.bin', 'wrangler')

execFileSync('node', [path.join(web, 'scripts', 'build.mjs')], { stdio: 'inherit' })
execFileSync(wrangler, ['d1', 'migrations', 'apply', 'mythscribe-web', '--local', '--persist-to', state], { cwd: web, stdio: 'ignore' })
procs.push(spawn('node', [path.join(here, 'mock-anthropic.mjs'), '8798'], { stdio: 'ignore' }))
procs.push(spawn(wrangler, ['dev', '--port', '8797', '--ip', '127.0.0.1', '--persist-to', state, '--env-file', path.join(here, 'smoke.env')], { cwd: web, stdio: 'ignore' }))

for (let i = 0; ; i++) {
  try { if ((await fetch('http://127.0.0.1:8797/api/config')).ok) break } catch {}
  if (i > 60) { console.error('smoke: wrangler dev did not start'); process.exit(1) }
  await new Promise((r) => setTimeout(r, 1000))
}
let failed = false
for (const f of ['shim-e2e.mjs', 'desk-flow.mjs', 'rooms-flow.mjs']) {
  console.log('\n# ' + f)
  try { execFileSync('node', [path.join(here, f)], { stdio: 'inherit', timeout: 120000 }) } catch { failed = true }
}
console.log(failed ? '\nsmoke: FAILED' : '\nsmoke: all passed')
process.exit(failed ? 1 : 0)
