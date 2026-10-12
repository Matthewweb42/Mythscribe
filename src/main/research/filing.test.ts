import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { FilingReview } from '@shared/filing'
import { aiFiledOf, pageTextBlocks } from '@shared/memory/pageMarks'
import type { TiptapNodeT } from '@shared/tiptap'
import { defaultAiUsageState, dayOf } from '../ai/dailyCap'
import { resetInflight } from '../ai/inflight'
import type { CompletionRequest, CompletionResult, Provider } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import type { UsageEntry } from '../ai/usageStore'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { ensureResearchRoot } from '../project/seed'
import { setAiSettings } from '../project/settingsStore'
import { listDismissed } from '../memory/dismissedStore'
import { addAlias, createRecord, getRecord, listRecords, savePage } from '../memory/recordStore'
import type { TreeDb } from '../tree/treeStore'
import {
  applyFiling,
  clearFilingUndo,
  estimateFiling,
  fileResearch,
  filingSource,
  undoableFiling,
  undoFiling
} from './filing'
import { filedConflicts, keepFiledLine, updateFiledLine } from './filedLines'
import { createResearchNote, researchDocOf, setResearchNotCanon } from './researchStore'

const NOW = new Date(2026, 9, 12, 12, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let page: string
let mara: string
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]

const BESTIARY = [
  'Bestiary of the Fens',
  'The fen-wight is a pale thing that hunts by lantern-light along the dykes.',
  'Mara Vell has grey eyes and a burn scar across her left hand.'
]

const docOf = (...texts: string[]): TiptapNodeT => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

/** What the fake model files: a new creature, an addition to Mara, and a line with a bad quote. */
const ANSWER = JSON.stringify({
  records: [
    {
      name: 'Fen-Wight',
      category: 'creature',
      aliases: ['wight'],
      lines: [
        { text: 'Colour: pale', q: 'is a pale thing that hunts' },
        { text: 'Hunts by lantern-light', q: 'hunts by lantern-light along the dykes' }
      ]
    },
    {
      name: 'Mara Vell',
      category: 'character',
      aliases: ['the burned captain'],
      lines: [
        { text: 'Eyes: grey', q: 'Mara Vell has grey eyes' },
        { text: 'Scar: burn across her left hand', q: 'a burn scar across her left hand' },
        { text: 'Tall', q: 'Mara Vell is very tall' }
      ]
    }
  ],
  categories: [],
  images: []
})

beforeEach(() => {
  resetInflight()
  clearFilingUndo()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-filing-'))
  session = createProject(projectFolderFor(tmp, 'Filing'), 'Filing', 'novel')
  db = session.connection.orm
  ensureResearchRoot(db, NOW)
  page = createResearchNote(db, 'novel', { title: 'Bestiary' }, NOW).id
  saveDocument(db, page, docOf(...BESTIARY))
  const made = createRecord(db, { name: 'Mara Vell', categoryId: 'character' }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  mara = made.record.id
  savePage(db, mara, 'pinned', docOf('Eyes: green', 'Mother of none.'), NOW)
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>(() =>
    Promise.resolve({
      text: ANSWER,
      model: 'deepseek-v4-pro',
      usage: { inputTokens: 900, outputTokens: 300 }
    })
  )
  ledger = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'gpt-5.4' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: { get: () => undefined, put: () => {} },
    dailyCap: { get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }), spend: () => {} },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  clearFilingUndo()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const file = (): Promise<FilingReview> => fileResearch(db, deps, { nodeId: page, requestId: 'f-1' })

const pinnedTexts = (id: string): { text: string; filed: boolean }[] => {
  const pinned = getRecord(db, id)?.pinned
  return pinned == null
    ? []
    : pageTextBlocks(pinned).map((block) => ({
        text: block.text,
        filed: aiFiledOf(block.block) !== null
      }))
}

describe('fileResearch (F-16.9)', () => {
  it('sends the page’s canon paragraphs as contextImport.v3 and plans the review', async () => {
    const review = await file()
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0]
    expect(request.messages[0]?.content).toMatch(/^You are the filing feature/u)
    expect(request.messages[1]?.content).toContain('character: Mara Vell')
    expect(request).toMatchObject({ json: true, tier: 'strong' })
    expect(ledger.map((row) => row.promptVersion)).toEqual(['contextImport.v3'])
    expect(review).toMatchObject({
      docId: page,
      docTitle: 'Bestiary',
      chunks: 1,
      promptVersion: 'contextImport.v3'
    })
    expect(review.proposalIds).toHaveLength(1)
    expect(review.dropped.quote).toBe(1)
    expect(
      review.items.map((item) => [
        item.name,
        item.recordId,
        item.lines.map((l) => [l.text, l.kind])
      ])
    ).toEqual([
      [
        'Fen-Wight',
        null,
        [
          ['Colour: pale', 'add'],
          ['Hunts by lantern-light', 'add']
        ]
      ],
      [
        'Mara Vell',
        mara,
        [
          ['Eyes: grey', 'conflict'],
          ['Scar: burn across her left hand', 'add']
        ]
      ]
    ])
    expect(review.items[0]?.categoryId).toBe('creature')
  })

  it('refuses a Not canon page, an empty page, and is gated by Use AI', async () => {
    setResearchNotCanon(db, page, true)
    expect(() => filingSource(db, page)).toThrow(/Not canon/u)
    setResearchNotCanon(db, page, false)
    saveDocument(db, page, docOf(' '))
    expect(() => filingSource(db, page)).toThrow(/no canon text/u)
    saveDocument(db, page, docOf(...BESTIARY))
    expect(estimateFiling(db, page, 'gpt-5.4')).toMatchObject({ files: 1, chunks: 1 })
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    await expect(file()).rejects.toMatchObject({ code: 'DISABLED' })
  })
})

