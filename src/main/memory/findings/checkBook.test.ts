import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { emptyCardFields } from '@shared/memory/claims'
import { gateSentences, nextReadSet } from '@shared/memory/gate'
import { CHECK_NOT_COVERED } from '@shared/memory/views'
import type { TiptapNodeT } from '@shared/tiptap'
import { cancelInflight, resetInflight } from '../../ai/inflight'
import { JUDGE_SENTINEL } from '../../ai/prompts/judge.v1'
import { AiCancelledError, type CompletionRequest } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { JobSkippedError } from '../../jobs/indexQueue'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { nameScanShared } from '../nameIndexer'
import { createRecord } from '../recordStore'
import { upsertCard } from '../reading/cardStore'
import { cardAnchorOf, revealIn, seedClaims } from '../reading/claimFixture'
import { fakeAi, type FakeAi } from '../reading/readingFixture'
import { rowTexts } from '../reading/readingFrame'
import { writeSceneRead } from '../reading/sceneReadStore'
import { createTopic } from '../reading/topicStore'
import { CHECK_CONFIRM_MAX, checkReport, confirmOrder, estimateCheck } from './checkBook'
import { findingsOf } from './findingStore'
import { createFindingsService, HOLD, type FindingsServiceDeps } from './findingsService'

/**
 * *Check the book* (F-16.30; plan P4 §3.1, P4-D22): priced first (free on an unchanged book), it
 * judges every uncached pair (C7 included), has the strong model confirm at most 20 open findings
 * in order (`c` confirmed, `ok` cleared and listed, `u` unclear), keeps what was judged when it is
 * stopped, spends as asked (past the Cloud cap, never past the daily cap), and reports what it
 * checked and what it did not: the fixed list, unread scenes, the findings past the 20
 * confirmations, those hidden as flashbacks, and secrets nobody learns (scenes only).
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let chapter: string
let one: string
let two: string
let three: string
let settings: AiSettings
let cloudCapped: boolean
let spent: { usd: number; asked: boolean }[]
let progressed: number

const NOW = new Date(2026, 9, 13, 12, 0, 0)
const CONTEXT = {
  source: 'ownKey' as const,
  fastModel: 'gpt-5.4-mini',
  strongModel: 'gpt-5.4',
  pricing: null
}

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
const isConfirm = (request: CompletionRequest): boolean =>
  isJudge(request) && (request.messages.at(-1)?.content ?? '').startsWith('Pair:\n')

/**
 * The fake judge: every batch pair a contradiction; the stronger check answers by the pair's words
 * (Orrin's eyes: fine; Tomas's father: unclear; anything else: a contradiction), each with a reason.
 */
function judge(onConfirm?: (request: CompletionRequest) => void): FakeAi {
  return fakeAi(
    (request) => {
      const user = request.messages.at(-1)?.content ?? ''
      if (isConfirm(request)) {
        onConfirm?.(request)
        const r = user.includes('Orrin') ? 'ok' : user.includes('Tomas') ? 'u' : 'c'
        return { text: JSON.stringify({ r, w: 'the two passages disagree on this' }) }
      }
      const items = [...user.matchAll(/^(\d+)\. /gmu)]
      return {
        text: JSON.stringify({
          v: items.map((match) => ({ i: Number(match[1]), r: 'c', w: 'values differ' }))
        })
      }
    },
    { now: NOW }
  )
}

function deps(ai: FakeAi): FindingsServiceDeps {
  return {
    settings: () => settings,
    provider: () => ({ id: 'openai' }),
    requestDeps: () => ai.deps,
    cloudCapped: () => cloudCapped,
    rebuilding: () => false,
    spend: (_db, usd, asked) => void spent.push({ usd, asked }),
    changed: () => undefined,
    progressed: () => void (progressed += 1),
    now: () => NOW
  }
}

