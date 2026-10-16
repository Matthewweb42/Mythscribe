import { notebookDocFromText } from '@shared/notebook'
import { getSceneMeta, setSceneMeta } from '../../document/sceneMetaStore'
import { createEntity } from '../../entity/entityStore'
import { createNotebookItem } from '../../notebook/notebookStore'
import { getEditorSettings, setEditorSettings } from '../../project/settingsStore'
import { addDocumentTag } from '../../tag/documentTagStore'
import { createTag } from '../../tag/tagStore'
import type { TreeDb } from '../../tree/treeStore'

/**
 * Test fixture (notes redesign, 2026-10-15): a v1 scene with old story-bible data (Wren's sheet
 * linked through the scene's tag, a tone tag) and a note page the scene's synopsis names, with the
 * old story bible archived. A prompt built for the scene carries the page and none of the rest.
 */

/** The value of Wren's sheet, which no prompt may carry while the old story bible is archived. */
export const ARCHIVED_SHEET_VALUE = 'Grey eyes and a burn scar across the left hand'
/** The text of the note page "Wren — powers", named by the scene's synopsis. */
export const NAMED_NOTE_TEXT = 'Wren hears stone through her boots.'
/** What the old story bible and the scene steer would add to a prompt: none may appear. */
export const ARCHIVED_BIBLE_MARKERS = [
  ARCHIVED_SHEET_VALUE,
  'Characters: ',
  '; tagged ',
  'Tone: tense'
] as const

export function seedArchivedBible(db: TreeDb, sceneId: string): void {
  setEditorSettings(db, { ...getEditorSettings(db, 'novel'), unarchived: [] })
  const wren = createEntity(db, {
    kind: 'character',
    name: 'Wren',
    fields: { appearance: ARCHIVED_SHEET_VALUE }
  }).entity
  if (wren.tagId !== null) addDocumentTag(db, sceneId, wren.tagId)
  const tense = createTag(db, { name: 'tense', category: 'tone', color: '#112233' })
  addDocumentTag(db, sceneId, tense.id)
  createNotebookItem(db, {
    parentId: null,
    kind: 'page',
    title: 'Wren — powers',
    content: notebookDocFromText(NAMED_NOTE_TEXT)
  })
  setSceneMeta(db, sceneId, {
    ...getSceneMeta(db, sceneId).meta,
    synopsis: 'Wren waits at the ferry.'
  })
}
