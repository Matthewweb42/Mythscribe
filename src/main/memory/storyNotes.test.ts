import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOT_CANON_ATTR } from '@shared/memory/pageMarks'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { emptySceneMeta } from '@shared/sceneMeta'
import { STORY_BIBLE_GHOST_TOKEN_BUDGET, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { assignLabel, createLabel } from './labelStore'
import { scanNamesFor } from './nameIndexer'
import { createRecord, savePage } from './recordStore'
import { setSceneDetails } from './sceneDetailStore'
import { buildStoryNotes, storyNotesFacts, typedSceneMeta } from './storyNotes'

let tmp: string
let session: ProjectSession
let db: TreeDb

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 12, 12, minute, 0))
const scene = (): string => manuscriptDocuments(db)[0]?.id ?? ''

const paragraph = (text: string, notCanon = false): TiptapNodeT => ({
  type: 'paragraph',
  ...(notCanon ? { attrs: { [NOT_CANON_ATTR]: true } } : {}),
  content: [{ type: 'text', text }]
})
const doc = (...texts: string[]): TiptapNodeT => ({
  type: 'doc',
  content: texts.map((text) => paragraph(text))
})

const record = (name: string, categoryId = 'character', aliases: string[] = []): string => {
  const made = createRecord(
    db,
    { name, categoryId, aliases: aliases.map((text) => ({ text })), force: true },
    at(0)
  )
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-story-notes-'))
  session = createProject(projectFolderFor(tmp, 'Notes'), 'Notes', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildStoryNotes (F-16.14)', () => {
  it('gathers Here from the typed details, Named from the scan, Pinned canon text and the labels', () => {
    const mara = record('Mara Vell', 'character', ['Mara'])
    const orrin = record('Orrin Dask')
    const tomas = record('Tomas Harrow', 'character', ['Tomas'])
    const gull = record('Gullhaven', 'setting')
    savePage(
      db,
      mara,
      'pinned',
      { type: 'doc', content: [paragraph('Eyes: grey'), paragraph('SECRET-NOT-CANON', true)] },
      at(1)
    )
    savePage(db, mara, 'ideas', doc('IDEA-TEXT: Mara could be a ghost'), at(1))
    savePage(db, tomas, 'pinned', doc('Height: tall'), at(1))
    setSceneDetails(
      db,
      scene(),
      {
        povRecordId: mara,
        place: { recordId: gull, text: 'the quay' },
        time: { text: 'dusk' },
        storyYear: 1814,
        alsoHere: [orrin],
        flashback: null
      },
      at(2)
    )
    saveDocument(db, scene(), doc('Tomas waved. Tomas laughed.', 'Mara watched Gullhaven burn.'))
    scanNamesFor(db, scene(), at(3))
    const tense = createLabel(db, { name: 'tense', kind: 'tone' }, at(4))
    const custom = createLabel(db, { name: 'needs research', kind: 'custom' }, at(4))
    assignLabel(db, tense.id, scene())
    assignLabel(db, custom.id, scene())

    const block = buildStoryNotes(db, { nodeId: scene(), maxTokens: STORY_BIBLE_TOKEN_BUDGET })
    expect(block).toBe(
      [
        STORY_NOTES_HEADING,
        'Here: Mara Vell (POV), Orrin Dask',
        // Tomas is named twice, Gullhaven once; Mara is here, so not listed again.
        'Named: Tomas Harrow, Gullhaven',
        'Mara Vell (Mara): Eyes: grey.',
        'Tomas Harrow (Tomas): Height: tall.',
        'Tone (write in it): tense'
      ].join('\n')
    )
    expect(block).not.toContain('SECRET-NOT-CANON')
    expect(block).not.toContain('IDEA-TEXT')
    expect(
      buildStoryNotes(db, { nodeId: scene(), maxTokens: STORY_BIBLE_GHOST_TOKEN_BUDGET })
    ).toContain('Here: Mara Vell (POV)')

    expect(typedSceneMeta(db, scene(), emptySceneMeta())).toEqual({
      location: 'Gullhaven, the quay',
      pov: 'Mara Vell',
      timeline: 'dusk, year 1814',
      brief: emptySceneMeta().brief
    })
  })

  it('is null with no document, for a gone node, and for a scene with nothing to tell', () => {
    expect(buildStoryNotes(db, { nodeId: null, maxTokens: 400 })).toBeNull()
    expect(buildStoryNotes(db, { nodeId: 'gone', maxTokens: 400 })).toBeNull()
    expect(storyNotesFacts(db, 'gone')).toBeNull()
    expect(buildStoryNotes(db, { nodeId: scene(), maxTokens: 400 })).toBeNull()
    expect(typedSceneMeta(db, scene(), emptySceneMeta())).toBeNull()
  })
})
