import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gateSentences } from '@shared/memory/gate'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { activeDraftId } from '../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { nameScanShared, scanNamesFor } from '../memory/nameIndexer'
import { indexOwner, indexScene } from '../memory/passageIndexer'
import { revealIn, sceneTexts } from '../memory/reading/claimFixture'
import { writeSceneRead } from '../memory/reading/sceneReadStore'
import { createTopic } from '../memory/reading/topicStore'
import { createRecord } from '../memory/recordStore'
import { setSceneDetails } from '../memory/sceneDetailStore'

/**
 * A small story memory v2 book for Ms Scribe's tests (F-16.24, F-16.25, F-16.26): three scenes in
 * one chapter (1.1, 1.2, 1.3), Mara, Orrin and Tomas (characters), the Quay (a place) and the
 * secret "the sold map" revealed in 1.1. Claims are seeded by each test. Test support only.
 */

export interface ScribeBook {
  tmp: string
  session: ProjectSession
  db: TreeDb
  one: string
  two: string
  three: string
  mara: string
  orrin: string
  tomas: string
  quay: string
  map: string
}

export const SCRIBE_NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

export const doc = (
  ...paragraphs: (string | { text: string; notCanon?: boolean })[]
): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((each) => {
    const { text, notCanon } = typeof each === 'string' ? { text: each, notCanon: false } : each
    return {
      type: 'paragraph',
      ...(notCanon === true ? { attrs: { notCanon: true } } : {}),
      content: [{ type: 'text', text }]
    }
  })
})

export const SCENE_ONE = [
  'Mara watched the quay with her grey eyes.',
  'Tomas sold the map to a stranger.',
  'Orrin overheard Tomas from the yard.'
]
export const SCENE_TWO = [
  'Mara waited at the harbour with her hair cut short.',
  'Mara suspected the map was gone.'
]
export const SCENE_THREE = [
  'Mara’s eyes were brown in the lamplight.',
  'Mara learned the map was sold.'
]

function record(db: TreeDb, name: string, categoryId = 'character'): string {
  const made = createRecord(db, { name, categoryId, force: true }, SCRIBE_NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

/** Builds the book in a fresh temporary folder; the caller closes it with `closeScribeBook`. */
export function scribeBook(): ScribeBook {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-scribe-'))
  const session = createProject(projectFolderFor(tmp, 'Scribe'), 'Scribe', 'novel', {
    storyMemoryOverride: 'v2'
  })
  const db = session.connection.orm
  const one = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, one)?.parentId ?? ''
  const scene = (title: string): string =>
    createNode(db, 'novel', { parentId: chapter, kind: 'document', hierarchyLevel: 'scene', title })
      .id
  const two = scene('Two')
  const three = scene('Three')
  saveDocument(db, one, doc(...SCENE_ONE))
  saveDocument(db, two, doc(...SCENE_TWO))
  saveDocument(db, three, doc(...SCENE_THREE))
  const mara = record(db, 'Mara')
  const orrin = record(db, 'Orrin')
  const tomas = record(db, 'Tomas')
  const quay = record(db, 'the Quay', 'setting')
  for (const id of [one, two, three]) {
    scanNamesFor(db, id, SCRIBE_NOW)
    setSceneDetails(
      db,
      id,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: id === one ? [orrin, tomas] : [],
        flashback: null
      },
      SCRIBE_NOW
    )
  }
  const { recordId: map } = createTopic(
    db,
    {
      kind: 'secret',
      label: 'the sold map',
      quote: revealIn(db, one, { para: 1, quote: 'Tomas sold the map', label: 'the sold map' })
    },
    SCRIBE_NOW
  )
  return { tmp, session, db, one, two, three, mara, orrin, tomas, quay, map }
}

export function closeScribeBook(book: ScribeBook): void {
  book.session.close()
  fs.rmSync(book.tmp, { recursive: true, force: true })
}

/** Indexes every scene and record for the passage search, as the queue would. */
export function indexBook(
  db: TreeDb,
  ids: { scenes: readonly string[]; records: readonly string[] }
): void {
  for (const id of ids.scenes) indexScene(db, id, SCRIBE_NOW)
  for (const id of ids.records) indexOwner(db, 'record', id, SCRIBE_NOW)
}

/** A full reading of the scene as it is saved now: every finished sentence read, settled. */
export function readWhole(db: TreeDb, nodeId: string): void {
  const names = nameScanShared(db).index
  writeSceneRead(
    db,
    {
      nodeId,
      draftId: activeDraftId(db),
      entries: gateSentences(sceneTexts(db, nodeId), { caretPara: null, names }).map(
        (sentence) => [sentence.hash, sentence.text] as const
      ),
      full: true,
      readingId: null,
      topics: true,
      settled: true
    },
    SCRIBE_NOW
  )
}