/** Each finding as `rule:state:stronger verdict`, sorted. */
const states = (): string[] =>
  findingsOf(db, activeDraftId(db))
    .map((each) => `${each.rule}:${each.state}:${each.confirm ?? '-'}`)
    .sort()

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-check-book-'))
  session = createProject(projectFolderFor(tmp, 'Check'), 'Check', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  chapter = getNode(db, one)?.parentId ?? ''
  const scene = (title: string): string =>
    createNode(db, 'novel', { parentId: chapter, kind: 'document', hierarchyLevel: 'scene', title })
      .id
  two = scene('Two')
  three = scene('Three')
  saveDocument(
    db,
    one,
    doc(
      "Mara's eyes were grey.",
      "Orrin's eyes were green.",
      'Tomas said his father kept a tavern in Vellmouth.',
      "Lena's hair was dark.",
      'Tomas sold the map to a stranger.'
    )
  )
  saveDocument(
    db,
    two,
    doc(
      'The rain came, years before.',
      "Mara's eyes were brown.",
      "Orrin's eyes were blue.",
      "Tomas's father kept a forge in Vellmouth.",
      "Lena's hair was fair."
    )
  )
  saveDocument(db, three, doc('Mara slept.'))
  const mara = record('Mara')
  const orrin = record('Orrin')
  const tomas = record('Tomas')
  const lena = record('Lena')
  seedClaims(
    db,
    one,
    [
      { recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 0 },
      { recordId: orrin, slot: 'eyes', value: 'green', quote: "Orrin's eyes were green", para: 1 },
      {
        recordId: tomas,
        slot: 'history',
        value: 'his father kept a tavern in Vellmouth',
        quote: 'his father kept a tavern in Vellmouth',
        para: 2
      },
      { recordId: lena, slot: 'hair', value: 'dark', quote: "Lena's hair was dark", para: 3 }
    ],
    NOW
  )
  seedClaims(
    db,
    two,
    [
      { recordId: mara, slot: 'eyes', value: 'brown', quote: "Mara's eyes were brown", para: 1 },
      { recordId: orrin, slot: 'eyes', value: 'blue', quote: "Orrin's eyes were blue", para: 2 },
      {
        recordId: tomas,
        slot: 'history',
        value: 'his father kept a forge in Vellmouth',
        quote: "Tomas's father kept a forge in Vellmouth",
        para: 3
      },
      { recordId: lena, slot: 'hair', value: 'fair', quote: "Lena's hair was fair", para: 4 }
    ],
    NOW
  )
  // Scene two's card says flashback: Lena's hair pair is hidden (C2 body).
  upsertCard(
    db,
    {
      nodeId: two,
      draftId: activeDraftId(db),
      readingId: null,
      line: 'Years before.',
      gist: 'Years before.',
      fields: {
        ...emptyCardFields(),
        flashback: { value: 'yes', quote: 'The rain came, years before', p: 0, verified: true }
      },
      present: [],
      mood: null,
      theme: null,
      anchor: cardAnchorOf(db, two),
      seen: cardAnchorOf(db, two)
    },
    NOW
  )
  // A secret readers know from scene one, with no learning line by anyone.
  createTopic(
    db,
    {
      kind: 'secret',
      label: 'the sold map',
      quote: revealIn(db, one, { para: 4, quote: 'Tomas sold the map', label: 'the sold map' })
    },
    NOW
  )
  // Scenes one and two read whole; three not read yet.
  for (const nodeId of [one, two]) {
    const row = getNode(db, nodeId)
    if (row === undefined) throw new Error('no scene')
    const sentences = gateSentences(rowTexts(row), {
      caretPara: null,
      names: nameScanShared(db).index
    })
    writeSceneRead(
      db,
      {
        nodeId,
        draftId: activeDraftId(db),
        entries: nextReadSet(null, sentences, 'all'),
        full: true,
        readingId: null,
        topics: true,
        settled: true
      },
      NOW
    )
  }
  settings = { ...defaultAiSettings(), dial: 1 }
  cloudCapped = false
  spent = []
  progressed = 0
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the price of Check the book (P4-D22)', () => {
  it('prices the uncached pairs and the confirmations, about and at most, before anything is sent', () => {
    const estimate = estimateCheck(db, CONTEXT)
    expect(estimate).toMatchObject({
      free: false,
      // Mara's and Orrin's eyes (C1), Tomas's father (C7); Lena's hair is hidden.
      pairs: 3,
      uncached: 6,
      fastCalls: 2,
      confirms: { about: 1, most: 3 },
      hidden: 1,
      cloud: false,
      priced: true
    })
    expect(estimate.aboutUsd).toBeGreaterThan(0)
    expect(estimate.mostUsd).toBeGreaterThan(estimate.aboutUsd)
    // Scene three has words and was never read for secrets and threads.
    expect(estimate.unreadScenes.map((scene) => scene.nodeId)).toEqual([three])
    // The price writes nothing.
    expect(findingsOf(db, activeDraftId(db))).toEqual([])
    expect(estimateCheck(db, { ...CONTEXT, source: 'cloud' }).cloud).toBe(true)
  })
})

