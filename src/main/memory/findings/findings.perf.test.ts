import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { activeDraftId } from '../../draft/draftStore'
import type { ProjectSession } from '../../project/projectStore'
import type { TreeDb } from '../../tree/treeStore'
import { saveDocument } from '../../document/documentStore'
import { ensureResearchRoot } from '../../project/seed'
import { createResearchNote } from '../../research/researchStore'
import { manuscriptDocuments } from '../../voice/profile'
import { indexNodePassages, indexStaleRecords } from '../passageIndexer'
import { createRecord, savePage } from '../recordStore'
import { getCard, upsertCard } from '../reading/cardStore'
import { buildPerfBook, fastest, PERF_NOW, PERF_SCENES } from '../reading/perfFixture'
import { gateSentences, nextReadSet } from '@shared/memory/gate'
import { nameScanShared } from '../nameIndexer'
import { sceneTexts, seedClaims } from '../reading/claimFixture'
import { writeSceneRead } from '../reading/sceneReadStore'
import { findingRows, findingsOf, setVerdicts } from './findingStore'
import { runFindingsJob } from './findingsJob'
import { recomputeFindings } from './recompute'
import { underlinesOf } from './underlines'

/**
 * The recompute at novel size (F-16.27; plan P4 §1.7): the 90-scene perf book with claims a novel
 * gives the rules to chew on in every scene (an eye colour that changes every 15 scenes, a hair
 * colour that flips each scene with the character on every page, a stated age, a death half way
 * with the character on the page after it, and a Pinned eye colour against them all); then a cast of
 * 30 more with their claims and sheets, and a 2,000-paragraph canon Research upload (C6 indexes the
 * notes once a run, never once per record and slot). The job runs synchronously in Electron main
 * after every change, so a warm run (nothing moved, the scenes' texts read once) stays under 50 ms,
 * the fastest of five as `timeViews.perf.test.ts` measures. So does the job as the app runs it
 * (`cachedVerdicts`, slice 2): every finding unjudged (the background judges 30 pairs a day, so a
 * backlog is the normal state), each pair's stamp checked and none rendered again. The editor's
 * underlines (slice 5) are asked for again on every refresh, so one scene's and a whole stacked
 * book's are measured too.
 */

/** The findings job as the app runs it, warm: every pair rendered once, then only stamped. */
function warmJob(): number {
  runFindingsJob(db, PERF_NOW, { cachedVerdicts: true })
  const rows = findingRows(db, activeDraftId(db))
  expect(rows.every((row) => row.state === 'unjudged' && row.rendered !== null)).toBe(true)
  expect(runFindingsJob(db, PERF_NOW, { cachedVerdicts: true }).changed).toBe(false)
  return fastest(5, () => runFindingsJob(db, PERF_NOW, { cachedVerdicts: true }))
}

const BUDGET_MS = 50
/**
 * What the job's pair stamps may add to the recompute on the cast book (about 6 ms measured): 15 ms,
 * or 60 % of the recompute when the machine is slowed (the suite's parallel load).
 */
const STAMPS_MS = 15
const STAMPS_SHARE = 0.6
/**
 * The editor's underlines (F-16.28, P4 slice 5 review): one scene's, as a refresh of the open
 * scene asks (about 12 ms measured on the cast book), and a whole stacked manuscript's in one call
 * (about 65 ms with an open finding in every one of its 90 scenes).
 */
