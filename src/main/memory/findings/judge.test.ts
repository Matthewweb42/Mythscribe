import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyCardFields } from '@shared/memory/claims'
import type { Finding, FindingState } from '@shared/memory/findings'
import { emptySceneDetails } from '@shared/memory/sceneDetails'
import type { TiptapNodeT } from '@shared/tiptap'
import { JUDGE_SENTINEL } from '../../ai/prompts/judge.v1'
import type { CompletionRequest } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, moveNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { indexStaleRecords } from '../passageIndexer'
import { createRecord, renameAlias, requireRecord, savePage } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { upsertCard } from '../reading/cardStore'
import { cardAnchorOf, seedClaims } from '../reading/claimFixture'
import { deleteClaims, draftClaims } from '../reading/claimStore'
import { fakeAi, type FakeAnswer } from '../reading/readingFixture'
import { findingsOf, setVerdicts } from './findingStore'
import { runFindingsJob } from './findingsJob'
import { judgeContext, judgeFindings, pairItem } from './judge'
import { cachedVerdict } from './verdictCache'

/**
 * The contradiction judge's runs (F-16.27; plan P4 §2.3, §2.6) over a stored book and the shared
 * fake provider: each batch goes twice, the second call with the passages swapped; both `c` open
 * a finding, any `ok` clears it, a `u` without an `ok` leaves it unclear, a missing order keeps it
 * unjudged; a cut-off reply is read to its last whole verdict; every pair-order is remembered, so a
 * second run, a scene move and a Rename in book cost nothing, while a changed context sentence is
 * judged again; each call's cost is shared out to its findings.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let chapter: string
let mara: string
let one: string
let two: string

const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function record(name: string): string {
  const made = createRecord(db, { name, categoryId: 'character', force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

function scene(title: string, ...paragraphs: string[]): string {
  const id = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
  saveDocument(db, id, doc(...paragraphs))
  return id
}

/** The judge's items in a request: number, then the A and B lines' places and values. */
interface SentItem {
  n: number
  a: { place: string; says: string }
  b: { place: string; says: string }
}

function sentItems(request: Pick<CompletionRequest, 'messages'>): SentItem[] {
  const user = request.messages.at(-1)?.content ?? ''
  return user
    .replace(/^Pairs:\n/u, '')
    .split('\n\n')
    .flatMap((block) => {
      const n = /^(\d+)\. /u.exec(block)?.[1]
      const side = (label: string): { place: string; says: string } | null => {
        const match = new RegExp(`^${label} \\[([^·\\]]+)[^\\]]*\\] says ([^:]+):`, 'mu').exec(
          block
        )
        return match === null ? null : { place: (match[1] ?? '').trim(), says: match[2] ?? '' }
      }
      const a = side('A')
      const b = side('B')
      return n === undefined || a === null || b === null ? [] : [{ n: Number(n), a, b }]
    })
}

const isJudge = (request: CompletionRequest): boolean =>
  request.messages[0]?.content.startsWith(JUDGE_SENTINEL) === true

/** A judge that answers every item with `verdict(item, call)`, the call counted from 1. */
function judgeWith(
  verdict: (item: SentItem, call: number) => 'c' | 'ok' | 'u' | null,
  extra: (call: number) => Partial<FakeAnswer> = () => ({})
): ReturnType<typeof fakeAi> {
  let calls = 0
  return fakeAi((request) => {
    calls += 1
    const v = sentItems(request).flatMap((item) => {
      const r = verdict(item, calls)
      return r === null ? [] : [{ i: item.n, r, ...(r === 'c' ? { w: 'values differ' } : {}) }]
    })
    return { text: JSON.stringify({ v }), ...extra(calls) }
  })
}

const unjudged = (): Finding[] => findingsOf(db, activeDraftId(db), ['unjudged'])

/** The C1 finding's state (the book's grey against brown). */
const state = (): FindingState | undefined =>
  findingsOf(db, activeDraftId(db)).find((each) => each.rule === 'C1')?.state

/** The judge requests a fake received. */
const judgeCalls = (ai: ReturnType<typeof fakeAi>): CompletionRequest[] =>
  ai.requests.filter(isJudge)

