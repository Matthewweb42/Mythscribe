import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectSession } from '../../project/projectStore'
import type { TreeDb } from '../../tree/treeStore'
import { buildPerfBook, PERF_SCENES as SCENES } from './perfFixture'
import { storedYears, threadsMemory, timelineMemory } from './timeViews'
import { sheetMemory } from './views'

/**
 * The time views at novel size (F-16.23; plan P2b §5.1 budgets "no text read; about 1 ms for 90
 * scenes"): 90 scenes of about 1,300 words, every one carded with a POV, a character on the page
 * and an elapsed hint, so every card has a field the years or Here read. A character's sheet, the
 * Timeline and the story years run synchronously in Electron main whenever a scene moved, so each
 * stays well under a frame budget once the book's texts were read once (the paragraph cache).
 */

/** Per warm call: a fifth of the 230 ms the whole-book re-read took on the slowest machine measured. */
const BUDGET_MS = 50

let tmp: string
let session: ProjectSession
let db: TreeDb
let mara: string

/** Milliseconds of the fastest of `runs` calls (the first, cold one is left out by the caller). */
function fastest(runs: number, call: () => unknown): number {
  let best = Infinity
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    call()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-time-perf-'))
  const book = buildPerfBook(tmp)
  session = book.session
  db = book.db
  mara = book.mara
})

afterAll(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the time views at novel size (F-16.23)', () => {
  it('reads the years, the Timeline and a character’s sheet of a 90-scene book within budget', () => {
    // The first calls read every scene's text once; every card stands, so nothing is skipped.
    expect(storedYears(db)).toHaveLength(SCENES)
    const rows = timelineMemory(db, null).rows
    expect(rows.filter((row) => row.elapsed?.text === 'A season later')).toHaveLength(SCENES)
    expect(rows.filter((row) => row.ages.length === 1)).toHaveLength(SCENES)
    expect(sheetMemory(db, mara, null).age?.age).toMatchObject({ kind: 'stated' })
    const timings = {
      years: fastest(5, () => storedYears(db)),
      timeline: fastest(5, () => timelineMemory(db, null)),
      sheet: fastest(5, () => sheetMemory(db, mara, null)),
      threads: fastest(5, () => threadsMemory(db, null))
    }
    // Before the review of P2b slice 5 each of these re-read every scene's text: 95–230 ms.
    for (const [view, ms] of Object.entries(timings)) {
      expect(ms, `${view}: ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS)
    }
  })
})