describe('applyFiling and undoFiling (F-16.9)', () => {
  it('writes records, names and Pinned lines marked aiFiled, marks the page filed, and files once', async () => {
    const review = await file()
    // The author picks the upload's eyes over Pinned's in the conflict.
    const decided: FilingReview = {
      ...review,
      items: review.items.map((item) => ({
        ...item,
        lines: item.lines.map((line) => (line.kind === 'conflict' ? { ...line, use: true } : line))
      }))
    }
    const result = applyFiling(db, session.folder, decided, NOW)
    expect(result).toMatchObject({ created: 1, updated: 1, lines: 4, skipped: 0 })
    expect(result.categories.map((category) => category.id)).toContain('creature')
    const wight = listRecords(db).find((record) => record.name === 'Fen-Wight')
    expect(wight).toMatchObject({ origin: 'filed', categoryId: 'creature' })
    expect(wight?.aliases.map((alias) => [alias.text, alias.origin])).toEqual([
      ['Fen-Wight', 'author'],
      ['wight', 'filed']
    ])
    expect(pinnedTexts(wight?.id ?? '')).toEqual([
      { text: 'Colour: pale', filed: true },
      { text: 'Hunts by lantern-light', filed: true }
    ])
    // The eyes replaced Pinned's paragraph in place; the scar was added at the end.
    expect(pinnedTexts(mara)).toEqual([
      { text: 'Eyes: grey', filed: true },
      { text: 'Mother of none.', filed: false },
      { text: 'Scar: burn across her left hand', filed: true }
    ])
    const filed = aiFiledOf(pageTextBlocks(getRecord(db, mara)?.pinned ?? docOf())[0]!.block)
    expect(filed).toEqual({ doc: page, para: 2, quote: 'Mara Vell has grey eyes' })
    expect(getRecord(db, mara)?.aliases.map((alias) => alias.text)).toContain('the burned captain')
    expect(researchDocOf(db, page).filedAt).toBe(NOW.toISOString())
    expect(() => applyFiling(db, session.folder, decided, NOW)).toThrow(/filing runs once/u)
    expect(() => filingSource(db, page)).toThrow(/filing runs once/u)
  })

  it('leaves out skipped items and the conflicts kept as Pinned says', async () => {
    const review = await file()
    applyFiling(
      db,
      session.folder,
      {
        ...review,
        items: review.items.map((item) => ({ ...item, include: item.recordId !== null }))
      },
      NOW
    )
    expect(listRecords(db).map((record) => record.name)).toEqual(['Mara Vell'])
    expect(pinnedTexts(mara).map((block) => block.text)).toEqual([
      'Eyes: green',
      'Mother of none.',
      'Scar: burn across her left hand'
    ])
  })

  it('takes back what is still as written, and keeps what the author changed since', async () => {
    const review = await file()
    const result = applyFiling(
      db,
      session.folder,
      {
        ...review,
        items: review.items.map((item) => ({
          ...item,
          lines: item.lines.map((line) => ({ ...line, use: true }))
        }))
      },
      NOW
    )
    expect(undoableFiling()).toBe(page)
    // The author edits the scar line (her edit clears its mark), so it is hers now.
    const pinned = getRecord(db, mara)?.pinned ?? docOf()
    savePage(
      db,
      mara,
      'pinned',
      {
        ...pinned,
        content: (pinned.content ?? []).map((block, i) =>
          i === 2
            ? { type: 'paragraph', content: [{ type: 'text', text: 'Scar: an old burn' }] }
            : block
        )
      },
      NOW
    )
    expect(() => undoFiling(db, session.folder, 'another-page', NOW)).toThrow(/another page/u)
    const undone = undoFiling(db, session.folder, page, new Date(NOW.getTime() + 1000))
    expect(undone.deleted).toHaveLength(1)
    expect(undone.kept).toBe(1)
    expect(listRecords(db).map((record) => record.name)).toEqual(['Mara Vell'])
    expect(pinnedTexts(mara).map((block) => block.text)).toEqual([
      'Eyes: green',
      'Mother of none.',
      'Scar: an old burn'
    ])
    expect(getRecord(db, mara)?.aliases.map((alias) => alias.text)).toEqual(['Mara Vell'])
    expect(researchDocOf(db, page).filedAt).toBeNull()
    expect(result.recordIds).toContain(mara)
    expect(undoableFiling()).toBeNull()
    expect(() => undoFiling(db, session.folder, page, NOW)).toThrow(/no filing to undo/u)
  })
})

