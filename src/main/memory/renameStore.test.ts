import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dismissedKey } from '@shared/memory/dismissed'
import { describeRenamePreview, renamedPhraseKey } from '@shared/memory/rename'
import { docToText } from '@shared/docText'
import type { TiptapNodeT } from '@shared/tiptap'
import { draftText } from '../db/schema'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { duplicateDraft, listDrafts } from '../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listSnapshots } from '../snapshot/snapshotStore'
import { createNode, getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { dismiss, getDismissedByKey, listDismissed } from './dismissedStore'
import { createRecord, requireRecord } from './recordStore'
import {
  applyRename,
  clearRenameUndo,
  hasRenameUndo,
  previewRename,
  undoRename
} from './renameStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]
let hesk: string
let heskName: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const textOf = (id: string): string => {
  const content = getDocumentContent(db, id).content
  return content === null ? '' : docToText(content)
}

const draftTextOf = (draftId: string, nodeId: string): string => {
  const row = db
    .select()
    .from(draftText)
    .where(and(eq(draftText.draftId, draftId), eq(draftText.nodeId, nodeId)))
    .get()
  return row?.content == null ? '' : docToText(JSON.parse(row.content) as TiptapNodeT)
}

beforeEach(() => {
  clearRenameUndo()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-rename-'))
  session = createProject(projectFolderFor(tmp, 'Rename'), 'Rename', 'novel')
  db = session.connection.orm
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  const parentId = getNode(db, first)?.parentId ?? ''
  const second = createNode(db, 'novel', {
    parentId,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  const third = createNode(db, 'novel', {
    parentId,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Three'
  }).id
  scenes = [first, second, third]
  saveDocument(db, first, doc('Hesk came in.', "Hesk's coat was wet; Heskel stayed out."))
  saveDocument(db, second, doc('They waited for Hesk.'))
  saveDocument(db, third, doc('Nobody came. hesk is a word here.'))
  const made = createRecord(db, { name: 'Hesk', categoryId: 'character' }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  hesk = made.record.id
  heskName = made.record.aliases[0]?.id ?? ''
})
afterEach(() => {
  clearRenameUndo()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const request = (to = 'Haskel') => ({ recordId: hesk, aliasId: heskName, to })

describe('previewRename (F-16.13)', () => {
  it('counts whole-word matches per scene in reading order, possessives included', () => {
    const preview = previewRename(db, request())
    expect(preview.from).toBe('Hesk')
    expect(preview.to).toBe('Haskel')
    expect(preview.scenes.map((scene) => [scene.nodeId, scene.count])).toEqual([
      [scenes[0], 2],
      [scenes[1], 1]
    ])
    expect(preview.total).toBe(3)
    expect(preview.otherDrafts).toEqual({ matches: 0, scenes: 0 })
    expect(describeRenamePreview(preview)).toBe('3 matches in 2 scenes')
  })

  it('counts the inactive drafts apart', () => {
    const active = listDrafts(db).drafts[0]?.id ?? ''
    duplicateDraft(db, active, 'Second')
    const preview = previewRename(db, request())
    expect(preview.total).toBe(3)
    expect(preview.otherDrafts).toEqual({ matches: 3, scenes: 2 })
    expect(describeRenamePreview(preview)).toBe('3 matches in 2 scenes (+3 in other drafts)')
  })

  it('refuses a name that is not the record’s', () => {
    expect(() => previewRename(db, { ...request(), aliasId: 'nope' })).toThrow(/no longer/)
  })
})

describe('applyRename (F-16.13)', () => {
  it('rewrites every scene, the name and an inactive draft in one go, after a snapshot', () => {
    const active = listDrafts(db).drafts[0]?.id ?? ''
    duplicateDraft(db, active, 'Second')
    const other = listDrafts(db).drafts.find((each) => each.name === 'Second')?.id ?? ''
    const result = applyRename(db, { ...request(), openId: null }, NOW)
    expect(textOf(scenes[0] ?? '')).toBe(
      "Haskel came in.\nHaskel's coat was wet; Heskel stayed out."
    )
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Haskel.')
    // A lower-case word is not the name (its case rule is exact for a capitalised name).
    expect(textOf(scenes[2] ?? '')).toBe('Nobody came. hesk is a word here.')
    expect(draftTextOf(other, scenes[0] ?? '')).toContain("Haskel's coat")
    expect(result.written.map((each) => [each.id, each.count])).toEqual([
      [scenes[0], 2],
      [scenes[1], 1]
    ])
    expect(result.drafts).toBe(3)
    expect(result.record.name).toBe('Haskel')
    expect(requireRecord(db, hesk).aliases[0]?.norm).toBe('haskel')
    const snapshots = listSnapshots(db)
    expect(snapshots[0]?.kind).toBe('auto')
    expect(snapshots[0]?.name).toBe('Before renaming "Hesk" to "Haskel"')
    expect(hasRenameUndo()).toBe(true)
  })

  it('leaves the open scene to the editor and answers the match it should apply', () => {
    const result = applyRename(db, { ...request(), openId: scenes[0] ?? '' }, NOW)
    expect(textOf(scenes[0] ?? '')).toContain('Hesk came in.')
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Haskel.')
    expect(result.openId).toBe(scenes[0])
    expect(result.match).toEqual({
      query: 'Hesk',
      replacement: 'Haskel',
      matchCase: true,
      wholeWord: true
    })
    // The open scene's text is in the snapshot taken before.
    expect(listSnapshots(db)[0]?.docCount).toBeGreaterThan(0)
  })

  it('rewrites the Not a mention keys that hold the old name, any record’s', () => {
    const made = createRecord(db, { name: 'Mara', categoryId: 'character' }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    const mara = made.record.id
    const key = dismissedKey({ kind: 'notMention', recordId: mara, phrase: 'Hesk and Mara' })
    dismiss(
      db,
      {
        kind: 'notMention',
        key,
        recordId: mara,
        label: '"Hesk and Mara" is not Mara',
        quote: 'Hesk and Mara'
      },
      NOW
    )
    applyRename(db, { ...request(), openId: null }, NOW)
    const renamed = dismissedKey({ kind: 'notMention', recordId: mara, phrase: 'Haskel and Mara' })
    expect(getDismissedByKey(db, 'notMention', key)).toBeNull()
    expect(getDismissedByKey(db, 'notMention', renamed)?.quote).toBe('Haskel and Mara')
    undoRename(db, NOW)
    expect(getDismissedByKey(db, 'notMention', key)?.label).toBe('"Hesk and Mara" is not Mara')
    expect(listDismissed(db).count).toBe(1)
  })

  it('refuses another record’s name and the name it already has', () => {
    const made = createRecord(db, { name: 'Haskel', categoryId: 'character', force: true }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    expect(() => applyRename(db, { ...request(), openId: null }, NOW)).toThrow(
      /already a name of Haskel/
    )
    expect(() => applyRename(db, { ...request('Hesk'), openId: null }, NOW)).toThrow(
      /already its name/
    )
    // Nothing was written by the refused renames.
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Hesk.')
    expect(listSnapshots(db)).toEqual([])
  })
})

describe('undoRename (F-16.13)', () => {
  it('restores every scene, draft and the name', () => {
    const active = listDrafts(db).drafts[0]?.id ?? ''
    duplicateDraft(db, active, 'Second')
    const other = listDrafts(db).drafts.find((each) => each.name === 'Second')?.id ?? ''
    applyRename(db, { ...request(), openId: null }, NOW)
    const undone = undoRename(db, NOW)
    expect(undone.restored.map((each) => each.id).sort()).toEqual(
      [scenes[0] ?? '', scenes[1] ?? ''].sort()
    )
    expect(undone.skipped).toEqual([])
    expect(undone.drafts).toEqual({ restored: 2, skipped: 0 })
    expect(undone.nameRestored).toBe(true)
    expect(undone.record?.name).toBe('Hesk')
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Hesk.')
    expect(draftTextOf(other, scenes[0] ?? '')).toContain("Hesk's coat")
    expect(hasRenameUndo()).toBe(false)
  })

  it('skips a scene edited since the rename and names it', () => {
    applyRename(db, { ...request(), openId: null }, NOW)
    saveDocument(db, scenes[1] ?? '', doc('They waited for Haskel, long.'))
    const undone = undoRename(db, NOW)
    expect(undone.skipped).toEqual([{ id: scenes[1], title: 'Two' }])
    expect(undone.restored.map((each) => each.id)).toEqual([scenes[0]])
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Haskel, long.')
    expect(textOf(scenes[0] ?? '')).toContain('Hesk came in.')
  })

  it('leaves the name when it was changed again since', () => {
    applyRename(db, { ...request(), openId: null }, NOW)
    applyRename(db, { ...request('Hasko'), openId: null }, NOW)
    // Only the last rename can be undone: it goes back to Haskel.
    expect(undoRename(db, NOW).record?.name).toBe('Haskel')
    expect(() => undoRename(db, NOW)).toThrow(/no rename/)
  })
})

describe('renamedPhraseKey (F-16.13)', () => {
  it('replaces the norm as a whole word only', () => {
    expect(renamedPhraseKey('r1|old hesk said', 'hesk', 'haskel')).toBe('r1|old haskel said')
    expect(renamedPhraseKey('r1|old heskel said', 'hesk', 'haskel')).toBeNull()
    expect(renamedPhraseKey('broken', 'hesk', 'haskel')).toBeNull()
  })
})
