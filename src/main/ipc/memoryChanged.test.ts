import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * F-16.27 (plan P4 §1.5): every `memory:changed` push goes through the handlers' one helper
 * (`memoryChanged`), which also queues the contradiction recompute, so no change to what the memory
 * holds can leave the findings behind. A direct emit anywhere else is a straggler.
 */
describe('memory:changed has one sender (F-16.27)', () => {
  it('is emitted only by the memoryChanged helper', () => {
    const source = fs.readFileSync(path.join(__dirname, 'handlers.ts'), 'utf8')
    const emits = source.match(/emit\(\s*windows\(\),\s*'memory:changed'/g) ?? []
    expect(emits).toHaveLength(1)
    const helper = source.indexOf('const memoryChanged = ')
    const emit = source.search(/emit\(\s*windows\(\),\s*'memory:changed'/)
    expect(helper).toBeGreaterThan(-1)
    // The one emit sits inside the helper, which also queues the findings job.
    const body = source.slice(helper, source.indexOf('\n  }\n', helper))
    expect(emit).toBeGreaterThan(helper)
    expect(body).toContain('queueFindings(')
  })

  it('leaves no other module sending it on its own', () => {
    const root = path.join(__dirname, '..')
    const senders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const at = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(at)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          if (/emit\([^;]*'memory:changed'/.test(fs.readFileSync(at, 'utf8'))) {
            senders.push(path.relative(root, at))
          }
        }
      }
    }
    walk(root)
    expect(senders).toEqual([path.join('ipc', 'handlers.ts')])
  })
})
