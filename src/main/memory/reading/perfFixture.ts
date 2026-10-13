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

/**
 * The novel-size book the perf tests read (F-16.23, F-16.24): 90 scenes of about 1,300 words in
 * one chapter, every one carded with a POV, a character on the page and an elapsed hint, Mara the
 * POV throughout, a typed year in the first scene and a stated age. `timeViews.perf.test.ts` and
 * `scribe/step0.perf.test.ts` build it; test support only.
 */

export const PERF_SCENES = 90
export const PERF_NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

export interface PerfBook {
  session: ProjectSession
  db: TreeDb
  mara: string
  /** The scenes in reading order. */
  ids: string[]
}

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

/** About 1,300 words: 40 paragraphs of four sentences, every sentence different. */
export function perfSceneText(n: number): string[] {
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

/** Builds the book in `dir` (an empty temporary folder). */
export function buildPerfBook(dir: string): PerfBook {
  const session = createProject(projectFolderFor(dir, 'Perf'), 'Perf', 'novel', {
    storyMemoryOverride: 'v2'
  })
  const db = session.connection.orm
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, first)?.parentId ?? ''
  const made = createRecord(db, { name: 'Mara', categoryId: 'character', force: true }, PERF_NOW)
  if (!('record' in made)) throw new Error('blocked')
  const mara = made.record.id
  const ids = [first]
  for (let n = 2; n <= PERF_SCENES; n += 1) {
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
    const texts = perfSceneText(i + 1)
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
      PERF_NOW
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
      PERF_NOW
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
    PERF_NOW
  )
  return { session, db, mara, ids }
}

/**
 * Milliseconds of the fastest of `runs` calls (the first, cold one is left out by the caller): what
 * the code costs, not what other test workers sharing the machine cost it.
 */
export function fastest(runs: number, call: () => unknown): number {
  let best = Infinity
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    call()
    best = Math.min(best, performance.now() - start)
  }
  return best
}
