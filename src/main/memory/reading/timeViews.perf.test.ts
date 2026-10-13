import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyCardFields } from '@shared/memory/claims'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { createRecord } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { upsertCard } from './cardStore'
import { cardAnchorOf, seedClaims } from './claimFixture'
import { storedYears, threadsMemory, timelineMemory } from './timeViews'
import { sheetMemory } from './views'

/**
 * The time views at novel size (F-16.23; plan P2b §5.1 budgets "no text read; about 1 ms for 90
 * scenes"): 90 scenes of about 1,300 words, every one carded with a POV, a character on the page
 * and an elapsed hint, so every card has a field the years or Here read. A character's sheet, the
 * Timeline and the story years run synchronously in Electron main whenever a scene moved, so each
 * stays well under a frame budget once the book's texts were read once (the paragraph cache).
 */

const SCENES = 90
/** Per warm call: a fifth of the 230 ms the whole-book re-read took on the slowest machine measured. */
const BUDGET_MS = 50
const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

let tmp: string
let session: ProjectSession
let db: TreeDb
let mara: string

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

/** About 1,300 words: 40 paragraphs of four sentences, every sentence different. */
function sceneText(n: number): string[] {
  return Array.from({ length: 40 }, (_, p) =>
    [
      p === 0
        ? `A season later, Mara walked the quay for the ${n}th time.`
        : `Mara counted ${n}-${p} ropes.`,
      `The tide in scene ${n} paragraph ${p} came in slowly over the black stones of the harbour wall.`,
      `Gulls wheeled above the masts while the fishermen argued about the weather and the price of salt.`,
      `She kept her hands in her coat and said nothing for a long while, thinking of the heir (${n}.${p}).`
    ].join(' ')
  )
}

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
  session = createProject(projectFolderFor(tmp, 'Perf'), 'Perf', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, first)?.parentId ?? ''
  const made = createRecord(db, { name: 'Mara', categoryId: 'character', force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  mara = made.record.id
  const ids = [first]
  for (let n = 2; n <= SCENES; n += 1) {
    ids.push(
      createNode(db, 'novel', {
        parentId: chapter,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: `Scene ${n}`
      }).id
    )
  }
  ids.forEach((nodeId, i) => {
    const texts = sceneText(i + 1)
    saveDocument(db, nodeId, doc(...texts))
    setSceneDetails(
      db,
      nodeId,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: i === 0 ? 1811 : null,
        alsoHere: []
      },
      NOW
    )
    const anchor = cardAnchorOf(db, nodeId)
    const opening = texts[0] ?? ''
    upsertCard(
      db,
      {
        nodeId,
        draftId: activeDraftId(db),
        readingId: null,
        line: 'A scene.',
        gist: 'A scene.',
        fields: {
          ...emptyCardFields(),
          pov: { value: mara, quote: opening.split('.')[0] ?? '', p: 0, verified: true },
          elapsed: { value: 'A season later', quote: 'A season later', p: 0, verified: false }
        },
        present: [{ recordId: mara, quote: 'Mara counted', p: 1, verified: true }],
        mood: null,
        theme: null,
        anchor,
        seen: anchor
      },
      NOW
    )
  })
  seedClaims(
    db,
    first,
    [
      {
        recordId: mara,
        slot: 'age',
        value: 'nineteen',
        quote: `Mara counted 1-2 ropes`,
        para: 2,
        proof: 'literal'
      }
    ],
    NOW
  )
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
