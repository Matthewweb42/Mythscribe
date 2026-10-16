import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { notebookDocFromText, type NotebookItem } from '@shared/notebook'
import { NOTES_SORT_CHUNK_CHARS } from '@shared/notesSort'
import type { TiptapNodeT } from '@shared/tiptap'
import { defaultAiUsageState, dayOf } from '../ai/dailyCap'
import { resetInflight } from '../ai/inflight'
import { NOTES_SORT_SENTINEL } from '../ai/prompts/notesSort.v1'
import type { CompletionRequest, CompletionResult, Provider } from '../ai/providers/types'
import { InvalidKeyError } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import type { UsageEntry } from '../ai/usageStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import {
  createNotebookItem,
  deleteNotebookItem,
  getNotebookPage,
  listNotebook,
  listNotebookVersions,
  restoreNotebookVersion
} from './notebookStore'
import {
  estimateNotesSort,
  notesListing,
  parseSortAnswer,
  runNotesSort,
  sortedBlocks,
  sortSourceText,
  type NotesSortOutcome
} from './notesSort'

const NOW = new Date(2026, 9, 16, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let changed: string[][]

const WORLD: TiptapNodeT = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Fenlands' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'A drowned country of reed.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Mara' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Ferry keeper. Fears the sea.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Rook' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'A smuggler with no real name.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Shadow walking' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Each walk costs a memory.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Only fen-witches can do it.' }] }
  ]
}

function replies(...values: unknown[]): void {
  for (const value of values) {
    complete.mockResolvedValueOnce({
      text: typeof value === 'string' ? value : JSON.stringify(value),
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 900, outputTokens: 300 }
    })
  }
}

const byTitle = (title: string): NotebookItem | undefined =>
  listNotebook(db).find((item) => item.title === title)

const sortDeps = (live = true): Parameters<typeof runNotesSort>[0] => ({
  db,
  requestDeps: deps,
  notebookChanged: (ids) => void changed.push(ids),
  live: () => live,
  signal: new AbortController().signal,
  runId: 'r1'
})

/** The renderer's one Undo: the topmost items it made deleted, the pages it appended to put back. */
function undoSort(outcome: NotesSortOutcome): void {
  const made = new Set(outcome.made.map((item) => item.id))
  for (const item of outcome.made) {
    if (item.parentId === null || !made.has(item.parentId)) deleteNotebookItem(db, item.id)
  }
  for (const entry of outcome.appended) restoreNotebookVersion(db, entry.versionId)
}

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-notes-sort-'))
  session = createProject(projectFolderFor(tmp, 'Sort'), 'Sort', 'novel')
  db = session.connection.orm
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  ledger = []
  changed = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'deepseek-v4-flash' : 'deepseek-v4-pro'),
    complete,
    stream: async function* (req) {
      const reply = await complete(req)
      yield { delta: reply.text, usage: reply.usage }
    },
    testConnection: () => Promise.resolve({ model: 'deepseek-v4-flash' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: { get: () => undefined, put: () => {} },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})

