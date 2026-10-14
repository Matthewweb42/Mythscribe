import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { TiptapNodeT } from '@shared/tiptap'
import { JUDGE_SENTINEL } from '../../ai/prompts/judge.v1'
import { AiRateLimitError, type CompletionRequest } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { JobSkippedError } from '../../jobs/indexQueue'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { createRecord } from '../recordStore'
import { seedClaims } from '../reading/claimFixture'
import { readRow } from '../reading/readerRows'
import { fakeAi } from '../reading/readingFixture'
import { findingsOf } from './findingStore'
import { runFindingsJob } from './findingsJob'
import {
  HOLD,
  JUDGE_DAY_PAIRS,
  JUDGE_RUN_PAIRS,
  MEMORY_JUDGE_SWEEP_KEY,
  createFindingsService,
  judgeDay,
  sweepCalls,
  sweepPairs,
  type FindingsServiceDeps
} from './findingsService'

/**
 * The judge's background runs and Check the book's judging (F-16.27, F-16.30; plan P4 §2.3 step 6,
 * P4-D12): at most 10 pairs a run, the scene just read first, again while pairs remain, at most 30
 * pairs a day; never during a rebuild; holds (the switch off, Use AI off, no provider, the daily
 * cap, the Cloud cap, the day's pairs) are quiet `JobSkippedError`s; the asked check judges every
 * pair past the Cloud cap and the day's limit, never past the daily cap.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let chapter: string
let one: string
let two: string
let settings: AiSettings
let provider: { id: 'openai' | 'cloud' } | null
let rebuilding: boolean
let cloudCapped: boolean
let spent: { usd: number; asked: boolean }[]
let changed: { nodeIds: string[]; recordIds: string[] }[]
let counts: unknown[]

const NOW = new Date(2026, 9, 13, 12, 0, 0)

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function record(name: string): string {
  const made = createRecord(db, { name, categoryId: 'character', force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

const isJudge = (request: CompletionRequest): boolean =>
  request.messages[0]?.content.startsWith(JUDGE_SENTINEL) === true

/** A judge calling every pair a contradiction. */
const allC = (): ReturnType<typeof fakeAi> =>
  fakeAi(
    (request) => {
      const items = [...(request.messages.at(-1)?.content ?? '').matchAll(/^(\d+)\. /gmu)]
      return {
        text: JSON.stringify({
          v: items.map((match) => ({ i: Number(match[1]), r: 'c', w: 'values differ' }))
        })
      }
    },
    { now: NOW }
  )

function deps(ai: ReturnType<typeof fakeAi>): FindingsServiceDeps {
  return {
    settings: () => settings,
    provider: () => provider,
    requestDeps: () => ai.deps,
    cloudCapped: () => cloudCapped,
    rebuilding: () => rebuilding,
    spend: (_db, usd, asked) => void spent.push({ usd, asked }),
    changed: (payload) => void changed.push(payload),
    findingsChanged: (payload) => void counts.push(payload),
    now: () => NOW
  }
}

/** Seeds `n` C1 contradictions across scenes one and two (each its own character). */
function seed(n: number): void {
  const grey: string[] = []
  const brown: string[] = []
  const names: { id: string; name: string }[] = []
  for (let i = 0; i < n; i += 1) {
    const name = `Person${i + 1}`
    names.push({ id: record(name), name })
    grey.push(`${name}'s eyes were grey.`)
    brown.push(`${name}'s eyes were brown.`)
  }
  saveDocument(db, one, doc(...grey))
  saveDocument(db, two, doc(...brown))
  for (const [i, { id, name }] of names.entries()) {
    seedClaims(
      db,
      one,
      [{ recordId: id, slot: 'eyes', value: 'grey', quote: `${name}'s eyes were grey`, para: i }],
      NOW
    )
    seedClaims(
      db,
      two,
      [{ recordId: id, slot: 'eyes', value: 'brown', quote: `${name}'s eyes were brown`, para: i }],
      NOW
    )
  }
  runFindingsJob(db, NOW, { cachedVerdicts: true })
}

