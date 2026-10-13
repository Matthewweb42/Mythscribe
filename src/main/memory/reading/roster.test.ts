import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import type { TiptapNodeT } from '@shared/tiptap'
import { settings } from '../../db/schema'
import { saveDocument } from '../../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { scanNamesFor } from '../nameIndexer'
import { addAlias, createRecord, deleteRecord, setAliases, requireRecord } from '../recordStore'
import { MEMORY_ROSTER_KEY } from './roster'
import { TOPIC_ROSTER_MAX_TOKENS, topicLinesTokens } from '@shared/memory/topics'
import {
  ROSTER_RECORD_TOKENS,
  buildTopics,
  readerRoster,
  rosterLine,
  type RosterTopic
} from './rosterCache'

let tmp: string
let session: ProjectSession
let db: TreeDb

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))
const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)

function record(name: string, aliases: string[] = [], at = NOW, categoryId = 'character'): string {
  const made = createRecord(
    db,
    { name, categoryId, aliases: aliases.map((text) => ({ text })), force: true },
    at
  )
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

/** A capitalised word per number ("Zab"): digits would end a name span. */
const word = (i: number): string =>
  `Z${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`

const stored = (): string | undefined =>
  db.select().from(settings).where(eq(settings.key, MEMORY_ROSTER_KEY)).get()?.value

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-roster-'))
  session = createProject(projectFolderFor(tmp, 'Roster'), 'Roster', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the reader’s roster cache (F-16.17, plan P2a §2.5)', () => {
  it('lists every record once with its nicknames and kind, and keeps the row byte for byte', () => {
    const mara = record('Mara Vell', ['Mara', 'Captain Vell'])
    record('the Quay', [], later(1), 'setting')
    const roster = readerRoster(db)
    expect(roster.lines).toEqual([
      'r1 Mara Vell (Mara; Captain Vell) · character',
      'r2 the Quay · place'
    ])
    expect(roster.shortOf(mara)).toBe('r1')
    expect(roster.recordOf('r1')).toBe(mara)
    expect(roster.recordOf('r9')).toBeNull()
    expect(roster.whoLine(mara)).toBe('r1 Mara Vell (Mara; Captain Vell) · character')
    const row = stored()
    readerRoster(db)
    expect(stored()).toBe(row)
  })

  it('appends a new record and a new nickname, keeping every earlier line as it was', () => {
    const mara = record('Mara Vell', ['Mara'])
    const before = readerRoster(db).lines
    addAlias(db, mara, { text: 'Ry' }, later(1))
    const hesk = record('Hesk', [], later(2))
    const after = readerRoster(db)
    expect(after.lines.slice(0, before.length)).toEqual(before)
    expect(after.lines.slice(before.length)).toEqual(['r1 +Ry', 'r2 Hesk · character'])
    expect(after.shortOf(hesk)).toBe('r2')
  })

  it('rebuilds on a removal, a rename, a new kind, a removed nickname, or a new reader version', () => {
    const mara = record('Mara Vell', ['Mara', 'Ry'])
    const tomas = record('Tomas', [], later(1))
    addAlias(db, tomas, { text: 'Tom' }, later(2))
    readerRoster(db)
    expect(readerRoster(db).lines).toContain('r2 Tomas (Tom) · character')

    // A nickname removed through the full list (no markRosterForRebuild there): caught by comparing.
    const main = requireRecord(db, mara)
    setAliases(db, mara, { name: { text: main.name }, aliases: [{ text: 'Mara' }] }, later(3))
    expect(readerRoster(db).lines).toEqual([
      'r1 Mara Vell (Mara) · character',
      'r2 Tomas (Tom) · character'
    ])

    deleteRecord(db, mara)
    expect(readerRoster(db).lines).toEqual(['r1 Tomas (Tom) · character'])

    const row = JSON.parse(stored() ?? '{}') as Record<string, unknown>
    db.update(settings)
      .set({ value: JSON.stringify({ ...row, readerVersion: 'reader.v0', additions: ['stale'] }) })
      .where(eq(settings.key, MEMORY_ROSTER_KEY))
      .run()
    expect(readerRoster(db).lines).toEqual(['r1 Tomas (Tom) · character'])
  })

  it('leaves the least named out over the cap, and gives them an id for one reading only', () => {
    const scene = manuscriptDocuments(db)[0]?.id ?? ''
    const ids: string[] = []
    for (let i = 0; i < 150; i += 1) {
      ids.push(record(`Character ${word(i)} Of The Long Cast`, [], later(i)))
    }
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `Then Character ${word(149)} Of The Long Cast spoke.` }]
        }
      ]
    }
    saveDocument(db, scene, doc)
    scanNamesFor(db, scene, NOW)
    const roster = readerRoster(db)
    expect(estimateTokens(roster.lines.join('\n'))).toBeLessThanOrEqual(ROSTER_RECORD_TOKENS)
    expect(roster.lines.length).toBeLessThan(150)
    // The one named record stays, though it is the newest.
    const named = ids[149] ?? ''
    expect(roster.lines.some((line) => line.includes(`Character ${word(149)} `))).toBe(true)
    const left = ids.find(
      (id) => !roster.lines.some((line) => line.startsWith(`${roster.shortOf(id)} `))
    )
    if (left === undefined) throw new Error('nothing was left out')
    const extra = roster.shortOf(left)
    expect(roster.recordOf(extra)).toBe(left)
    expect(Number(extra.slice(1))).toBeGreaterThan(roster.lines.length)
    expect(roster.shortOf(named)).not.toBe(extra)
  })

  it('P2b: rebuilds a reader.v1 row once for reader.v2, and appends topics after the record lines', () => {
    record('Mara Vell', ['Mara'])
    readerRoster(db)
    const row = JSON.parse(stored() ?? '{}') as Record<string, unknown>
    expect(row.readerVersion).toBe('reader.v2')
    db.update(settings)
      .set({
        value: JSON.stringify({
          ...row,
          readerVersion: 'reader.v1',
          base: ['r1 Stale · character']
        })
      })
      .where(eq(settings.key, MEMORY_ROSTER_KEY))
      .run()
    expect(readerRoster(db).lines).toEqual(['r1 Mara Vell (Mara) · character'])
    const before = JSON.parse(stored() ?? '{}') as { base: string[]; readerVersion: string }
    expect(before.readerVersion).toBe('reader.v2')
    // An author's secret is listed after the records; the record lines do not move.
    record('the sold map', [], later(1), 'secret')
    const roster = readerRoster(db)
    expect(roster.lines).toEqual(['r1 Mara Vell (Mara) · character'])
    expect(roster.topicLines).toEqual(['s1 the sold map · secret'])
    expect((JSON.parse(stored() ?? '{}') as { base: string[] }).base).toEqual(before.base)
  })

  it('P2b-D10 (amended): past the ceiling, leaves out the AI-made topics with the least evidence, the author’s last', () => {
    const topic = (i: number, origin: RosterTopic['origin'], weight: number): RosterTopic => ({
      recordId: `id-${String(i).padStart(3, '0')}`,
      kind: i % 4 === 0 ? 'thread' : 'secret',
      label: `the long hidden matter number ${i} of the hall`,
      created: new Date(NOW.getTime() + i * 1_000).toISOString(),
      origin,
      weight
    })
    const author = Array.from({ length: 60 }, (_, i) => topic(i, 'author', 0))
    const ai = Array.from({ length: 140 }, (_, i) => topic(60 + i, 'ai', i < 70 ? 5 : 1))
    const part = buildTopics([...author, ...ai])
    expect(part.short).toBe(true)
    expect(topicLinesTokens(part.base)).toBeLessThanOrEqual(TOPIC_ROSTER_MAX_TOKENS)
    expect(part.dropped.length).toBeGreaterThan(0)
    // Every author topic is kept; the AI ones left out are the least evidenced, newest first.
    for (const each of author) expect(part.held[each.recordId]).toBeDefined()
    const dropped = new Set(part.dropped)
    const kept = ai.filter((each) => !dropped.has(each.recordId))
    const left = ai.filter((each) => dropped.has(each.recordId))
    expect(Math.min(...kept.map((each) => each.weight))).toBeGreaterThanOrEqual(
      Math.max(...left.map((each) => each.weight))
    )
    // Under the ceiling nothing is left out.
    expect(buildTopics(author).dropped).toEqual([])
  })

  it('formats a line from a record', () => {
    const id = record('Lise', ['Liesel'])
    expect(rosterLine('r7', requireRecord(db, id))).toBe('r7 Lise (Liesel) · character')
  })
})
