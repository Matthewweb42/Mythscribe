import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { EditFlowRun, EditFlowSpec } from '@shared/editFlow'
import { notebookDocFromText } from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createNotebookItem, getNotebookPage } from '../notebook/notebookStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import {
  getNotesAutoSettings,
  getNotesAutoState,
  setAiSettings,
  setNotesAutoSettings
} from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import { getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { defaultAiUsageState, dayOf } from '../ai/dailyCap'
import { resetInflight } from '../ai/inflight'
import type { CompletionRequest, CompletionResult, Provider } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import type { UsageEntry } from '../ai/usageStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { chapterTextHash, createAutoNotes, type AutoNotes } from './autoNotes'
import { listFlowRuns } from './flowStore'
import { createEditFlowRunner, type EditFlowRunner } from './run'

type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb | null
let complete: ReturnType<typeof vi.fn<Complete>>
let ledger: UsageEntry[]
let scenes: string[]
let chapter: string
let moves: EditFlowRun[]
let logged: string[]
let now: Date
let runner: EditFlowRunner
let auto: AutoNotes

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function openDb(): TreeDb {
  if (db === null) throw new Error('closed')
  return db
}

/** One Update notes answer: a line added to the first note page. */
function noteReply(line = 'Climbs the ridge alone (Chapter 1).'): void {
  complete.mockResolvedValueOnce({
    text: JSON.stringify({ notes: [{ page: 'p1', add: line }] }),
    model: 'deepseek-v4-flash',
    usage: { inputTokens: 1_000, outputTokens: 100 }
  })
}

function turnOn(dailyCap = 10): void {
  setNotesAutoSettings(openDb(), { on: true, dailyCap })
}

beforeEach(() => {
  resetInflight()
  resetVoiceProfileCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-autonotes-'))
  session = createSeededProject(projectFolderFor(tmp, 'Auto'), 'Auto', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  saveDocument(db, scenes[0]!, doc('Mara climbed the ridge alone.', 'The sea was grey below.'))
  saveDocument(db, scenes[1]!, doc('Rook waited at the quay with the ledger.'))
  chapter = getNode(db, scenes[0]!)?.parentId ?? ''
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  createNotebookItem(db, {
    parentId: null,
    kind: 'page',
    title: 'Mara',
    content: notebookDocFromText('Eyes: grey.')
  })
  complete = vi.fn<Complete>()
  ledger = []
  moves = []
  logged = []
  now = new Date(2026, 9, 15, 10, 0, 0)
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
  const deps: AiRequestDeps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: { get: () => undefined, put: () => {} },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(now) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => now,
    price: priceFor
  }
  runner = createEditFlowRunner({
    db: () => db,
    folder: () => (db === null ? null : session.folder),
    requestDeps: () => deps,
    onChange: (run) => void moves.push(run),
    notebookChanged: () => undefined,
    now: () => '2026-10-15T10:00:00.000Z'
  })
  auto = createAutoNotes({
    db: () => db,
    runner,
    log: (line) => void logged.push(line),
    now: () => now
  })
})

afterEach(() => {
  runner.clear()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the automatic notes update after a chapter (notes redesign phase 3)', () => {
  it('is off by default: leaving a chapter sends nothing and logs nothing', async () => {
    expect(getNotesAutoSettings(openDb())).toEqual({ on: false, dailyCap: 10 })
    expect(await auto.chapterLeft(chapter)).toEqual({ started: false, reason: 'off' })
    expect(complete).not.toHaveBeenCalled()
    expect(logged).toEqual([])
  })

  it('runs one Quick Update notes on the chapter, marked automatic, counted, never opening anything', async () => {
    turnOn()
    noteReply()
    const result = await auto.chapterLeft(chapter)
    expect(result.started).toBe(true)
    await runner.idle()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]?.[0].messages[1]?.content).toContain('Update her notes')
    expect(ledger.map((entry) => [entry.feature, entry.tier])).toEqual([['editFlow', 'fast']])
    const [run] = listFlowRuns(openDb())
    const spec: EditFlowSpec = {
      categories: ['updateNotes'],
      depth: 'quick',
      scope: { kind: 'chapter', nodeId: chapter }
    }
    expect(run).toMatchObject({ automatic: true, status: 'done', spec })
    expect(run?.id).toBe(result.started ? result.runId : '')
    expect(run?.noteEdits).toHaveLength(1)
    // The window heard of it as it started, so the activity can follow it.
    expect(moves[0]).toMatchObject({ automatic: true, status: 'running' })
    const mara = getNotebookPage(
      openDb(),
      run?.noteEdits[0]?.edit.kind === 'notebook' ? run.noteEdits[0].edit.pageId : ''
    )
    expect(mara.plain).toBe('Eyes: grey.\nClimbs the ridge alone (Chapter 1).')
    expect(getNotesAutoState(openDb())).toEqual({
      day: '2026-10-15',
      count: 1,
      hashes: { [chapter]: chapterTextHash(openDb(), chapter) }
    })
  })

  it('never pays twice for the same text: leaving again, or after the writing was undone', async () => {
    turnOn()
    noteReply()
    await auto.chapterLeft(chapter)
    await runner.idle()
    expect(await auto.chapterLeft(chapter)).toEqual({ started: false, reason: 'unchanged' })
    // Written and then undone: the same text as at the last update.
    saveDocument(openDb(), scenes[0]!, doc('Mara climbed the ridge alone.', 'Changed.'))
    saveDocument(
      openDb(),
      scenes[0]!,
      doc('Mara climbed the ridge alone.', 'The sea was grey below.')
    )
    expect(await auto.chapterLeft(chapter)).toEqual({ started: false, reason: 'unchanged' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(logged.at(-1)).toContain('has not changed')
    // Written for real: it runs again.
    saveDocument(openDb(), scenes[0]!, doc('Mara climbed the ridge alone.', 'Rook followed her.'))
    noteReply('Rook follows her up the ridge.')
    expect((await auto.chapterLeft(chapter)).started).toBe(true)
    await runner.idle()
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('stops at the daily cap and starts counting again on a new day', async () => {
    turnOn(1)
    noteReply()
    await auto.chapterLeft(chapter)
    await runner.idle()
    saveDocument(openDb(), scenes[0]!, doc('Mara climbed the ridge alone.', 'Rook followed her.'))
    expect(await auto.chapterLeft(chapter)).toEqual({ started: false, reason: 'cap' })
    expect(logged.at(-1)).toContain('cap')
    now = new Date(2026, 9, 16, 0, 5, 0)
    noteReply()
    expect((await auto.chapterLeft(chapter)).started).toBe(true)
    await runner.idle()
    expect(getNotesAutoState(openDb())).toMatchObject({ day: '2026-10-16', count: 1 })
  })

  it('does nothing while Use AI is off or an edit run is going', async () => {
    turnOn()
    setAiSettings(openDb(), { ...defaultAiSettings(), dial: 0 })
    expect(await auto.chapterLeft(chapter)).toEqual({ started: false, reason: 'aiOff' })
    setAiSettings(openDb(), { ...defaultAiSettings(), dial: 1 })
    const busy = createAutoNotes({
      db: () => db,
      runner: { ...runner, running: () => 'run-going' },
      log: (line) => void logged.push(line),
      now: () => now
    })
    expect(await busy.chapterLeft(chapter)).toEqual({ started: false, reason: 'busy' })
    expect(complete).not.toHaveBeenCalled()
    // A skip is not counted, and remembers no text.
    expect(getNotesAutoState(openDb())).toEqual({ day: '', count: 0, hashes: {} })
  })

  it('refuses what is not a chapter of the manuscript, and a chapter with no text', async () => {
    turnOn()
    expect(await auto.chapterLeft(scenes[0]!)).toEqual({ started: false, reason: 'notChapter' })
    expect(await auto.chapterLeft('missing')).toEqual({ started: false, reason: 'notChapter' })
    const empty = getNode(openDb(), scenes[2]!)?.parentId ?? ''
    expect(await auto.chapterLeft(empty)).toEqual({ started: false, reason: 'noText' })
    expect(complete).not.toHaveBeenCalled()
    expect(getNotesAutoState(openDb()).count).toBe(0)
  })

  it('keeps an automatic run apart from the author’s own run of the same chapter', async () => {
    turnOn()
    const manual: EditFlowSpec = {
      categories: ['updateNotes'],
      depth: 'quick',
      scope: { kind: 'chapter', nodeId: chapter }
    }
    noteReply()
    const mine = await runner.start(manual)
    await runner.idle()
    noteReply('Again.')
    const started = await auto.chapterLeft(chapter)
    await runner.idle()
    const kept = listFlowRuns(openDb())
    expect(kept.map((run) => run.automatic).sort()).toEqual([false, true])
    expect(kept.some((run) => run.id === mine.id)).toBe(true)
    // The author's next run of the chapter replaces only her own.
    noteReply('Once more.')
    await runner.start(manual)
    await runner.idle()
    const after = listFlowRuns(openDb())
    expect(after).toHaveLength(2)
    expect(after.some((run) => run.id === (started.started ? started.runId : ''))).toBe(true)
    expect(after.some((run) => run.id === mine.id)).toBe(false)
  })

  it('records a failed run once, with its cause, and does not retry it', async () => {
    turnOn()
    complete.mockRejectedValueOnce(new Error('boom'))
    expect((await auto.chapterLeft(chapter)).started).toBe(true)
    await runner.idle()
    const [run] = listFlowRuns(openDb())
    expect(run?.status).toBe('failed')
    expect(run?.error).not.toBeNull()
    expect(await auto.chapterLeft(chapter)).toEqual({ started: false, reason: 'unchanged' })
  })
})