async function judge(
  ai: ReturnType<typeof fakeAi>,
  maxPairs = 10
): ReturnType<typeof judgeFindings> {
  const draftId = activeDraftId(db)
  return judgeFindings(
    judgeContext(db, draftId),
    { ai: ai.deps },
    { findings: unjudged(), maxPairs, requestId: 'judge-test', now: () => NOW }
  )
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-judge-'))
  session = createProject(projectFolderFor(tmp, 'Judge'), 'Judge', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  chapter = getNode(db, first)?.parentId ?? ''
  mara = record('Mara')
  one = first
  saveDocument(db, one, doc('Mara climbed the ridge.', "Mara's eyes were grey. The wind rose."))
  two = scene('Two', 'The rain came.', "Mara's eyes were brown.")
  seedClaims(
    db,
    one,
    [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 }],
    NOW
  )
  seedClaims(
    db,
    two,
    [{ recordId: mara, slot: 'eyes', value: 'brown', quote: "Mara's eyes were brown", para: 1 }],
    NOW
  )
  runFindingsJob(db, NOW, { cachedVerdicts: true })
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('judging a pair in both orders (F-16.27, P4-D11)', () => {
  it('sends each batch twice, the second call with the passages swapped, and opens on two c', async () => {
    expect(unjudged()).toHaveLength(1)
    const ai = judgeWith(() => 'c')
    const run = await judge(ai)
    const calls = ai.requests.filter(isJudge)
    expect(calls).toHaveLength(2)
    const [ab, ba] = calls.map((request) => sentItems(request)[0])
    expect(ab?.a).toEqual({ place: '1.1 ¶1', says: 'grey' })
    expect(ab?.b).toEqual({ place: '1.2 ¶1', says: 'brown' })
    expect(ba?.a).toEqual({ place: '1.2 ¶1', says: 'brown' })
    expect(ba?.b).toEqual({ place: '1.1 ¶1', says: 'grey' })
    // The question is the same in both calls; only the passages moved.
    const question = (request: CompletionRequest | undefined): string =>
      (request?.messages.at(-1)?.content ?? '').split('\n')[1] ?? ''
    expect(question(calls[1])).toBe(question(calls[0]))
    expect(question(calls[0])).toBe('1. Mara · eyes. Can both be true?')
    // Fast tier, JSON, judge.v1, its own child ids.
    expect(ai.ledger.map((row) => [row.feature, row.promptVersion])).toEqual([
      ['judge', 'judge.v1'],
      ['judge', 'judge.v1']
    ])
    expect(calls.every((request) => request.tier === 'fast' && request.json === true)).toBe(true)
    expect(run).toMatchObject({ requested: true, sent: 1, unanswered: 0, left: 0, dropped: 0 })
    const [finding] = findingsOf(db, activeDraftId(db))
    expect(finding).toMatchObject({
      state: 'open',
      verdictAb: 'c',
      verdictBa: 'c',
      why: 'values differ'
    })
    // Its cost is both calls' (the pair was each call's only one).
    expect(finding?.costUsd).toBeCloseTo(run.costUsd, 10)
    expect(run.costUsd).toBeGreaterThan(0)
  })

  it.each([
    ['c', 'ok', 'fine'],
    ['ok', 'c', 'fine'],
    ['c', 'u', 'unclear'],
    ['u', 'u', 'unclear']
  ] as const)('a %s then %s reads as %s', async (first, second, state) => {
    await judge(judgeWith((_item, call) => (call === 1 ? first : second)))
    expect(findingsOf(db, activeDraftId(db))[0]?.state).toBe(state)
  })

  it('keeps a pair unjudged while one order is missing, and sends only that order next time', async () => {
    const first = judgeWith((_item, call) => (call === 1 ? 'c' : null))
    const run = await judge(first)
    expect(run.unanswered).toBe(1)
    expect(findingsOf(db, activeDraftId(db))[0]).toMatchObject({
      state: 'unjudged',
      verdictAb: 'c',
      verdictBa: null
    })
    const second = judgeWith(() => 'c')
    await judge(second)
    const calls = second.requests.filter(isJudge)
    expect(calls).toHaveLength(1)
    // The B,A order alone: brown first.
    expect(sentItems(calls[0] ?? { messages: [] })[0]?.a.says).toBe('brown')
    expect(findingsOf(db, activeDraftId(db))[0]?.state).toBe('open')
  })

  it('reads a cut-off reply to its last whole verdict; the rest wait for the next run', async () => {
    const tomas = record('Tomas')
    seedClaims(
      db,
      one,
      [{ recordId: tomas, slot: 'hair', value: 'red', quote: 'The wind rose', para: 1 }],
      NOW
    )
    seedClaims(
      db,
      two,
      [{ recordId: tomas, slot: 'hair', value: 'black', quote: 'The rain came', para: 0 }],
      NOW
    )
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(unjudged()).toHaveLength(2)
    const ai = fakeAi((request) => {
      if (!isJudge(request)) return { text: '{}' }
      const n = sentItems(request).length
      return n === 2
        ? {
            text: '{"v":[{"i":1,"r":"c","w":"values differ"},{"i":2,"r":"o',
            finishReason: 'length'
          }
        : { text: '{"v":[]}' }
    })
    const run = await judge(ai)
    // Two calls (A,B and B,A), each answered for its first pair only: that pair is judged in
    // both orders, the other in neither, and stays unjudged for the next run.
    expect(ai.requests.filter(isJudge)).toHaveLength(2)
    expect(run.unanswered).toBe(2)
    const states = findingsOf(db, activeDraftId(db)).map((f) => [f.state, f.verdictAb, f.verdictBa])
    expect(states).toContainEqual(['open', 'c', 'c'])
    expect(states).toContainEqual(['unjudged', null, null])
  })

  it('costs nothing the second time: the same words are remembered in both orders', async () => {
    await judge(judgeWith(() => 'c'))
    const [finding] = findingsOf(db, activeDraftId(db))
    if (finding === undefined) throw new Error('no finding')
    setVerdicts(db, finding.id, { ab: null, ba: null, why: null, costUsd: 0, now: NOW })
    const again = judgeWith(() => 'ok')
    const run = await judge(again)
    expect(again.requests).toHaveLength(0)
    expect(run).toMatchObject({ requested: false, sent: 0, costUsd: 0 })
    expect(findingsOf(db, activeDraftId(db))[0]?.state).toBe('open')
  })

  it('reopens a finding from the cache at no cost when the recompute makes it again', async () => {
    await judge(judgeWith(() => 'c'))
    // The brown claim goes (the finding closes), then comes back as it was.
    const brown = draftClaims(db, activeDraftId(db)).find((claim) => claim.value === 'brown')
    deleteClaims(db, [brown?.id ?? ''])
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(findingsOf(db, activeDraftId(db))).toEqual([])
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'eyes', value: 'brown', quote: "Mara's eyes were brown", para: 1 }],
      NOW
    )
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(findingsOf(db, activeDraftId(db))[0]).toMatchObject({ state: 'open', costUsd: 0 })
  })

  it('a scene move keeps the key (scene numbers are masked); swapping the order does not', () => {
    const ctx = () => judgeContext(db, activeDraftId(db))
    const [finding] = findingsOf(db, activeDraftId(db))
    if (finding === undefined) throw new Error('no finding')
    const before = pairItem(ctx(), finding)?.keys
    // A new scene before both: 1.1 and 1.2 become 1.2 and 1.3.
    const opening = scene('Opening', 'Dawn.')
    moveNode(db, opening, chapter, null)
    const moved = pairItem(ctx(), finding)
    expect(moved?.item.pair.a.place).toBe('1.2 ¶1')
    expect(moved?.keys).toEqual(before)
    // Two after one: now the brown passage comes first, which the judge reads differently.
    moveNode(db, two, chapter, null)
    expect(pairItem(ctx(), finding)?.keys.ab).not.toBe(before?.ab)
  })

  it('a Rename in book costs no request: names fold to their record', async () => {
    await judge(judgeWith(() => 'c'))
    // The prose and the claims say "Mary" now; the record is renamed.
    const alias = requireRecord(db, mara).aliases[0]
    renameAlias(db, mara, alias?.id ?? '', 'Mary', NOW)
    saveDocument(db, one, doc('Mary climbed the ridge.', "Mary's eyes were grey. The wind rose."))
    saveDocument(db, two, doc('The rain came.', "Mary's eyes were brown."))
    deleteClaims(
      db,
      draftClaims(db, activeDraftId(db)).map((claim) => claim.id)
    )
    seedClaims(
      db,
      one,
      [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mary's eyes were grey", para: 1 }],
      NOW
    )
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'eyes', value: 'brown', quote: "Mary's eyes were brown", para: 1 }],
      NOW
    )
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    const after = judgeWith(() => 'ok')
    await judge(after)
    expect(after.requests).toHaveLength(0)
    expect(findingsOf(db, activeDraftId(db))[0]?.state).toBe('open')
  })

  it('never keeps a reply that leaves a pair unanswered: the next run asks the provider again', async () => {
    // One pair sent; the reply answers an item that was never sent.
    const wrong = fakeAi((request) =>
      isJudge(request) ? { text: '{"v":[{"i":2,"r":"c","w":"values differ"}]}' } : { text: '{}' }
    )
    const first = await judge(wrong)
    expect(first.unanswered).toBe(2)
    expect(wrong.requests.filter(isJudge)).toHaveLength(2)
    // The same two calls again: neither reply was cached, so both reach the provider.
    await judge(wrong)
    expect(wrong.requests.filter(isJudge)).toHaveLength(4)
    expect(state()).toBe('unjudged')
  })

  it('shares each call’s cost out to the pairs it carried, and sends at most maxPairs', async () => {
    const tomas = record('Tomas')
    seedClaims(
      db,
      one,
      [{ recordId: tomas, slot: 'hair', value: 'red', quote: 'The wind rose', para: 1 }],
      NOW
    )
    seedClaims(
      db,
      two,
      [{ recordId: tomas, slot: 'hair', value: 'black', quote: 'The rain came', para: 0 }],
      NOW
    )
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    const ai = judgeWith(() => 'c')
    const run = await judge(ai)
    expect(ai.requests.filter(isJudge)).toHaveLength(2)
    const costs = findingsOf(db, activeDraftId(db)).map((each) => each.costUsd)
    expect(costs[0]).toBeCloseTo(run.costUsd / 2, 10)
    expect(costs[1]).toBeCloseTo(run.costUsd / 2, 10)
    // A limit of one pair leaves the other for the next run.
    for (const each of findingsOf(db, activeDraftId(db))) {
      setVerdicts(db, each.id, { ab: null, ba: null, why: null, costUsd: 0, now: NOW })
    }
    saveDocument(db, two, doc('The rain came.', "Mara's eyes were brown. Thunder."))
    const limited = judgeWith(() => 'c')
    const one1 = await judge(limited, 1)
    expect(one1).toMatchObject({ sent: 1 })
    expect(one1.left + one1.judged.length).toBe(2)
  })

  it('drops a pair whose side is gone (the recompute closes it) and sends nothing for it', async () => {
    saveDocument(db, two, doc('The rain came.', 'Nothing about eyes.'))
    const ai = judgeWith(() => 'c')
    const run = await judge(ai)
    expect(ai.requests).toHaveLength(0)
    expect(run.dropped).toBe(1)
  })
})