afterEach(() => {
  session.connection.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('what a sort sends', () => {
  it('writes a page as paragraphs with its headings marked', () => {
    expect(sortSourceText(WORLD)).toBe(
      '# Fenlands\n\nA drowned country of reed.\n\n## Mara\n\nFerry keeper. Fears the sea.\n\n' +
        '## Rook\n\nA smuggler with no real name.\n\n## Shadow walking\n\nEach walk costs a memory.' +
        '\n\nOnly fen-witches can do it.'
    )
    expect(sortSourceText(null)).toBe('')
  })

  it('lists her folders then her pages by path, the Templates folder left out', () => {
    const chars = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'Characters' })
    createNotebookItem(db, { parentId: chars.id, kind: 'page', title: 'Mara' })
    const templates = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'Templates' })
    createNotebookItem(db, { parentId: templates.id, kind: 'page', title: 'Villain' })
    createNotebookItem(db, { parentId: null, kind: 'page', title: 'Ideas' })
    // The notes binder: the sections are folders she may name; the rest sits in Documents.
    expect(notesListing(listNotebook(db))).toBe(
      'Folders: Outline; Timeline; Documents; Documents › Characters\n' +
        'Pages: Documents › Characters › Mara; Documents › Ideas'
    )
    expect(notesListing([])).toBe('')
  })

  it('prices one request a part, the listing in every prompt', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of the almanac, about the fen.`)
    const text = long.join('\n\n')
    expect(text.length).toBeGreaterThan(NOTES_SORT_CHUNK_CHARS)
    const estimate = estimateNotesSort(
      [
        { pageId: null, title: 'Almanac', text },
        { pageId: null, title: 'Empty', text: '' }
      ],
      []
    )
    expect(estimate.sources).toBe(1)
    expect(estimate.requests).toBe(2)
    expect(estimate.words).toBe(400 * 8)
    expect(estimate.tokensIn).toBeGreaterThan(text.length / 4)
    expect(estimate.tokensOut).toBeGreaterThan(text.length / 4)
  })
})

describe('her answer (parseSortAnswer)', () => {
  const part = sortSourceText(WORLD)

  it('keeps pages whose every line is in the part, folding spaces and quotes', () => {
    const parsed = parseSortAnswer(
      JSON.stringify({
        pages: [
          { folder: 'Characters', title: ' Mara ', text: 'Ferry   keeper.\n\nFears the sea.' },
          {
            folder: '',
            title: 'Shadow walking',
            text: '## Shadow walking\nEach walk costs a memory.'
          }
        ]
      }),
      part
    )
    expect(parsed.dropped).toBe(0)
    expect(parsed.pages).toEqual([
      { folder: 'Characters', title: 'Mara', text: 'Ferry   keeper.\nFears the sea.' },
      { folder: '', title: 'Shadow walking', text: '## Shadow walking\nEach walk costs a memory.' }
    ])
  })

  it('drops a page with an invented line, one with no title or text, and refuses a bad answer', () => {
    const parsed = parseSortAnswer(
      JSON.stringify({
        pages: [
          {
            folder: 'Characters',
            title: 'Rook',
            text: 'A smuggler with no real name.\nHe is tall.'
          },
          { title: '', text: 'A drowned country of reed.' },
          { title: 'Fenlands', text: '' },
          'not a page',
          { title: 'Fenlands', text: 'A drowned country of reed.' }
        ]
      }),
      part
    )
    expect(parsed.pages.map((page) => page.title)).toEqual(['Fenlands'])
    expect(parsed.dropped).toBe(4)
    expect(() => parseSortAnswer('not json', part)).toThrow('expected format')
    expect(() => parseSortAnswer('{"notes":[]}', part)).toThrow('expected format')
  })

  it('makes a line of # marks a heading of at most level 3', () => {
    expect(sortedBlocks('#### Deep\nPlain')).toEqual([
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Deep' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Plain' }] }
    ])
  })
})

describe('a sort (runNotesSort)', () => {
  it('writes her pages into folders, reusing one by name, appending to her page, keeping the document', async () => {
    const chars = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'Characters' })
    const mara = createNotebookItem(db, {
      parentId: chars.id,
      kind: 'page',
      title: 'Mara',
      content: notebookDocFromText('Eyes: grey.')
    })
    const source = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Fenlands',
      content: WORLD
    })
    const before = listNotebook(db)
    replies({
      pages: [
        { folder: 'characters', title: 'Mara', text: 'Ferry keeper. Fears the sea.' },
        { folder: 'Characters', title: 'Rook', text: 'A smuggler with no real name.' },
        { folder: 'Magic', title: 'Shadow walking', text: 'Each walk costs a memory.' },
        { folder: 'Magic', title: 'Shadow walking', text: 'Only fen-witches can do it.' },
        { folder: 'Magic', title: 'Blood rites', text: 'Blood buys a storm.' }
      ]
    })

    const outcome = await runNotesSort(sortDeps(), [source.id])

    const request = complete.mock.calls[0]?.[0]
    expect(request?.messages[0]?.content.startsWith(NOTES_SORT_SENTINEL)).toBe(true)
    expect(request?.messages[0]?.content).toContain(
      'Folders: Outline; Timeline; Documents; Documents › Characters\n' +
        'Pages: Documents › Characters › Mara; Documents › Fenlands'
    )
    expect(request?.messages[1]?.content.startsWith('# Document: Fenlands\n# Fenlands')).toBe(true)
    expect(ledger.map((entry) => entry.feature)).toEqual(['notesSort'])

    // A folder she names that is not a section is made in Documents.
    const magic = byTitle('Magic')
    expect(magic).toMatchObject({ kind: 'folder', parentId: byTitle('Documents')?.id })
    expect(listNotebook(db).filter((item) => item.title === 'Magic')).toHaveLength(1)
    expect(byTitle('Rook')?.parentId).toBe(chars.id)
    expect(byTitle('Blood rites')).toBeUndefined()
    const walking = byTitle('Shadow walking')
    expect(walking?.parentId).toBe(magic?.id)
    // A page this sort made takes the second part as it is, no heading, no version.
    expect(getNotebookPage(db, walking?.id ?? '').plain).toBe(
      'Each walk costs a memory.\nOnly fen-witches can do it.'
    )
    expect(listNotebookVersions(db, walking?.id ?? '')).toEqual([])
    // Her page gets the text under the document's title; the version kept first is the Undo.
    expect(getNotebookPage(db, mara.id).plain).toBe(
      'Eyes: grey.\nFenlands\nFerry keeper. Fears the sea.'
    )
    const kept = listNotebookVersions(db, mara.id)
    expect(kept.map((version) => version.author)).toEqual(['ai'])
    expect(getNotebookPage(db, source.id).plain).toContain('Each walk costs a memory.')

    expect(outcome).toMatchObject({ pages: 3, dropped: 1, unread: 0, stopped: null })
    expect(outcome.made.map((item) => item.title)).toEqual(['Rook', 'Magic', 'Shadow walking'])
    expect(outcome.appended).toEqual([{ pageId: mara.id, versionId: kept[0]?.id, title: 'Mara' }])
    expect(changed.flat()).toEqual(expect.arrayContaining([mara.id, magic?.id, walking?.id]))

    // The one Undo puts Notes back as it was.
    undoSort(outcome)
    expect(listNotebook(db).map((item) => [item.id, item.title, item.parentId])).toEqual(
      before.map((item) => [item.id, item.title, item.parentId])
    )
    expect(getNotebookPage(db, mara.id).plain).toBe('Eyes: grey.')
  })

  it('never appends to the document being sorted, and goes on past a part it cannot read', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Fact ${i}: the reeds grow ${i} feet.`)
    const source = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Almanac',
      content: notebookDocFromText(long.join('\n'))
    })
    replies('not json', { pages: [{ folder: '', title: 'Almanac', text: long[399] }] })
    const outcome = await runNotesSort(sortDeps(), [source.id])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(outcome).toMatchObject({ pages: 1, unread: 1 })
    const pages = listNotebook(db).filter((item) => item.title === 'Almanac')
    expect(pages).toHaveLength(2)
    expect(getNotebookPage(db, source.id).plain.split('\n')).toHaveLength(400)
  })

  it('throws a provider error before anything is written, and stops on one after', async () => {
    const source = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Fenlands',
      content: WORLD
    })
    complete.mockRejectedValueOnce(new InvalidKeyError('The key was refused.'))
    await expect(runNotesSort(sortDeps(), [source.id])).rejects.toThrow('The key was refused.')

    const long = Array.from({ length: 400 }, (_, i) => `Fact ${i}: the reeds grow ${i} feet.`)
    const almanac = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Almanac',
      content: notebookDocFromText(long.join('\n'))
    })
    replies({ pages: [{ folder: 'Facts', title: 'First', text: long[0] }] })
    complete.mockRejectedValueOnce(new InvalidKeyError('The key was refused.'))
    const outcome = await runNotesSort(sortDeps(), [almanac.id])
    expect(outcome).toMatchObject({ pages: 1, unread: 1, stopped: 'The key was refused.' })
    expect(byTitle('First')).toBeDefined()
  })

  it('refuses while the feature is off, and sends nothing for a closed project', async () => {
    const source = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Fenlands',
      content: WORLD
    })
    setAiSettings(db, {
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, notesSort: false }
    })
    await expect(runNotesSort(sortDeps(), [source.id])).rejects.toThrow('turned off')
    setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
    const outcome = await runNotesSort(sortDeps(false), [source.id])
    expect(complete).not.toHaveBeenCalled()
    expect(outcome.pages).toBe(0)
  })
})
