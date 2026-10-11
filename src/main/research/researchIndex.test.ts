import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import {
  indexNodePassages,
  indexOwner,
  pruneMemoryIndex,
  searchMemoryPassages,
  stalePassageOwners
} from '../memory/passageIndexer'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { ensureResearchRoot } from '../project/seed'
import { deleteNode, type TreeDb } from '../tree/treeStore'
import { addResearchFiles, createResearchNote, setResearchNotCanon } from './researchStore'

/**
 * F-16.8 (plan P1 §2.2): the story memory v2 passage index covers Research. A written page's
 * paragraphs are `note`, an upload's `research`; a page switched Not canon makes every paragraph
 * `notCanon`, a marked paragraph only itself; a deleted page's rows are pruned and never answered.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb

const at = new Date(Date.UTC(2026, 9, 11, 12, 0, 0))

const page = (...paragraphs: (string | { text: string; notCanon: true })[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((entry) =>
    typeof entry === 'string'
      ? { type: 'paragraph', content: [{ type: 'text', text: entry }] }
      : {
          type: 'paragraph',
          attrs: { notCanon: true },
          content: [{ type: 'text', text: entry.text }]
        }
  )
})

const hits = (query: string): [string, string, string, string][] =>
  searchMemoryPassages(db, query, { limit: 20 }).map((hit) => [
    hit.ownerId,
    hit.source,
    hit.canon,
    hit.label
  ])

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-research-index-'))
  session = createProject(projectFolderFor(tmp, 'Index'), 'Index', 'novel')
  db = session.connection.orm
  ensureResearchRoot(db)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the passage index covers Research (F-16.8)', () => {
  it('labels a written page note and an upload research, Not canon where marked', async () => {
    const note = createResearchNote(db, 'novel', { title: 'Musings' })
    saveDocument(
      db,
      note.id,
      page('The lighthouse keeper drinks.', { text: 'Maybe the lighthouse burns.', notCanon: true })
    )
    const added = await addResearchFiles(db, session.folder, 'novel', [
      { name: 'Coast.md', read: () => Buffer.from('The lighthouse stands on Gull Point.') }
    ])
    const upload = added.created[0] ?? ''
    expect(stalePassageOwners(db)).toEqual(
      expect.arrayContaining([
        { kind: 'research', id: note.id },
        { kind: 'research', id: upload }
      ])
    )
    expect(indexNodePassages(db, note.id, at)).toBe(true)
    expect(indexNodePassages(db, upload, at)).toBe(true)
    expect(indexOwner(db, 'research', note.id, at)).toBe(false)
    expect(hits('lighthouse').sort()).toEqual(
      [
        [note.id, 'note', 'canon', 'note'],
        [note.id, 'note', 'notCanon', 'notCanon'],
        [upload, 'research', 'canon', 'research']
      ].sort()
    )
    expect(stalePassageOwners(db).filter((owner) => owner.kind === 'research')).toEqual([])
  })

  it('reads every paragraph of a page switched Not canon as notCanon', () => {
    const note = createResearchNote(db, 'novel', {})
    saveDocument(db, note.id, page('Whales sing at dusk.', 'Whales sleep upright.'))
    indexOwner(db, 'research', note.id, at)
    setResearchNotCanon(db, note.id, true)
    expect(stalePassageOwners(db).filter((owner) => owner.kind === 'research')).toEqual([
      { kind: 'research', id: note.id }
    ])
    indexOwner(db, 'research', note.id, at)
    expect(hits('whales').map((hit) => hit[2])).toEqual(['notCanon', 'notCanon'])
  })

  it('prunes a deleted page and never answers its rows', () => {
    const note = createResearchNote(db, 'novel', {})
    saveDocument(db, note.id, page('Kelp forests sway.'))
    indexOwner(db, 'research', note.id, at)
    expect(hits('kelp')).toHaveLength(1)
    deleteNode(db, note.id)
    expect(hits('kelp')).toEqual([])
    expect(pruneMemoryIndex(db)).toBe(1)
    expect(() => indexOwner(db, 'research', note.id, at)).toThrow('Not a Research document')
  })
})