const state = (): string[] => findingsOf(db, activeDraftId(db)).map((each) => each.state)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-judge-service-'))
  session = createProject(projectFolderFor(tmp, 'Service'), 'Service', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  chapter = getNode(db, one)?.parentId ?? ''
  two = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  settings = { ...defaultAiSettings(), dial: 1 }
  provider = { id: 'openai' }
  rebuilding = false
  cloudCapped = false
  spent = []
  changed = []
  counts = []
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('background judging (F-16.27, P4-D12)', () => {
  it('judges at most 10 pairs a run in two calls, and asks to run again while pairs remain', async () => {
    seed(12)
    expect(state().filter((each) => each === 'unjudged')).toHaveLength(12)
    const ai = allC()
    const service = createFindingsService(deps(ai))
    expect(service.wanted(db)).toBe(true)
    const first = await service.judge(db, 'judge-1')
    expect(ai.requests.filter(isJudge)).toHaveLength(2)
    expect(first).toMatchObject({ requested: true, again: true })
    expect(first.run?.sent).toBe(JUDGE_RUN_PAIRS)
    expect(state().filter((each) => each === 'open')).toHaveLength(10)
    expect(judgeDay(db, '2026-10-13').pairs).toBe(10)
    // Background spend, pushed counts and the judged findings' scenes.
    expect(spent.every((each) => !each.asked)).toBe(true)
    expect(spent).toHaveLength(2)
    expect(counts.at(-1)).toEqual({ open: 10, unclear: 0, waiting: 2 })
    expect(changed.at(-1)?.nodeIds).toEqual([one, two].sort())
    const second = await service.judge(db, 'judge-2')
    expect(second).toMatchObject({ again: false })
    expect(state().every((each) => each === 'open')).toBe(true)
    expect(service.wanted(db)).toBe(false)
  })

  it('stops at 30 pairs a day; the rest wait (quietly) for Check the book', async () => {
    seed(34)
    const ai = allC()
    const service = createFindingsService(deps(ai))
    for (let run = 1; run <= 3; run += 1) await service.judge(db, `judge-${run}`)
    expect(judgeDay(db, '2026-10-13').pairs).toBe(JUDGE_DAY_PAIRS)
    expect(state().filter((each) => each === 'unjudged')).toHaveLength(4)
    expect(service.wanted(db)).toBe(false)
    await expect(service.judge(db, 'judge-4')).rejects.toThrow(JobSkippedError)
    await expect(service.judge(db, 'judge-4b')).rejects.toThrow(HOLD.dayPairs)
    // Check the book is asked: no daily pair limit, spent as asked.
    const check = await service.checkBook(db, 'check-1')
    expect(check.run?.sent).toBe(4)
    expect(state().every((each) => each === 'open')).toBe(true)
    expect(spent.at(-1)?.asked).toBe(true)
  })

  it('never runs during a rebuild, and holds quietly for the switch, Use AI, a provider and the caps', async () => {
    seed(1)
    const ai = allC()
    const service = createFindingsService(deps(ai))
    const holds: [() => void, string, boolean][] = [
      [() => void (rebuilding = true), HOLD.rebuild, true],
      [
        () => void (settings = { ...settings, features: { ...settings.features, judge: false } }),
        HOLD.off,
        false
      ],
      [() => void (settings = { ...settings, dial: 0 }), HOLD.off, false],
      [() => void (provider = null), HOLD.provider, false],
      [() => void (cloudCapped = true), HOLD.cloudCap, true]
    ]
    for (const [hold, message, checkRuns] of holds) {
      settings = { ...defaultAiSettings(), dial: 1 }
      provider = { id: 'openai' }
      rebuilding = false
      cloudCapped = false
      hold()
      expect(service.wanted(db), message).toBe(false)
      await expect(service.judge(db, 'held'), message).rejects.toThrow(message)
      // The asked check passes the rebuild and the Cloud cap, never the switch or the provider.
      if (!checkRuns) await expect(service.checkBook(db, 'held')).rejects.toThrow(message)
    }
    expect(ai.requests).toHaveLength(0)
    expect(state()).toEqual(['unjudged'])
  })

  it('holds for the daily cap, background and asked alike', async () => {
    seed(1)
    const ai = allC()
    const today = ai.deps.dailyCap.get()
    ai.deps.dailyCap.get = () => ({
      ...today,
      dailyCapUsd: 0.5,
      spentTodayUsd: 0.5,
      spentDate: '2026-10-13'
    })
    const service = createFindingsService(deps(ai))
    await expect(service.judge(db, 'capped')).rejects.toThrow(HOLD.dailyCap)
    await expect(service.checkBook(db, 'capped')).rejects.toThrow(HOLD.dailyCap)
    expect(ai.requests).toHaveLength(0)
  })

  it('judges the scene just read first', async () => {
    const three = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Three'
    }).id
    seed(1)
    // A second contradiction between scenes two and three, of an earlier rule's order.
    const late = record('Late')
    saveDocument(db, three, doc("Late's eyes were green."))
    saveDocument(db, two, doc("Person1's eyes were brown.", "Late's eyes were blue."))
    seedClaims(
      db,
      two,
      [{ recordId: late, slot: 'eyes', value: 'blue', quote: "Late's eyes were blue", para: 1 }],
      NOW
    )
    seedClaims(
      db,
      three,
      [{ recordId: late, slot: 'eyes', value: 'green', quote: "Late's eyes were green", para: 0 }],
      NOW
    )
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    const ai = allC()
    const service = createFindingsService(deps(ai))
    service.read(three)
    await service.judge(db, 'first')
    const firstItem = (ai.requests.find(isJudge)?.messages.at(-1)?.content ?? '').split('\n')[1]
    expect(firstItem).toBe('1. Late · eyes. Can both be true?')
  })
})

