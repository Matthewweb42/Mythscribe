import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const DIRS = ['src', 'e2e', 'cloud/src']
const MODULE = /\.(ts|tsx|mjs|js)$/

/** Every module path under `dir`, relative to the repo root, without its extension. */
function modulesIn(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : modulesIn(path)
    return MODULE.test(entry.name) ? [relative(ROOT, join(ROOT, path)).replace(MODULE, '')] : []
  })
}

describe('source file names', () => {
  // Windows and macOS file systems ignore case, so `./SidebarTabs` resolved to `sidebarTabs.ts`
  // there while Linux picked `SidebarTabs.tsx`; the Windows build failed its typecheck.
  it('never has two modules whose paths differ only in case', () => {
    const byKey = new Map<string, Set<string>>()
    for (const path of DIRS.flatMap(modulesIn)) {
      const key = path.toLowerCase()
      byKey.set(key, (byKey.get(key) ?? new Set()).add(path))
    }
    const clashes = [...byKey.values()].filter((paths) => paths.size > 1).map((paths) => [...paths])
    expect(clashes).toEqual([])
  })
})
