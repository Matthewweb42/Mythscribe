import { NOT_CANON_ATTR } from '@shared/memory/pageMarks'
import type { TiptapNodeT } from '@shared/tiptap'
import type { TreeDb } from '../tree/treeStore'
import { assignLabel, createLabel } from './labelStore'
import { createRecord, savePage } from './recordStore'
import { setSceneDetails } from './sceneDetailStore'

/**
 * The story-memory v2 facts the feature tests seed (F-16.14): a POV record with a Pinned canon
 * line, a Not canon line and an Ideas page, the scene's typed details, and a tone label. A test
 * then asserts that a v2 request carries the Story notes block (and never the Not canon or Ideas
 * text) while a v1 request carries the story bible and no Story notes. Test support only.
 */

export const SEEDED_CANON_LINE = 'Eyes: grey'
export const SEEDED_NOT_CANON_TEXT = 'SEEDED-NOT-CANON rumour'
export const SEEDED_IDEA_TEXT = 'SEEDED-IDEA maybe a ghost'
export const SEEDED_TONE = 'hushed'

const paragraph = (text: string, notCanon = false): TiptapNodeT => ({
  type: 'paragraph',
  ...(notCanon ? { attrs: { [NOT_CANON_ATTR]: true } } : {}),
  content: [{ type: 'text', text }]
})

/** Seeds the facts on `sceneId`; answers the POV record's id. */
export function seedStoryNotes(db: TreeDb, sceneId: string, now: Date): string {
  const made = createRecord(db, { name: 'Mara Vell', categoryId: 'character', force: true }, now)
  if (!('record' in made)) throw new Error('the seeded record was blocked')
  const id = made.record.id
  savePage(
    db,
    id,
    'pinned',
    {
      type: 'doc',
      content: [paragraph(SEEDED_CANON_LINE), paragraph(SEEDED_NOT_CANON_TEXT, true)]
    },
    now
  )
  savePage(db, id, 'ideas', { type: 'doc', content: [paragraph(SEEDED_IDEA_TEXT)] }, now)
  setSceneDetails(
    db,
    sceneId,
    {
      povRecordId: id,
      place: { recordId: null, text: 'the quay' },
      time: { text: 'dusk' },
      storyYear: null,
      alsoHere: []
    },
    now
  )
  const tone = createLabel(db, { name: SEEDED_TONE, kind: 'tone' }, now)
  assignLabel(db, tone.id, sceneId)
  return id
}