const UNDERLINES_ONE_MS = 25
const UNDERLINES_STACK_MS = 150
const CAST = 30
const RESEARCH_PARAGRAPHS = 2000

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
    // Eyes: grey and brown in turns (C1), each value once against the Pinned green (C6); the hair
    // flipping every scene (C2 body); the death at 45 against every page after it (C2 dead).
    expect(rules.filter((rule) => rule === 'C1')).toHaveLength(1)
    expect(rules.filter((rule) => rule === 'C6')).toHaveLength(2)
    expect(rules.filter((rule) => rule === 'C2body')).toHaveLength(PERF_SCENES - 1)
    expect(rules.filter((rule) => rule === 'C2dead')).toHaveLength(PERF_SCENES - 45)
    expect(recomputeFindings(db, PERF_NOW).changed).toBe(false)
    const ms = fastest(5, () => recomputeFindings(db, PERF_NOW))
    expect(ms, `recompute: ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS)
    const job = warmJob()
    expect(job, `the job with cached verdicts: ${job.toFixed(1)} ms`).toBeLessThan(BUDGET_MS)
  })

  it('stays within budget with a cast, their sheets and a long canon Research upload', () => {
    // 30 more characters, each with an eye colour in a third of the scenes and a birth year; ten
    // Pinned paragraphs each (300); and a 2,000-paragraph canon Research page that names a few.
    const cast = Array.from({ length: CAST }, (_, i) => {
      const made = createRecord(
        db,
        { name: `Reed${i + 1}`, categoryId: 'character', force: true },
        PERF_NOW
      )
      if (!('record' in made)) throw new Error('blocked')
      return made.record.id
    })
    const ids = manuscriptDocuments(db).map((row) => row.id)
    cast.forEach((recordId, c) => {
      ids.forEach((nodeId, i) => {
        if (i % 3 !== c % 3) return
        const quote = `Mara counted ${i + 1}-5 ropes`
        seedClaims(
          db,
          nodeId,
          [
            { recordId, slot: 'eyes', value: 'grey', quote, para: 5 },
            ...(i < 3 ? [{ recordId, slot: 'born' as const, value: '1790', quote, para: 5 }] : [])
          ],
          PERF_NOW
        )
      })
      savePage(
        db,
        recordId,
        'pinned',
        doc(
          'Eyes: green',
          'Born: 1790',
          'Hair: dark, worn long.',
          'Grew up by the harbour wall.',
          'Fears the open sea since the wreck.',
          'Speaks little at table.',
          'Keeps a knife in her boot.',
          'Owes the chandler money.',
          'Writes to her sister every month.',
          'Has a scar on the left hand.'
        ),
        PERF_NOW
      )
    })
    indexStaleRecords(db, PERF_NOW)
    ensureResearchRoot(db, PERF_NOW)
    const page = createResearchNote(db, 'novel', { title: 'Harbour history' }, PERF_NOW)
    saveDocument(
      db,
      page.id,
      doc(
        ...Array.from({ length: RESEARCH_PARAGRAPHS }, (_, p) =>
          p % 100 === 0
            ? `Reed${((p / 100) % CAST) + 1} has hazel eyes.`
            : `In the year ${1700 + (p % 120)} the harbour wall was rebuilt after a storm (${p}). The tide rose over the black stones and the fishermen moved their boats.`
        )
      )
    )
    indexNodePassages(db, page.id, PERF_NOW)
    recomputeFindings(db, PERF_NOW)
    const draft = activeDraftId(db)
    const notes = findingRows(db, draft).filter((row) => row.rule === 'C6')
    // Each cast member's grey once against their own Pinned green, and the Research hazel for those
    // it names (one value group each, never one finding per scene).
    expect(notes.filter((row) => cast.includes(row.recordId))).toHaveLength(CAST + 20)
    // The fastest of ten: the first runs after seeding 900 claims and indexing the upload share the
    // machine with the collection of that garbage (P4 slice 6 review: up to 15 ms of it).
    const ms = fastest(10, () => recomputeFindings(db, PERF_NOW))
    expect(ms, `recompute with the cast: ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS)
    // The job as the app runs it adds only the pairs' stamps to the recompute (none rendered),
    // within the budget too. The stamps' share is measured against the recompute just before
    // it, so the suite's parallel load (which slows both) does not trip it.
    const job = warmJob()
    const plain = fastest(5, () => recomputeFindings(db, PERF_NOW))
    expect(job, `the job with the cast: ${job.toFixed(1)} ms`).toBeLessThan(BUDGET_MS)
    expect(job - plain, `the job's stamps: ${(job - plain).toFixed(1)} ms`).toBeLessThan(
      Math.max(STAMPS_MS, plain * STAMPS_SHARE)
    )
    // The budget is the recompute's; seeding 900 claims and indexing the upload takes about 4 s
    // alone and more under the full suite's load, past Vitest's 5 s default.
  }, 30_000)
  it('answers the editor’s underlines within budget, one scene or a whole stacked book', () => {
    // Reads the book as the test before left it (the cast and the upload), every scene read and
    // every finding judged a contradiction both ways: an open finding in every scene.
    const draft = activeDraftId(db)
    const names = nameScanShared(db).index
    const ids = manuscriptDocuments(db).map((row) => row.id)
    for (const nodeId of ids) {
      const current = gateSentences(sceneTexts(db, nodeId), { caretPara: null, names })
      writeSceneRead(
        db,
        {
          nodeId,
          draftId: draft,
          entries: nextReadSet(null, current, 'all'),
          full: true,
          readingId: null
        },
        PERF_NOW
      )
    }
    runFindingsJob(db, PERF_NOW, { cachedVerdicts: true })
    for (const finding of findingsOf(db, draft, ['unjudged'])) {
      setVerdicts(db, finding.id, { ab: 'c', ba: 'c', why: 'differ', costUsd: 0, now: PERF_NOW })
    }
    const on = { on: true, mode: 'text' as const }
    const middle = ids[46] ?? ''
    expect(underlinesOf(db, [middle], on)[middle]?.length).toBeGreaterThan(0)
    const one = fastest(5, () => underlinesOf(db, [middle], on))
    expect(one, `one scene's underlines: ${one.toFixed(1)} ms`).toBeLessThan(UNDERLINES_ONE_MS)
    const stack = fastest(3, () => underlinesOf(db, ids, on))
    expect(stack, `a stacked book's underlines: ${stack.toFixed(1)} ms`).toBeLessThan(
      UNDERLINES_STACK_MS
    )
  }, 30_000)
})
