import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { activeDraftId } from '../../draft/draftStore'
import type { ProjectSession } from '../../project/projectStore'
import type { TreeDb } from '../../tree/treeStore'
import { indexStaleRecords } from '../passageIndexer'
import { savePage } from '../recordStore'
import { getCard, upsertCard } from '../reading/cardStore'
import { seedClaims } from '../reading/claimFixture'
import { buildPerfBook, fastest, PERF_NOW, PERF_SCENES } from '../reading/perfFixture'
import { findingRows } from './findingStore'
import { recomputeFindings } from './recompute'

/**
 * The recompute at novel size (F-16.27; plan P4 §1.7): the 90-scene perf book with claims a novel
 * gives the rules to chew on in every scene (an eye colour that changes every 15 scenes, a hair
 * colour that flips each scene with the character on every page, a stated age, a death half way
 * with the character on the page after it, and a Pinned eye colour against them all). The job runs
 * synchronously in Electron main after every change, so a warm run (nothing moved, the scenes'
 * texts read once) stays under 50 ms, the fastest of five as `timeViews.perf.test.ts` measures.
 */

const BUDGET_MS = 50

let tmp: string
let session: ProjectSession
let db: TreeDb

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-findings-perf-'))
  const book = buildPerfBook(tmp)
  session = book.session
  db = book.db
  book.ids.forEach((nodeId, i) => {
    const n = i + 1
    const quote = (p: number): string => `Mara counted ${n}-${p} ropes`
    // Mara on the page by a quote of its own (the shared fixture's "Mara counted" stands in every
    // paragraph, so it locates nowhere for certain).
    const card = getCard(db, nodeId, activeDraftId(db))
    if (card === null) throw new Error('no card')
    upsertCard(
      db,
      { ...card, present: [{ recordId: book.mara, quote: quote(1), p: 1, verified: true }] },
      PERF_NOW
    )
    seedClaims(
      db,
      nodeId,
      [
        {
          recordId: book.mara,
          slot: 'eyes',
          value: n % 30 < 15 ? 'grey' : 'brown',
          quote: quote(1),
          para: 1
        },
        {
          recordId: book.mara,
          slot: 'hair',
          value: n % 2 === 0 ? 'dark' : 'fair',
          quote: quote(2),
          para: 2
        },
        { recordId: book.mara, slot: 'age', value: 'nineteen', quote: quote(3), para: 3 },
        ...(n === 45
          ? [
              {
                recordId: book.mara,
                slot: 'alive' as const,
                value: 'dead',
                quote: quote(4),
                para: 4
              }
            ]
          : [])
      ],
      PERF_NOW
    )
  })
  savePage(db, book.mara, 'pinned', doc('Eyes: green', 'Born: 1792'), PERF_NOW)
  indexStaleRecords(db, PERF_NOW)
})

afterAll(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the findings recompute at novel size (F-16.27)', () => {
  it('finds the candidates of a 90-scene book, then recomputes within budget', () => {
    const first = recomputeFindings(db, PERF_NOW)
    expect(first.changed).toBe(true)
    const rules = findingRows(db, activeDraftId(db)).map((row) => `${row.rule}${row.variant ?? ''}`)
    // Eyes: grey and brown in turns (C1), each against the Pinned green (C6); the hair flipping
    // every scene (C2 body); the death at 45 against every page after it (C2 dead).
    expect(rules.filter((rule) => rule === 'C1')).toHaveLength(1)
    expect(rules.filter((rule) => rule === 'C6')).toHaveLength(PERF_SCENES)
    expect(rules.filter((rule) => rule === 'C2body')).toHaveLength(PERF_SCENES - 1)
    expect(rules.filter((rule) => rule === 'C2dead')).toHaveLength(PERF_SCENES - 45)
    expect(recomputeFindings(db, PERF_NOW).changed).toBe(false)
    const ms = fastest(5, () => recomputeFindings(db, PERF_NOW))
    expect(ms, `recompute: ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS)
  })
})