describe('one name never sinks the whole Apply (F-16.9)', () => {
  const answering = (answer: unknown): void => {
    complete.mockImplementation(() =>
      Promise.resolve({
        text: JSON.stringify(answer),
        model: 'deepseek-v4-pro',
        usage: { inputTokens: 900, outputTokens: 300 }
      })
    )
  }

  it('files two new records when a later chunk gives one the other’s name as a nickname', async () => {
    addAlias(db, mara, { text: 'the Skipper', shared: true }, NOW)
    answering({
      records: [
        {
          name: 'Old Jory',
          category: 'character',
          aliases: [],
          lines: [{ text: 'Colour: pale', q: 'is a pale thing that hunts' }]
        },
        {
          name: 'Hesk Orrin',
          category: 'character',
          // Another new record's name, and a name Mara holds shared: neither is filed.
          aliases: ['Old Jory', 'the Skipper', 'Orrin'],
          lines: [{ text: 'Hunts by lantern-light', q: 'hunts by lantern-light along the dykes' }]
        }
      ]
    })
    const review = await file()
    expect(review.items.map((item) => [item.name, item.aliases])).toEqual([
      ['Old Jory', []],
      ['Hesk Orrin', ['Orrin']]
    ])
    expect(review.dropped.alias).toBe(2)
    expect(review.taken).toEqual(expect.arrayContaining(['mara vell', 'the skipper']))
    const result = applyFiling(db, session.folder, review, NOW)
    expect(result).toMatchObject({ created: 2, skipped: 0 })
    expect(listRecords(db).map((record) => record.name)).toEqual(
      expect.arrayContaining(['Old Jory', 'Hesk Orrin', 'Mara Vell'])
    )
  })

  it('skips a new record whose name was taken since, and leaves out a nickname another record holds', async () => {
    const review = await file()
    const [wight, maraItem] = review.items
    if (wight === undefined || maraItem === undefined) throw new Error('expected two items')
    const stale: FilingReview = {
      ...review,
      items: [
        // A stale review: one name another record holds now, one nickname that is Mara's name.
        { ...wight, aliases: ['Mara Vell', 'wight'] },
        { ...wight, id: 'f9', name: 'Mara Vell', aliases: [] },
        maraItem
      ]
    }
    const result = applyFiling(db, session.folder, stale, NOW)
    expect(result).toMatchObject({ created: 1, updated: 1, skipped: 1 })
    const made = listRecords(db).find((record) => record.name === 'Fen-Wight')
    expect(made?.aliases.map((alias) => alias.text)).toEqual(['Fen-Wight', 'wight'])
    expect(researchDocOf(db, page).filedAt).toBe(NOW.toISOString())
  })
})

