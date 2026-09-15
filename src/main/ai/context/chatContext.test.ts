import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHAT_REF_NOTES_CHAR_BUDGET, CHAT_SCENE_CHAR_BUDGET } from '@shared/chat'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { saveNotes } from '../../document/notesStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { addDocumentTag } from '../../tag/documentTagStore'
import { createTag } from '../../tag/tagStore'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { buildChatContext } from './chatContext'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let chapter: string
/** A second document (front matter) that never gets notes. */
let other: string

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-chatctx-'))
  session = createProject(projectFolderFor(tmp, 'Ctx'), 'Ctx', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  chapter = rows.find((r) => r.kind === 'folder' && r.hierarchyLevel === 'chapter')?.id ?? ''
  other = rows.find((r) => r.kind === 'document' && r.id !== scene)?.id ?? ''
  if (!scene || !chapter || !other) throw new Error('skeleton not seeded')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildChatContext (F-5.4)', () => {
  it('carries the scene text and its metadata, and nothing with no scene open', () => {
    saveDocument(db, scene, doc('The storm broke at dusk.'))
    setSceneMeta(db, scene, { location: 'Ridge', pov: '', timeline: '' })
    expect(buildChatContext(db, { nodeId: scene, message: 'Why?' })).toEqual({
      sceneText: 'The storm broke at dusk.',
      sceneMeta: { location: 'Ridge', pov: '', timeline: '' },
      refs: [],
      refNames: []
    })
    expect(buildChatContext(db, { nodeId: null, message: 'Why?' })).toEqual({
      sceneText: '',
      sceneMeta: null,
      refs: [],
      refNames: []
    })
  })

  it('answers an empty scene text and null metadata for a scene with nothing written', () => {
    expect(buildChatContext(db, { nodeId: scene, message: 'Why?' })).toMatchObject({
      sceneText: '',
      sceneMeta: null
    })
  })

  it('head-truncates the scene text to CHAT_SCENE_CHAR_BUDGET and marks the cut', () => {
    saveDocument(db, scene, doc('s'.repeat(CHAT_SCENE_CHAR_BUDGET + 50)))
    const { sceneText } = buildChatContext(db, { nodeId: scene, message: 'Why?' })
    expect(sceneText).toBe(`${'s'.repeat(CHAT_SCENE_CHAR_BUDGET)}…`)
  })

  it('pulls the notes of the documents linked to each #name in the bank, and ignores unknown names', () => {
    const mara = createTag(db, { name: 'Mara', category: 'character', color: '#112233' })
    const ridge = createTag(db, { name: 'ridge', category: 'setting', color: '#112233' })
    addDocumentTag(db, scene, mara.id)
    addDocumentTag(db, chapter, mara.id)
    addDocumentTag(db, chapter, ridge.id)
    saveNotes(db, scene, doc('Mara is the ferryman’s daughter.'))
    saveNotes(db, chapter, doc('Chapter notes: the confrontation.'))
    const ctx = buildChatContext(db, {
      nodeId: null,
      message: 'What does #Mara want on the #ridge? And #nobody?'
    })
    expect(ctx.refNames).toEqual(['mara', 'ridge'])
    expect(ctx.refs).toEqual([
      {
        name: 'mara',
        notes: 'Chapter notes: the confrontation.\n\nMara is the ferryman’s daughter.'
      },
      { name: 'ridge', notes: 'Chapter notes: the confrontation.' }
    ])
  })

  it('lists a matched tag without notes in refNames only, and shares the notes budget across the refs that have any', () => {
    const mara = createTag(db, { name: 'mara', category: 'character', color: '#112233' })
    const tomas = createTag(db, { name: 'tomas', category: 'character', color: '#112233' })
    const bare = createTag(db, { name: 'bare', category: 'custom', color: '#112233' })
    addDocumentTag(db, scene, mara.id)
    addDocumentTag(db, chapter, tomas.id)
    addDocumentTag(db, other, bare.id)
    saveNotes(db, scene, doc('m'.repeat(CHAT_REF_NOTES_CHAR_BUDGET)))
    saveNotes(db, chapter, doc('t'.repeat(CHAT_REF_NOTES_CHAR_BUDGET)))
    const ctx = buildChatContext(db, { nodeId: null, message: '#mara #tomas #bare' })
    const share = CHAT_REF_NOTES_CHAR_BUDGET / 2
    expect(ctx.refNames).toEqual(['mara', 'tomas', 'bare'])
    expect(ctx.refs).toEqual([
      { name: 'mara', notes: `${'m'.repeat(share)}…` },
      { name: 'tomas', notes: `${'t'.repeat(share)}…` }
    ])
  })

  it('refuses an unknown node with NOT_FOUND and a folder with VALIDATION', () => {
    expect(() => buildChatContext(db, { nodeId: 'nope', message: 'x' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    expect(() => buildChatContext(db, { nodeId: chapter, message: 'x' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
  })
})