describe('the words the judge read, as the book moves (P4 slice 2 review)', () => {
  const recompute = (): void => void runFindingsJob(db, NOW, { cachedVerdicts: true })

  it('judges a changed context sentence afresh through the recompute, and keeps an unchanged one', async () => {
    await judge(judgeWith(() => 'c'))
    expect(state()).toBe('open')
    // An edit in another paragraph of the scene: the words the judge read are the same.
    saveDocument(
      db,
      one,
      doc('Mara climbed the high ridge.', "Mara's eyes were grey. The wind rose.")
    )
    recompute()
    expect(state()).toBe('open')
    // The sentence after the quote changed: the pair's words moved, so its verdicts go.
    saveDocument(
      db,
      one,
      doc('Mara climbed the high ridge.', "Mara's eyes were grey. The snow fell.")
    )
    recompute()
    expect(findingsOf(db, activeDraftId(db))[0]).toMatchObject({
      state: 'unjudged',
      verdictAb: null,
      verdictBa: null
    })
    const again = judgeWith(() => 'ok')
    await judge(again)
    expect(judgeCalls(again)).toHaveLength(2)
    expect(judgeCalls(again)[0]?.messages.at(-1)?.content).toContain('The snow fell')
    expect(state()).toBe('fine')
    // Nothing moved since: the recompute keeps the verdicts and nothing more is sent.
    recompute()
    const idle = judgeWith(() => 'c')
    await judge(idle)
    expect(judgeCalls(idle)).toHaveLength(0)
    expect(state()).toBe('fine')
  })

  it('judges a pair afresh when a story year is typed for one of its scenes', async () => {
    await judge(judgeWith(() => 'c'))
    setSceneDetails(db, two, { ...emptySceneDetails(), storyYear: 1820 }, NOW)
    recompute()
    expect(state()).toBe('unjudged')
    const again = judgeWith(() => 'ok')
    await judge(again)
    expect(judgeCalls(again)).toHaveLength(2)
    expect(judgeCalls(again)[0]?.messages.at(-1)?.content).toContain('story year 1820')
    expect(state()).toBe('fine')
  })

  it('judges a pair afresh when a time skip appears between its scenes', async () => {
    await judge(judgeWith(() => 'c'))
    // A scene placed between the two: no new words for the judge (scene places are masked).
    const mid = scene('Mid', 'Ten years later, the war ended.')
    moveNode(db, mid, chapter, one)
    recompute()
    expect(state()).toBe('open')
    // Its reading finds a time skip that crosses a year: the judge now reads it between them.
    upsertCard(
      db,
      {
        nodeId: mid,
        draftId: activeDraftId(db),
        readingId: null,
        line: 'The war ends.',
        gist: 'The war ends.',
        fields: {
          ...emptyCardFields(),
          elapsed: { value: 'ten years', quote: 'Ten years later', p: 0, verified: true }
        },
        present: [],
        mood: null,
        theme: null,
        anchor: cardAnchorOf(db, mid),
        seen: cardAnchorOf(db, mid)
      },
      NOW
    )
    recompute()
    expect(state()).toBe('unjudged')
    const again = judgeWith(() => 'ok')
    await judge(again)
    expect(judgeCalls(again)).toHaveLength(2)
    expect(judgeCalls(again)[0]?.messages.at(-1)?.content).toContain('Between: “Ten years”')
    expect(state()).toBe('fine')
  })

  it('judges a note pair afresh when the note sentence’s context changes (C6)', async () => {
    savePage(db, mara, 'pinned', doc('Eyes: green.'), NOW)
    indexStaleRecords(db, NOW)
    recompute()
    const notes = (): Finding[] =>
      findingsOf(db, activeDraftId(db)).filter((each) => each.rule === 'C6')
    expect(notes().length).toBeGreaterThan(0)
    await judge(judgeWith(() => 'c'))
    expect(notes().every((each) => each.state === 'open')).toBe(true)
    // The same line, a new sentence after it: the note side is the same, its words are not.
    savePage(db, mara, 'pinned', doc('Eyes: green. She hides them behind smoked glass.'), NOW)
    indexStaleRecords(db, NOW)
    recompute()
    expect(notes().every((each) => each.state === 'unjudged')).toBe(true)
    expect(state()).toBe('open')
    const again = judgeWith(() => 'c')
    await judge(again)
    // Only the note pairs, in one batch, both orders.
    expect(judgeCalls(again)).toHaveLength(2)
    expect(judgeCalls(again)[0]?.messages.at(-1)?.content).toContain('smoked glass')
    expect(notes().every((each) => each.state === 'open')).toBe(true)
  })

  it('never lands a verdict on a pair a recompute re-stated while the call was out', async () => {
    const before = findingsOf(db, activeDraftId(db))[0]
    if (before === undefined) throw new Error('no finding')
    const first = pairItem(judgeContext(db, activeDraftId(db)), before)
    let restated: FindingState | undefined
    const ai = judgeWith(
      () => 'c',
      (call) => {
        if (call === 1) {
          // While the A,B call is out, scene two is rewritten and read again: a new brown claim.
          saveDocument(db, two, doc('The rain came.', "Mara's eyes were brown as peat."))
          const brown = draftClaims(db, activeDraftId(db)).find((each) => each.value === 'brown')
          deleteClaims(db, [brown?.id ?? ''])
          seedClaims(
            db,
            two,
            [
              {
                recordId: mara,
                slot: 'eyes',
                value: 'brown',
                quote: "Mara's eyes were brown as peat",
                para: 1
              }
            ],
            NOW
          )
          recompute()
          restated = state()
        }
        return {}
      }
    )
    const run = await judge(ai)
    expect(restated).toBe('unjudged')
    // The A,B verdict was for words the row no longer has: not written, and no B,A call for them.
    expect(judgeCalls(ai)).toHaveLength(1)
    expect(run).toMatchObject({ moved: 1, judged: [], settled: [] })
    const [after] = findingsOf(db, activeDraftId(db))
    expect(after).toMatchObject({ state: 'unjudged', verdictAb: null, verdictBa: null })
    // It is remembered under the words it was given for.
    expect(cachedVerdict(db, first?.keys.ab ?? '', NOW)).toMatchObject({ verdict: 'c' })
    // The next run judges the new words, both orders.
    const next = judgeWith(() => 'c')
    await judge(next)
    expect(judgeCalls(next)).toHaveLength(2)
    expect(judgeCalls(next)[0]?.messages.at(-1)?.content).toContain('brown as peat')
    expect(state()).toBe('open')
  })
})
