import { normName } from '@shared/memory/names'
import { dismissedKey } from '@shared/memory/dismissed'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { activeDraftId, duplicateDraft, switchDraft } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { getCompileState, setCompileState } from '../../project/settingsStore'
import { createNode, deleteNode, listNodes, type TreeDb } from '../../tree/treeStore'
import { dismiss } from '../dismissedStore'
import { scanNamesFor } from '../nameIndexer'
import { createRecord, savePage } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { TEST_BOOK, testBookScene } from './book'
import { TEST_BOOK_LABELS } from './labels'
import type { LabelQuestion } from './labels.schema'

/**
 * The test book as a story memory v2 project (F-16.17; plan P2a §2.7): its records with their
 * names (shared surnames shared, the Captain matched in exact case), the Dismissed names, one
 * chapter per book chapter with its scenes and typed details, the Idea scene (h11) with the Idea
 * status, the cut scene (h12) left out of compile, and the earlier draft of chapter 14 (h10) as an
 * inactive draft of h09's scene. Built for the offline replays and the live runs
 * (`ai/eval/memory.eval.ts`, `ai/eval/knows.eval.ts`, `ai/eval/scribe.eval.ts`, which also adds
 * the labelled record pages and the author's late edits); test data only.
 */

export interface TestBookProject {
  session: ProjectSession
  db: TreeDb
  /** Label record id → the project's record id. */
  records: Map<string, string>
  /** Test-book scene id → node id (h10 maps to h09's node, in the inactive draft). */
  scenes: Map<string, string>
  /** The inactive draft holding h10. */
  inactiveDraftId: string
}

const doc = (paragraphs: readonly string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

/** The category a label record is made in (secrets and threads come from P2b, never a category). */
const CATEGORY: Readonly<Record<string, string | undefined>> = {
  character: 'character',
  place: 'setting',
  thing: 'item',
  group: 'faction',
  term: 'lore'
}

/** Builds the project in `dir` (an empty temporary folder). */
export function buildTestBookProject(dir: string, now: Date): TestBookProject {
  const session = createProject(projectFolderFor(dir, 'Test book'), 'Test book', 'novel', {
    storyMemoryOverride: 'v2'
  })
  const db = session.connection.orm
  const records = new Map<string, string>()
  for (const label of TEST_BOOK_LABELS.records) {
    const categoryId = CATEGORY[label.kind]
    if (categoryId === undefined) continue
    const main = normName(label.name)
    const made = createRecord(
      db,
      {
        name: label.name,
        categoryId,
        aliases: label.aliases
          .filter((alias) => normName(alias.text) !== main)
          .map((alias) => ({
            text: alias.text,
            shared: alias.shared ?? false,
            // The author confirmed the title alone as a name (identity rule 2): exact case.
            ...(alias.text === 'the Captain' ? { caseRule: 'exact' as const } : {})
          })),
        force: true
      },
      now
    )
    if (!('record' in made)) throw new Error(`The test book's ${label.name} was blocked`)
    records.set(label.id, made.record.id)
  }
  for (const name of TEST_BOOK_LABELS.dismissed) {
    dismiss(
      db,
      {
        kind: 'name',
        key: dismissedKey({ kind: 'name', name }),
        label: `${name}: not a name`,
        quote: name
      },
      now
    )
  }

  const nodes = listNodes(db)
  const part = nodes.find((row) => row.hierarchyLevel === 'part')
  if (part === undefined) throw new Error('The new project has no part')
  const seeded = nodes.filter((row) => row.hierarchyLevel === 'chapter')
  const chapters = new Map<number, string>()
  const scenes = new Map<string, string>()
  const excluded: string[] = []
  for (const scene of TEST_BOOK) {
    if (scene.source === 'inactiveDraft') continue
    let chapter = chapters.get(scene.chapter)
    if (chapter === undefined) {
      chapter = createNode(db, 'novel', {
        parentId: part.id,
        kind: 'folder',
        hierarchyLevel: 'chapter',
        title: `Chapter ${scene.chapter}`
      }).id
      chapters.set(scene.chapter, chapter)
    }
    const node = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: scene.title
    }).id
    scenes.set(scene.id, node)
    saveDocument(db, node, doc(scene.paragraphs))
    const details = scene.details
    if (details !== undefined) {
      setSceneDetails(
        db,
        node,
        {
          povRecordId: details.pov === undefined ? null : (records.get(details.pov) ?? null),
          place: {
            recordId: details.place === undefined ? null : (records.get(details.place) ?? null),
            text: ''
          },
          time: { text: details.time ?? '' },
          storyYear: details.year ?? null,
          alsoHere: []
        },
        now
      )
    }
    if (scene.source === 'ideaScene') {
      setSceneMeta(db, node, { ...parseStoredSceneMeta(null), status: 'idea' })
    }
    if (scene.source === 'excludedScene') excluded.push(node)
  }
  for (const chapter of seeded) deleteNode(db, chapter.id)
  setCompileState(db, { ...getCompileState(db), excluded })

  // h10 is the earlier draft of chapter 14: h09's scene in an inactive draft.
  const later = TEST_BOOK.find((scene) => scene.source === 'inactiveDraft')
  const target = later === undefined ? undefined : scenes.get('h09')
  const active = activeDraftId(db)
  const list = duplicateDraft(db, active, 'Earlier draft')
  const inactiveDraftId = list.drafts.find((each) => each.id !== active)?.id ?? ''
  if (later !== undefined && target !== undefined) {
    switchDraft(db, inactiveDraftId)
    saveDocument(db, target, doc(later.paragraphs))
    switchDraft(db, active)
    scenes.set(later.id, target)
  }
  for (const node of new Set(scenes.values())) scanNamesFor(db, node, now)
  return { session, db, records, scenes, inactiveDraftId }
}

/**
 * P3 (plan §6.1): the record pages the labels give (the Bell's Pinned notes, the Captain's and
 * Lottie's Ideas), written as the author would write them. The caller indexes them.
 */
export function addTestBookPages(book: TestBookProject, now: Date): void {
  for (const page of TEST_BOOK_LABELS.pages) {
    const recordId = book.records.get(page.record)
    if (recordId === undefined) throw new Error(`The test book has no record ${page.record}`)
    savePage(book.db, recordId, page.page, doc(page.lines), now)
  }
}

/** A labelled question's late edit: the scene's paragraph as the author changed it. */
export function editedParagraphs(edit: NonNullable<LabelQuestion['edit']>): string[] {
  return testBookScene(edit.scene).paragraphs.map((text, p) =>
    p === edit.p ? text.replace(edit.from, edit.to) : text
  )
}

/**
 * P3: the author's late edit a question labels, saved after the book was read (the caller runs
 * the anchors check and the passage index, as the app's queue would).
 */
export function editTestBook(
  book: TestBookProject,
  edit: NonNullable<LabelQuestion['edit']>
): void {
  const nodeId = book.scenes.get(edit.scene)
  if (nodeId === undefined) throw new Error(`The test book has no scene ${edit.scene}`)
  saveDocument(book.db, nodeId, doc(editedParagraphs(edit)))
}