describe('the filed-line check (F-16.9)', () => {
  const filedOnce = async (): Promise<void> => {
    const review = await file()
    applyFiling(db, session.folder, review, NOW)
  }

  it('raises a conflict when the source sentence changes, and Keep line quiets it until the page changes again', async () => {
    await filedOnce()
    expect(filedConflicts(db)).toEqual([])
    saveDocument(
      db,
      page,
      docOf(
        BESTIARY[0]!,
        BESTIARY[1]!,
        'Mara Vell has brown eyes and a burn scar across her left hand.'
      )
    )
    // The scar's quote is still on the page (the eyes' conflict kept Pinned's line): nothing to look at.
    expect(filedConflicts(db)).toEqual([])
    saveDocument(db, page, docOf(BESTIARY[0]!, 'The fen-wight is grey and slow.', BESTIARY[2]!))
    const changed = filedConflicts(db)
    expect(changed.map((c) => [c.recordName, c.line, c.para])).toEqual([
      ['Fen-Wight', 'Colour: pale', 1],
      ['Fen-Wight', 'Hunts by lantern-light', 1]
    ])
    expect(changed[0]?.nowReads).toBe('The fen-wight is grey and slow.')
    keepFiledLine(db, changed[0]!, NOW)
    expect(filedConflicts(db).map((c) => c.line)).toEqual(['Hunts by lantern-light'])
    expect(listDismissed(db).items[0]).toMatchObject({ kind: 'notProblem', nodeId: page })
    // A further change to the page asks again.
    saveDocument(db, page, docOf(BESTIARY[0]!, 'The fen-wight is grey.', BESTIARY[2]!))
    expect(filedConflicts(db).map((c) => c.line)).toEqual([
      'Colour: pale',
      'Hunts by lantern-light'
    ])
  })

  it('Update line writes the author’s words and clears the mark; a stale line is refused', async () => {
    await filedOnce()
    saveDocument(db, page, docOf(BESTIARY[0]!, 'The fen-wight is grey and slow.', BESTIARY[2]!))
    const [first] = filedConflicts(db)
    if (first === undefined) throw new Error('expected a conflict')
    const wight = first.recordId
    updateFiledLine(
      db,
      { recordId: wight, lineIndex: first.lineIndex, line: first.line, text: 'Colour: grey' },
      NOW
    )
    expect(pinnedTexts(wight)[0]).toEqual({ text: 'Colour: grey', filed: false })
    expect(filedConflicts(db).map((c) => c.line)).toEqual(['Hunts by lantern-light'])
    expect(() =>
      updateFiledLine(
        db,
        { recordId: wight, lineIndex: first.lineIndex, line: first.line, text: 'x' },
        NOW
      )
    ).toThrow(/changed since/u)
  })
})

describe('the filed-line check keeps what the author kept (F-16.9)', () => {
  const filedOnce = async (): Promise<void> => {
    const review = await file()
    applyFiling(db, session.folder, review, NOW)
  }

  it('Keep line stays kept through an edit elsewhere on the page, and asks again when its paragraph changes', async () => {
    await filedOnce()
    const moved = 'Mara Vell has grey eyes and a burn scar on her right hand.'
    saveDocument(db, page, docOf(BESTIARY[0]!, BESTIARY[1]!, moved))
    const [scar] = filedConflicts(db)
    expect(scar).toMatchObject({ line: 'Scar: burn across her left hand', pageNotCanon: false })
    keepFiledLine(db, scar!, NOW)
    expect(filedConflicts(db)).toEqual([])
    saveDocument(db, page, docOf('Bestiary of the Northern Fens', BESTIARY[1]!, moved))
    expect(filedConflicts(db)).toEqual([])
    saveDocument(
      db,
      page,
      docOf(
        'Bestiary of the Northern Fens',
        BESTIARY[1]!,
        'Mara Vell has a burn scar on her cheek.'
      )
    )
    expect(filedConflicts(db).map((c) => c.line)).toEqual(['Scar: burn across her left hand'])
  })

  it('flags every line filed from a page switched to Not canon as a whole', async () => {
    await filedOnce()
    setResearchNotCanon(db, page, true)
    const flagged = filedConflicts(db)
    expect(flagged.map((c) => [c.line, c.pageNotCanon])).toEqual([
      ['Colour: pale', true],
      ['Hunts by lantern-light', true],
      ['Scar: burn across her left hand', true]
    ])
    keepFiledLine(db, flagged[0]!, NOW)
    expect(filedConflicts(db)).toHaveLength(2)
    setResearchNotCanon(db, page, false)
    expect(filedConflicts(db)).toEqual([])
  })
})
