import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanNamesFor } from '../memory/nameIndexer'
import { indexOwner, indexScene } from '../memory/passageIndexer'
import { seedClaims } from '../memory/reading/claimFixture'
import { buildPerfBook, fastest, PERF_NOW, type PerfBook } from '../memory/reading/perfFixture'
import { createRecord } from '../memory/recordStore'
import { gatherStep0 } from './step0'

/**
 * Step 0 at novel size (F-16.24; design §2.6 "local, <50 ms"; plan P3 §1.6): the 90-scene perf
 * book with three records the question names, every scene indexed for the passage search, the
 * question asked from a scene in the middle of the book. The fastest of five warm calls stays under
 * 50 ms (the first, cold call reads every scene's text once, as the app's views already have; the
 * fastest, as `timeViews.perf.test.ts` measures, so other test workers on the machine do not count).
 */

const BUDGET_MS = 50

let tmp: string
let book: PerfBook

function record(name: string): string {
  const made = createRecord(book.db, { name, categoryId: 'character', force: true }, PERF_NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-step0-perf-'))
  book = buildPerfBook(tmp)
  const orrin = record('Orrin')
  const tomas = record('Tomas')
  for (const id of book.ids) {
    scanNamesFor(book.db, id, PERF_NOW)
    indexScene(book.db, id, PERF_NOW)
  }
  for (const id of [book.mara, orrin, tomas]) indexOwner(book.db, 'record', id, PERF_NOW)
  seedClaims(
    book.db,
    book.ids[0] ?? '',
    [
      {
        recordId: book.mara,
        slot: 'location',
        value: 'the quay',
        quote: 'Mara walked the quay',
        para: 0
      }
    ],
    PERF_NOW
  )
})
afterAll(() => {
  book.session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Step 0 at novel size (F-16.24)', () => {
  it('answers a question naming three records in under 50 ms, and an ordinal one too', () => {
    const open = book.ids[45] ?? ''
    for (const question of [
      'Where were Mara, Orrin and Tomas at the harbour wall?',
      'When does Mara first count the ropes with Orrin and Tomas?'
    ]) {
      const ask = (): ReturnType<typeof gatherStep0> =>
        gatherStep0(book.db, { nodeId: open, question, focus: { caretPara: 3, selection: null } })
      const first = ask()
      expect(first.records.map((each) => each.name)).toEqual(['Mara', 'Orrin', 'Tomas'])
      expect(first.e0?.paragraphs).toHaveLength(40)
      expect(first.menu.length).toBeGreaterThan(0)
      const ms = fastest(5, ask)
      expect(ms, `${question}: ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS)
    }
  })
})