describe('Check the book (F-16.30)', () => {
  it('judges every pair (C7 included), confirms the open ones, and reports; a repeat is free', async () => {
    const ai = judge()
    const service = createFindingsService(deps(ai))
    service.checkAsked(two)
    const result = await service.checkBook(db, 'check-1')
    // One batch of three pairs in both orders, then one stronger call per open finding.
    expect(ai.requests.filter((request) => isJudge(request) && !isConfirm(request))).toHaveLength(2)
    expect(ai.requests.filter(isConfirm)).toHaveLength(3)
    expect(result.requested).toBe(true)
    // Mara's eyes confirmed, Orrin's cleared by the stronger check, Tomas's father unclear, Lena's
    // hair hidden as a flashback (never judged).
    expect(states()).toEqual(['C1:fine:ok', 'C1:open:c', 'C2:hidden:-', 'C7:unclear:u'])
    // Asked spend, and the stronger check's strong tier.
    expect(spent.every((each) => each.asked)).toBe(true)
    expect(ai.requests.filter(isConfirm).every((request) => request.tier === 'strong')).toBe(true)
    // Progress for the activity bar.
    expect(service.progress()).toMatchObject({
      judged: 3,
      toJudge: 3,
      confirmed: 3,
      toConfirm: 3,
      stopped: false,
      reason: null
    })
    expect(service.progress()?.finishedAt).toEqual(NOW.toISOString())
    expect(progressed).toBeGreaterThan(0)

    const report = checkReport(db)
    expect(report).not.toBeNull()
    expect(report?.found.map((each) => each.name)).toEqual(['Mara'])
    expect(report?.found[0]?.confirmed).toBe(true)
    expect(report?.unclear.map((each) => each.name)).toEqual(['Tomas'])
    expect(report?.cleared.map((each) => each.name)).toEqual(['Orrin'])
    expect(report).toMatchObject({
      stopped: false,
      confirmed: 1,
      // Scene three was never read: listed as not checked, never counted as checked.
      checked: { pairs: 3, byRule: { C1: 2, C7: 1 }, scenes: 2 },
      notChecked: {
        fixed: [...CHECK_NOT_COVERED],
        unreadScenes: [{ nodeId: three }],
        pastConfirm: 0,
        unjudged: 0
      }
    })
    expect(report?.notChecked.fixed.join(' ')).toContain('travel times')
    // Hidden as a flashback, with the scene Not a flashback? marks.
    expect(report?.hidden).toEqual([expect.objectContaining({ nodeId: two, label: 'Lena: Hair' })])
    // Secrets nobody learns: the scene readers know it since, and "checked up to" only.
    expect(report?.secretsNobodyLearns).toEqual([
      {
        secretId: expect.any(String) as string,
        label: 'the sold map',
        readersSince: { nodeId: one, ref: expect.any(String) as string },
        checkedUpTo: { nodeId: two, ref: expect.any(String) as string }
      }
    ])
    expect(report?.costUsd).toBeGreaterThan(0)

    // Nothing changed: the price is free and a second check sends nothing.
    expect(estimateCheck(db, CONTEXT)).toMatchObject({
      free: true,
      fastCalls: 0,
      confirms: { most: 0 }
    })
    const before = ai.requests.length
    const again = await service.checkBook(db, 'check-2')
    expect(ai.requests).toHaveLength(before)
    expect(again.requested).toBe(false)
    expect(checkReport(db)?.found.map((each) => each.name)).toEqual(['Mara'])
  })

  it('confirms at most 20, by rule then the open scene first; the rest are past the confirmations', async () => {
    const people: string[] = []
    const grey: string[] = []
    const brown: string[] = []
    for (let i = 0; i < CHECK_CONFIRM_MAX + 2; i += 1) {
      const name = `Person${String(i + 1).padStart(2, '0')}`
      people.push(record(name))
      grey.push(`${name}'s eyes were grey.`)
      brown.push(`${name}'s eyes were brown.`)
    }
    saveDocument(db, one, doc(...grey))
    saveDocument(db, two, doc(...brown))
    for (const [i, id] of people.entries()) {
      const name = `Person${String(i + 1).padStart(2, '0')}`
      seedClaims(
        db,
        one,
        [{ recordId: id, slot: 'eyes', value: 'grey', quote: `${name}'s eyes were grey`, para: i }],
        NOW
      )
      seedClaims(
        db,
        two,
        [
          {
            recordId: id,
            slot: 'eyes',
            value: 'brown',
            quote: `${name}'s eyes were brown`,
            para: i
          }
        ],
        NOW
      )
    }
    const ai = judge()
    const service = createFindingsService(deps(ai))
    await service.checkBook(db, 'check-many')
    expect(ai.requests.filter(isConfirm)).toHaveLength(CHECK_CONFIRM_MAX)
    const open = findingsOf(db, activeDraftId(db)).filter((each) => each.state === 'open')
    expect(open.filter((each) => each.confirm === null)).toHaveLength(2)
    expect(checkReport(db)?.notChecked.pastConfirm).toBe(2)
    // The next check confirms the two left, and nothing else.
    await service.checkBook(db, 'check-many-2')
    expect(ai.requests.filter(isConfirm)).toHaveLength(CHECK_CONFIRM_MAX + 2)
  })

  it('orders the confirmations by rule, then the open scene, then newest', () => {
    const finding = (rule: 'C1' | 'C6', nodeId: string, created: string) => ({
      id: `${rule}-${nodeId}-${created}`,
      draftId: 'd',
      rule,
      variant: null,
      recordId: 'r',
      slot: 'eyes',
      key: `${rule}-${nodeId}-${created}`,
      npKey: 'np',
      a: { kind: 'claim' as const, claimId: 'c', nodeId, valueKey: 'v', seen: 's' },
      b: { kind: 'claim' as const, claimId: 'c2', nodeId: 'elsewhere', valueKey: 'w', seen: 's' },
      extra: null,
      verdictAb: 'c' as const,
      verdictBa: 'c' as const,
      why: null,
      confirm: null,
      confirmWhy: null,
      state: 'open' as const,
      costUsd: 0,
      shownAt: null,
      created,
      judgedAt: null,
      confirmedAt: null,
      rendered: null
    })
    const ordered = confirmOrder(
      [
        finding('C6', 'open', '2026-10-13T01:00:00.000Z'),
        finding('C1', 'other', '2026-10-13T03:00:00.000Z'),
        finding('C1', 'open', '2026-10-13T01:00:00.000Z'),
        finding('C1', 'other', '2026-10-13T02:00:00.000Z')
      ],
      'open'
    )
    expect(ordered.map((each) => each.id)).toEqual([
      'C1-open-2026-10-13T01:00:00.000Z',
      'C1-other-2026-10-13T03:00:00.000Z',
      'C1-other-2026-10-13T02:00:00.000Z',
      'C6-open-2026-10-13T01:00:00.000Z'
    ])
  })

  it('spends as asked past the Cloud cap, and holds at the daily cap with nothing sent', async () => {
    cloudCapped = true
    const ai = judge()
    const service = createFindingsService(deps(ai))
    await service.checkBook(db, 'check-capped')
    expect(ai.requests.length).toBeGreaterThan(0)
    expect(spent.every((each) => each.asked)).toBe(true)

    const capped = judge()
    const today = capped.deps.dailyCap.get()
    capped.deps.dailyCap.get = () => ({
      ...today,
      dailyCapUsd: 0.5,
      spentTodayUsd: 0.5,
      spentDate: '2026-10-13'
    })
    const held = createFindingsService(deps(capped))
    expect(held.askedHold(db)).toBe(HOLD.dailyCap)
    await expect(held.checkBook(db, 'check-daily')).rejects.toThrow(JobSkippedError)
    expect(capped.requests).toEqual([])
    // Ended as it began, with the hold: the dialog waiting on it says why.
    expect(held.progress()).toMatchObject({
      finishedAt: NOW.toISOString(),
      judged: 0,
      stopped: true,
      reason: HOLD.dailyCap
    })
  })

  it('keeps what was judged when it is stopped, and says so', async () => {
    const ai = judge(() => {
      cancelInflight('check-stop')
      throw new AiCancelledError('Stopped.')
    })
    const service = createFindingsService(deps(ai))
    await expect(service.checkBook(db, 'check-stop')).rejects.toThrow(AiCancelledError)
    // Both orders were judged before the stop: the open findings stay, unconfirmed.
    const rows = findingsOf(db, activeDraftId(db))
    expect(rows.filter((each) => each.state === 'open').length).toBeGreaterThan(0)
    expect(rows.every((each) => each.confirm === null)).toBe(true)
    expect(checkReport(db)).toMatchObject({ stopped: true })
    expect(checkReport(db)?.notChecked.pastConfirm).toBeGreaterThan(0)
    // A Stop has no cause to state.
    expect(service.progress()).toMatchObject({ stopped: true, reason: null })
  })

  it('lists no secret once someone learns it', async () => {
    const ai = judge()
    const service = createFindingsService(deps(ai))
    await service.checkBook(db, 'check-secret')
    const secret = checkReport(db)?.secretsNobodyLearns[0]?.secretId ?? ''
    saveDocument(db, three, doc('Mara slept.', 'Orrin overheard Tomas at the gate.'))
    const learner = record('Ash')
    seedClaims(
      db,
      three,
      [
        {
          recordId: learner,
          slot: 'knows',
          value: 'overheard',
          how: 'overheard',
          objectId: secret,
          quote: 'Orrin overheard Tomas',
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    await service.checkBook(db, 'check-secret-2')
    expect(checkReport(db)?.secretsNobodyLearns).toEqual([])
  })
})