describe('the rebuild sweep (P4-D12, P4 slice 3 review)', () => {
  const REBUILT = '2026-10-13T09:00:00.000Z'
  const sweepRow = (): unknown => readRow(db, MEMORY_JUDGE_SWEEP_KEY, z.unknown().nullable(), null)

  it('judges at most the pairs its price covered, as asked spend, and reports what it opened', async () => {
    seed(12)
    const ai = allC()
    const swept: { rebuildAt: string; keys: string[] }[] = []
    const service = createFindingsService({
      ...deps(ai),
      swept: (_db, rebuildAt, keys) => void swept.push({ rebuildAt, keys })
    })
    // A 15-scene rebuild is priced at one batch: two calls, 10 pairs.
    expect(sweepCalls(15)).toBe(2)
    expect(sweepPairs(15)).toBe(10)
    expect(sweepCalls(400)).toBe(12)
    expect(sweepCalls(0)).toBe(0)
    service.sweepDue(db, REBUILT, 15)
    expect(service.wanted(db)).toBe(true)
    const run = await service.judge(db, 'sweep')
    expect(run.run?.sent).toBe(10)
    expect(ai.requests.filter(isJudge)).toHaveLength(2)
    expect(spent.every((each) => each.asked)).toBe(true)
    expect(sweepRow()).toBeNull()
    expect(swept).toEqual([{ rebuildAt: REBUILT, keys: expect.any(Array) as string[] }])
    expect(swept[0]?.keys).toHaveLength(10)
    // Background judging takes up the rest, within its own limits.
    expect(run.again).toBe(true)
  })

  it('is tried once: held back (the daily cap) or during another rebuild, it is dropped, never run later', async () => {
    seed(1)
    const ai = allC()
    const service = createFindingsService(deps(ai))
    const today = ai.deps.dailyCap.get()
    const capped = (): ReturnType<typeof ai.deps.dailyCap.get> => ({
      ...today,
      dailyCapUsd: 0.5,
      spentTodayUsd: 0.5,
      spentDate: '2026-10-13'
    })
    const free = ai.deps.dailyCap.get
    ai.deps.dailyCap.get = capped
    service.sweepDue(db, REBUILT, 30)
    expect(service.wanted(db)).toBe(false)
    expect(sweepRow()).toBeNull()
    // The cap lifts: the next run is a background one (its own spend, its own limits).
    ai.deps.dailyCap.get = free
    expect(service.wanted(db)).toBe(true)
    await service.judge(db, 'later')
    expect(spent.length).toBeGreaterThan(0)
    expect(spent.every((each) => !each.asked)).toBe(true)
    // During another rebuild: dropped too (that rebuild's own sweep follows it).
    service.sweepDue(db, REBUILT, 30)
    rebuilding = true
    expect(service.wanted(db)).toBe(false)
    expect(sweepRow()).toBeNull()
  })
})

describe('runs cut short or half answered (P4 slice 2 review)', () => {
  it('a pair left half answered pushes nothing and never queues itself again', async () => {
    seed(1)
    let calls = 0
    // The A,B call answers; the B,A call answers nothing.
    const ai = fakeAi(
      (request) => {
        if (!isJudge(request)) return { text: '{}' }
        calls += 1
        return { text: calls === 1 ? '{"v":[{"i":1,"r":"c","w":"values differ"}]}' : '{"v":[]}' }
      },
      { now: NOW }
    )
    const service = createFindingsService(deps(ai))
    const run = await service.judge(db, 'half')
    expect(ai.requests.filter(isJudge)).toHaveLength(2)
    expect(run.again).toBe(false)
    expect(run.run).toMatchObject({ sent: 1, unanswered: 1, settled: [] })
    // Nothing a view shows moved: no memory:changed (which would queue the recompute and, through
    // it, this job again) and no counts.
    expect(changed).toEqual([])
    expect(counts).toEqual([])
    expect(findingsOf(db, activeDraftId(db))[0]).toMatchObject({
      state: 'unjudged',
      verdictAb: 'c',
      verdictBa: null
    })
    expect(judgeDay(db, '2026-10-13').pairs).toBe(1)
  })

  it('the daily cap reached mid-run keeps, counts and pushes what was judged', async () => {
    seed(12)
    const ai = allC()
    const today = ai.deps.dailyCap.get()
    // Under the cap for the first batch's two calls, over it for the second batch.
    ai.deps.dailyCap.get = () =>
      ai.requests.filter(isJudge).length >= 2
        ? { ...today, dailyCapUsd: 0.5, spentTodayUsd: 0.5, spentDate: '2026-10-13' }
        : { ...today, dailyCapUsd: 0.5, spentTodayUsd: 0, spentDate: '2026-10-13' }
    const service = createFindingsService(deps(ai))
    await expect(service.checkBook(db, 'capped-mid')).rejects.toThrow(HOLD.dailyCap)
    expect(ai.requests.filter(isJudge)).toHaveLength(2)
    expect(state().filter((each) => each === 'open')).toHaveLength(10)
    expect(counts.at(-1)).toEqual({ open: 10, unclear: 0, waiting: 2 })
    expect(changed.at(-1)?.nodeIds).toEqual([one, two].sort())
  })

  it('counts the pairs a background run sent before the cap stopped it', async () => {
    seed(12)
    const ai = allC()
    const today = ai.deps.dailyCap.get()
    ai.deps.dailyCap.get = () =>
      ai.requests.filter(isJudge).length >= 1
        ? { ...today, dailyCapUsd: 0.5, spentTodayUsd: 0.5, spentDate: '2026-10-13' }
        : { ...today, dailyCapUsd: 0.5, spentTodayUsd: 0, spentDate: '2026-10-13' }
    const service = createFindingsService(deps(ai))
    // The A,B call goes; the B,A call is refused: ten pairs went out, none is settled yet.
    await expect(service.judge(db, 'capped-bg')).rejects.toThrow(HOLD.dailyCap)
    expect(ai.requests.filter(isJudge)).toHaveLength(1)
    expect(judgeDay(db, '2026-10-13').pairs).toBe(10)
    expect(changed).toEqual([])
  })

  it('a background run’s transient failure goes quietly; Check the book’s is the author’s to see', async () => {
    seed(1)
    const ai = fakeAi(
      (request) => {
        if (isJudge(request)) throw new AiRateLimitError('Too many requests')
        return { text: '{}' }
      },
      { now: NOW }
    )
    const service = createFindingsService(deps(ai))
    await expect(service.judge(db, 'busy')).rejects.toThrow(JobSkippedError)
    await expect(service.judge(db, 'busy-2')).rejects.toThrow(HOLD.transient)
    await expect(service.checkBook(db, 'busy-3')).rejects.toThrow(AiRateLimitError)
    expect(state()).toEqual(['unjudged'])
  })
})
