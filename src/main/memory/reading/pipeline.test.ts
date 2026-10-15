import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sceneSentences } from '@shared/memory/anchor'
import { dismissedKey } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetInflight } from '../../ai/inflight'
import type { CompletionRequest } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { dismiss } from '../dismissedStore'
import { nameScanShared, scanNamesFor } from '../nameIndexer'
import { answerNameQuestion, listNameQuestions, resetNameQuestionCache } from '../questions'
import { createRecord } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { runAnchors } from './anchors'
import { getCard } from './cardStore'
import { sceneTexts } from './claimFixture'
import { invariantClaims, sceneClaims } from './claimStore'
import { runReading, type ReadingItemEvent, type ReadingOutcome } from './pipeline'
import { lastReading } from './readingStore'
import {
  fakeAi,
  requestKind,
  rosterIds,
  sentChecks,
  sentParagraphs,
  type FakeAi,
  type FakeAnswer
} from './readingFixture'
import { getSceneRead } from './sceneReadStore'
import { acceptSuggestions } from './suggestions'
import { settleOwnedNames } from './waiting'

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let mara: string
let tomas: string
let lise: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function record(name: string, aliases: string[] = [], categoryId = 'character'): string {
  const made = createRecord(
    db,
    { name, categoryId, aliases: aliases.map((text) => ({ text })), force: true },
    NOW
  )
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

const SCENE = [
  'The ridge was cold.',
  "Mara's eyes were grey. She walked to the quay.",
  'Tomas sat by the nets.'
]

beforeEach(() => {
  resetInflight()
  resetNameQuestionCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-pipeline-'))
  session = createProject(projectFolderFor(tmp, 'Pipeline'), 'Pipeline', 'novel')
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  saveDocument(db, one, doc(...SCENE))
  mara = record('Mara Vell', ['Mara'])
  tomas = record('Tomas')
  lise = record('Lise')
  record('the Quay', [], 'setting')
  scanNamesFor(db, one, NOW)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface PlannedClaim {
  p: number
  r: string
  s: string
  v: string
  q: string
  voice?: string
  sp?: string | null
  mode?: string
  /** A kinship's or relation's other record, by name. */
  o?: string
}

/** A reader answer from planned claims; `r` is a record's name, mapped to the request's roster id. */
function readerReply(
  request: CompletionRequest,
  claims: readonly PlannedClaim[],
  extra: Record<string, unknown> = {}
): string {
  const ids = rosterIds(request)
  const sent = sentParagraphs(request)
  const c = claims
    .filter((claim) => sent.has(claim.p))
    .map((claim) => ({
      p: claim.p,
      r: ids.get(claim.r) ?? claim.r,
      s: claim.s,
      v: claim.v,
      q: claim.q,
      voice: claim.voice ?? 'narration',
      sp: claim.sp === undefined || claim.sp === null ? null : (ids.get(claim.sp) ?? claim.sp),
      mode: claim.mode ?? 'now',
      o: claim.o === undefined ? null : (ids.get(claim.o) ?? claim.o),
      chg: false
    }))
  return JSON.stringify({ c, n: [], same: [], drop: [], ...extra })
}

/** A checker that supports every item, picking the first candidate (or `pick`'s answer). */
function verifyReply(
  request: CompletionRequest,
  pick: (check: ReturnType<typeof sentChecks>[number]) => Record<string, unknown> | null = () =>
    null
): string {
  return JSON.stringify({
    v: sentChecks(request).map((check) => ({
      i: check.i,
      ok: true,
      r: check.who[0] ?? null,
      voice: 'narration',
      mode: 'now',
      ...(pick(check) ?? {})
    }))
  })
}

const PLAN: PlannedClaim[] = [
  { p: 1, r: 'Mara Vell', s: 'eyes', v: 'grey', q: "Mara's eyes were grey" },
  { p: 1, r: 'Mara Vell', s: 'location', v: 'the quay', q: 'She walked to the quay' },
  { p: 2, r: 'Tomas', s: 'location', v: 'by the nets', q: 'Tomas sat by the nets' }
]

const CARD = {
  line: 'Mara walks to the quay.',
  gist: 'Mara walks to the quay on a cold morning.',
  where: ['the quay', 1, 'She walked to the quay'],
  when: null,
  year: null,
  elapsed: null,
  pov: null,
  flash: null,
  present: [],
  mood: 'cold',
  theme: 'waiting'
}

/** A fake that reads `PLAN` (or `plan`) and supports every check. */
function standard(plan: readonly PlannedClaim[] = PLAN): FakeAi {
  return fakeAi((request): FakeAnswer => {
    if (requestKind(request) === 'verify') return { text: verifyReply(request) }
    const card = request.messages.at(-1)?.content.endsWith('Card: yes') === true
    return { text: readerReply(request, plan, card ? { card: CARD } : {}) }
  })
}

const read = (ai: FakeAi, extra: { caretPara?: number | null } = {}): Promise<ReadingOutcome> =>
  runReading(
    db,
    { ai: ai.deps },
    { nodeId: one, caretPara: extra.caretPara ?? null, requestId: 'r-1' }
  )

const claimsNow = (): ReturnType<typeof sceneClaims> => sceneClaims(db, one, activeDraftId(db))
/** Plan Suggestions.md: the author accepts every suggestion of the scene. */
const acceptAll = (): void => {
  acceptSuggestions(
    db,
    claimsNow().map((claim) => claim.id)
  )
}

/** The request at `i`; throws when there is none. */
function nth(requests: readonly CompletionRequest[], i: number): CompletionRequest {
  const found = requests[i]
  if (found === undefined) throw new Error(`no request ${i}`)
  return found
}

function invariants(): ReturnType<typeof checkMemoryInvariants> {
  return checkMemoryInvariants({
    claims: invariantClaims(db),
    sceneHashes: new Map([
      [one, new Set(sceneSentences(sceneTexts(db, one)).map((sentence) => sentence.hash))]
    ]),
    aliases: [],
    citations: []
  })
}

describe('runReading (F-16.17)', () => {
  it('reads a scene first whole: the literal eyes, the pronoun location through the checker, the card', async () => {
    const ai = standard()
    const outcome = await read(ai)
    expect(outcome).toMatchObject({ read: true, purpose: 'first', pages: 1, cut: false })
    const kinds = ai.requests.map(requestKind)
    expect(kinds).toEqual(['reader', 'verify'])
    // Reasoning off and the lowest effort on every story-memory request (P2a-D15).
    for (const request of ai.requests) {
      expect(request).toMatchObject({ reasoning: 'off', lowestEffort: true, json: true })
    }
    const claims = claimsNow()
    expect(claims.map((c) => [c.recordId, c.slot, c.value, c.proof, c.state])).toEqual([
      [mara, 'eyes', 'grey', 'literal', 'suggested'],
      [mara, 'location', 'the quay', 'verified', 'suggested'],
      [tomas, 'location', 'by the nets', 'literal', 'suggested']
    ])
    // The pronoun went to the checker with Mara as its one candidate and its sentence ±1.
    const checks = sentChecks(nth(ai.requests, 1))
    expect(checks.map((check) => [check.label, check.fact])).toEqual([
      ['Fact', 'location: the quay (narration, now)']
    ])
    expect(checks[0]?.text).toBe(SCENE.slice(1).join(' '))
    expect(checks[0]?.who).toHaveLength(1)
    const card = getCard(db, one, activeDraftId(db))
    expect(card).toMatchObject({ line: 'Mara walks to the quay.', mood: 'cold', theme: 'waiting' })
    expect(card?.fields.where).toEqual({
      value: 'the quay',
      quote: 'She walked to the quay',
      p: 1,
      verified: false
    })
    const reading = lastReading(db, one, activeDraftId(db))
    expect(reading).toMatchObject({
      purpose: 'first',
      pages: 1,
      promptVersion: 'reader.v7',
      verifyVersion: 'verify.v4',
      model: 'gpt-5.4-mini',
      tokensIn: 2_000,
      tokensOut: 200,
      finishReason: null,
      yields: {
        items: 3,
        quotesFound: 3,
        literal: 2,
        verifySent: 1,
        verified: 1,
        rejected: 0,
        cut: 0
      }
    })
    expect(reading?.costUsd).toBeGreaterThan(0)
    expect(claims.every((claim) => claim.readingId === reading?.id)).toBe(true)
    expect(getSceneRead(db, one, activeDraftId(db))?.partials).toBe(0)
    expect(ai.ledger.map((entry) => entry.feature)).toEqual(['reader', 'verify'])
    expect(invariants()).toEqual([])
    if (outcome.read) expect(outcome.recordIds.sort()).toEqual([mara, tomas].sort())
  })

  it('sends nothing when nothing finished changed, or only cosmetically', async () => {
    const ai = standard()
    await read(ai)
    const sent = ai.requests.length
    expect(await read(ai)).toEqual({ read: false, reason: 'upToDate' })
    saveDocument(db, one, doc(SCENE[0] ?? '', SCENE[1] ?? '', 'Tomas  sat by the nets .'))
    expect(await read(ai)).toEqual({ read: false, reason: 'cosmetic' })
    // The caret's paragraph without closing punctuation is not finished (the idle trigger).
    saveDocument(db, one, doc(...SCENE, 'Then Tomas turned'))
    expect(await read(ai, { caretPara: 3 })).toEqual({ read: false, reason: 'upToDate' })
    expect(ai.requests).toHaveLength(sent)
  })

  it('reads a window when a paragraph changed: the changed one ±2, the card not due', async () => {
    const long = [
      ...SCENE,
      'The gulls cried over the water.',
      'A boat came in.',
      'Nobody spoke.',
      'He waved.'
    ]
    saveDocument(db, one, doc(...long))
    scanNamesFor(db, one, NOW)
    const ai = standard()
    await read(ai)
    // Plan Suggestions.md: only the author's accepted lines are near facts.
    acceptAll()
    ai.requests.length = 0
    saveDocument(db, one, doc(...long.slice(0, 6), 'He waved at the boat.'))
    scanNamesFor(db, one, NOW)
    const outcome = await read(ai)
    expect(outcome).toMatchObject({ read: true, purpose: 'window' })
    const reader = ai.requests.find((request) => requestKind(request) === 'reader')
    if (reader === undefined) throw new Error('no reader request')
    // ¶6 changed: ¶4–6, which name nobody, extended back to ¶2 (Tomas).
    expect([...sentParagraphs(reader).keys()]).toEqual([2, 3, 4, 5, 6])
    expect(reader.messages.at(-1)?.content.endsWith('Card: no')).toBe(true)
    // The fact anchored in ¶2 is listed with its short id; Tomas has no fixed or lasting value.
    const tail = reader.messages.at(-1)?.content ?? ''
    expect(tail).toMatch(/c\d+ r\d+ location “by the nets” ¶2/)
    expect(tail).not.toContain('Known about the records named here:')
    expect(reader.maxTokens).toBeLessThan(720)
    expect(getSceneRead(db, one, activeDraftId(db))?.partials).toBe(1)

    // ¶3 changed: ¶1–5, where Mara is named, so what is known about her goes along.
    ai.requests.length = 0
    saveDocument(
      db,
      one,
      doc(
        ...long.slice(0, 3),
        'The gulls cried over the grey water.',
        ...long.slice(4, 6),
        'He waved at the boat.'
      )
    )
    scanNamesFor(db, one, NOW)
    await read(ai)
    const next = ai.requests.find((request) => requestKind(request) === 'reader')
    if (next === undefined) throw new Error('no reader request')
    expect([...sentParagraphs(next).keys()]).toEqual([1, 2, 3, 4, 5])
    expect(next.messages.at(-1)?.content).toMatch(
      /Known about the records named here:\nr\d+ eyes “grey”/
    )
    expect(getSceneRead(db, one, activeDraftId(db))?.partials).toBe(2)
  })

  it('reads a long scene in pages and keeps the first page’s card', async () => {
    const filler = 'The tide ran out across the mudflats and the gulls followed it. '.repeat(20)
    const long = [...SCENE, ...Array.from({ length: 8 }, () => filler.trim())]
    saveDocument(db, one, doc(...long))
    const ai = standard()
    const outcome = await read(ai)
    expect(outcome).toMatchObject({ read: true, purpose: 'first' })
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers.length).toBeGreaterThan(1)
    for (const request of readers) {
      expect(request.messages.at(-1)?.content).toMatch(/page \d of \d \(the whole scene\)/)
      // reader.v4's cap for a page of up to 400 prose tokens and its card: past v3's 720 (second
      // live run of 2026-10-14), within the reader's 1,000.
      expect(request.maxTokens).toBeGreaterThan(720)
      expect(request.maxTokens).toBeLessThanOrEqual(1_000)
    }
    expect(getCard(db, one, activeDraftId(db))?.line).toBe('Mara walks to the quay.')
    expect(claimsNow()).toHaveLength(3)
  })

  it('salvages a reply cut off at its cap and reads from the last quoted paragraph again, in halves', async () => {
    let calls = 0
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      calls += 1
      if (calls === 1) {
        const whole = readerReply(request, PLAN)
        // Cut inside the third claim (¶2).
        return { text: whole.slice(0, whole.indexOf('Tomas sat') + 4), finishReason: 'length' }
      }
      return { text: readerReply(request, PLAN) }
    })
    const outcome = await read(ai)
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    // ¶1, the last one quoted (its list may stop midway), and ¶2, each with the whole cap.
    expect(readers).toHaveLength(3)
    expect([...sentParagraphs(nth(readers, 1)).keys()]).toEqual([1])
    expect([...sentParagraphs(nth(readers, 2)).keys()]).toEqual([2])
    expect(outcome).toMatchObject({ read: true, cut: true })
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes', 'location', 'location'])
    // The re-read recovered the cut reply: one reply cut, no cut-off left in the reading.
    expect(lastReading(db, one, activeDraftId(db))).toMatchObject({
      finishReason: null,
      yields: { cut: 1 }
    })
  })

  it('leaves the paragraphs a second cut-off reply did not reach unread', async () => {
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      const whole = readerReply(request, PLAN)
      const sent = [...sentParagraphs(request).keys()]
      if (sent[0] === 0) {
        return { text: whole.slice(0, whole.indexOf('She walked') + 4), finishReason: 'length' }
      }
      return { text: '{"c":[', finishReason: 'length' }
    })
    await read(ai)
    // ¶1's facts were dropped from the cut reply for the retry, which reached nothing.
    expect(claimsNow()).toEqual([])
    // Cut again on the re-read (both halves): the reading reports the cut-off, and every cut reply.
    expect(lastReading(db, one, activeDraftId(db))).toMatchObject({
      finishReason: 'length',
      yields: { cut: 3 }
    })
    // ¶1 and ¶2 stay unread, so the next reading reads them again.
    const again = standard()
    const outcome = await read(again)
    expect(outcome).toMatchObject({ read: true })
    const reader = again.requests.find((request) => requestKind(request) === 'reader')
    expect([...sentParagraphs(nth(reader === undefined ? [] : [reader], 0)).keys()]).toContain(2)
  })

  it('counts every rejection by reason and stores none of them', async () => {
    const events: ReadingItemEvent[] = []
    const plan: PlannedClaim[] = [
      { p: 1, r: 'Mara Vell', s: 'eyes', v: 'grey', q: "Mara's eyes were green" },
      { p: 2, r: 'Mara Vell', s: 'location', v: 'the quay', q: 'She walked to the quay' },
      { p: 1, r: 'Mara Vell', s: 'eyes', v: 'grey', q: "Mara's eyes were grey" },
      { p: 1, r: 'Mara Vell', s: 'eyes', v: 'grey', q: 'grey' },
      { p: 2, r: 'Tomas', s: 'mood', v: 'the secret', q: 'Tomas sat by the nets' },
      { p: 1, r: 'Nobody', s: 'eyes', v: 'grey', q: "Mara's eyes were grey" },
      { p: 0, r: 'Mara Vell', s: 'location', v: 'the ridge', q: 'The ridge was cold' },
      { p: 2, r: 'Tomas', s: 'hair', v: 'nets', q: 'Tomas sat by the nets' }
    ]
    // Mara's eyes twice in ¶1: a quote that is not once in the window.
    saveDocument(
      db,
      one,
      doc(SCENE[0] ?? '', `${SCENE[1] ?? ''} Mara's eyes were grey.`, SCENE[2] ?? '')
    )
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ ok: false })) }
      }
      return { text: readerReply(request, plan) }
    })
    await runReading(
      db,
      { ai: ai.deps },
      {
        nodeId: one,
        caretPara: null,
        requestId: 'r-2',
        observe: (event) => events.push(event)
      }
    )
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields).toMatchObject({
      items: 8,
      quotesFound: 2,
      rejected: 8,
      rejections: {
        notFound: 1,
        otherParagraph: 1,
        repeated: 1,
        tooShort: 1,
        slot: 1,
        record: 1,
        subject: 1,
        unsupported: 1
      }
    })
    expect(events.map((event) => event.outcome).sort()).toEqual(
      [
        'notFound',
        'otherParagraph',
        'record',
        'repeated',
        'slot',
        'subject',
        'tooShort',
        'unsupported'
      ].sort()
    )
  })

  it('refuses in code what the second live run’s checker passed, before any check (2026-10-14)', async () => {
    const events: ReadingItemEvent[] = []
    saveDocument(
      db,
      one,
      doc(
        'The road was hard with frost. Mara walked quickly.',
        '“My father was a clergyman,” said Mara.',
        'Tomas was not there. Tomas had four grown-up daughters.',
        'He died in the night, in his chair by the fire.',
        'Tomas was the harbourmaster.',
        "Tomas's attentions to Mara were plain."
      )
    )
    scanNamesFor(db, one, NOW)
    const plan: PlannedClaim[] = [
      {
        p: 0,
        r: 'Mara Vell',
        s: 'location',
        v: 'the road',
        q: 'The road was hard with frost. Mara walked quickly'
      },
      {
        p: 1,
        r: 'Mara Vell',
        s: 'detail:occupation',
        v: 'a clergyman',
        q: 'My father was a clergyman',
        voice: 'dialogue',
        sp: 'Mara Vell'
      },
      { p: 2, r: 'Tomas', s: 'location', v: 'not there', q: 'Tomas was not there' },
      {
        p: 2,
        r: 'Tomas',
        s: 'age',
        v: 'four grown-up daughters',
        q: 'Tomas had four grown-up daughters'
      },
      {
        p: 3,
        r: 'Tomas',
        s: 'location',
        v: 'in his chair by the fire',
        q: 'He died in the night, in his chair by the fire'
      },
      {
        p: 4,
        r: 'Tomas',
        s: 'detail:occupation',
        v: 'the harbourmaster',
        q: 'Tomas was the harbourmaster'
      },
      // One claim, one slot: the same value on the same quote in another slot.
      {
        p: 4,
        r: 'Tomas',
        s: 'detail:rank',
        v: 'the harbourmaster',
        q: 'Tomas was the harbourmaster'
      },
      // Slots no longer read (plan ReaderNarrow.md), in any spelling: refused before any gate.
      {
        p: 5,
        r: 'Tomas',
        s: 'relation',
        v: 'attentions to Mara',
        q: "Tomas's attentions to Mara",
        o: 'Mara Vell'
      },
      { p: 5, r: 'Tomas', s: 'roles', v: 'attentions', q: "Tomas's attentions to Mara" },
      { p: 5, r: 'Tomas', s: 'objects', v: 'attentions', q: "Tomas's attentions to Mara" }
    ]
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return { text: readerReply(request, plan) }
    })
    await runReading(
      db,
      { ai: ai.deps },
      { nodeId: one, caretPara: null, requestId: 'r-3', observe: (event) => events.push(event) }
    )
    // The refusals are told as the ladder meets them; the occupation once the checker answered.
    expect(events.map((event) => [event.p, event.slot, event.outcome])).toEqual([
      [0, 'location', 'where'],
      [1, 'detail:occupation', 'possessed'],
      [2, 'location', 'absence'],
      [2, 'age', 'valueKind'],
      [3, 'location', 'past'],
      [4, 'detail:rank', 'duplicate'],
      [5, 'relation', 'notRead'],
      [5, 'roles', 'notRead'],
      [5, 'objects', 'notRead'],
      [4, 'detail:occupation', 'verified']
    ])
    // Only the occupation reached the checker.
    expect(claimsNow().map((claim) => [claim.slot, claim.value])).toEqual([
      ['detail:occupation', 'the harbourmaster']
    ])
    expect(lastReading(db, one, activeDraftId(db))?.yields).toMatchObject({
      verifySent: 1,
      verified: 1,
      rejections: {
        where: 1,
        possessed: 1,
        absence: 1,
        valueKind: 1,
        past: 1,
        duplicate: 1,
        notRead: 3
      }
    })
  })

  it('refuses a check that names no subject, voice or mode, or another record', async () => {
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ voice: null })) }
      }
      return {
        text: readerReply(request, [
          { p: 2, r: 'Tomas', s: 'detail:home', v: 'the nets', q: 'Tomas sat by the nets' }
        ])
      }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ unconfirmed: 1 })
  })

  it('takes the checker’s voice and mode over the reader’s', async () => {
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ voice: 'rumour', mode: 'memory' })) }
      }
      return {
        text: readerReply(request, [
          { p: 2, r: 'Tomas', s: 'detail:home', v: 'the nets', q: 'Tomas sat by the nets' }
        ])
      }
    })
    await read(ai)
    expect(claimsNow().map((claim) => [claim.voice, claim.mode, claim.proof])).toEqual([
      ['rumour', 'memory', 'verified']
    ])
  })

  it('refuses a pronoun more than one woman fits before any check, attached to nobody (third live run)', async () => {
    saveDocument(
      db,
      one,
      doc(
        'Mara and Lise sat by the window.',
        'She had green eyes, and in that light they looked gold.'
      )
    )
    scanNamesFor(db, one, NOW)
    const events: ReadingItemEvent[] = []
    // A gullible checker would pick Mara (the live run's checker picked Clara): it is never asked.
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: readerReply(request, [
          { p: 1, r: 'Mara Vell', s: 'eyes', v: 'green', q: 'She had green eyes' }
        ])
      }
    })
    await runReading(
      db,
      { ai: ai.deps },
      { nodeId: one, caretPara: null, requestId: 'r-amb', observe: (event) => events.push(event) }
    )
    expect(events.map((event) => event.outcome)).toEqual(['ambiguous'])
    expect(ai.requests.filter((request) => requestKind(request) === 'verify')).toEqual([])
    expect(claimsNow()).toEqual([])
    expect(invariants()).toEqual([])
  })

  it('refuses the third live run’s wrong facts in code, before any check (2026-10-14, 21:35)', async () => {
    saveDocument(
      db,
      one,
      doc(
        'Mara met Tomas at the Quay. He asked Lise for a dance.',
        'Ada was sorry. When they were children he had a scar on his hand.',
        'Old Tomas had kept the gate at the Quay for forty years.',
        "Tomas watched his second daughter. Mara's father was a merchant.",
        'Lise came in. She and her sisters walked on.'
      )
    )
    // A woman by her title: a he never means her.
    record('Ada Grey', ['Ada', 'Miss Grey'])
    scanNamesFor(db, one, NOW)
    const events: ReadingItemEvent[] = []
    const plan: PlannedClaim[] = [
      // A history done to Lise is the one's who did it, never hers (read again since
      // reader.v7, plan Suggestions.md: the actor gate refuses it).
      {
        p: 0,
        r: 'Lise',
        s: 'history',
        v: 'asked Lise for a dance',
        q: 'He asked Lise for a dance'
      },
      // A he for a woman: the scar is the old man's.
      {
        p: 1,
        r: 'Ada Grey',
        s: 'scars',
        v: 'a scar on his hand',
        q: 'When they were children he had a scar on his hand'
      },
      // A span of time is no age.
      {
        p: 2,
        r: 'Tomas',
        s: 'age',
        v: 'forty years',
        q: 'Old Tomas had kept the gate at the Quay for forty years'
      },
      // The relative is not the kinship of the one whose relative it is.
      { p: 3, r: 'Tomas', s: 'kinship', v: 'second daughter', q: 'his second daughter' },
      {
        p: 3,
        r: 'Mara Vell',
        s: 'kinship',
        v: 'father',
        q: "Mara's father was a merchant"
      },
      // A place is no one's location.
      { p: 2, r: 'the Quay', s: 'location', v: 'the Quay', q: 'kept the gate at the Quay' },
      // Relations: no longer read.
      { p: 4, r: 'Lise', s: 'relation', v: 'sisters', q: 'She and her sisters walked on' },
      {
        p: 4,
        r: 'Lise',
        s: 'relation',
        v: 'her sisters',
        q: 'She and her sisters walked on',
        o: 'Mara Vell'
      }
    ]
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return { text: readerReply(request, plan) }
    })
    await runReading(
      db,
      { ai: ai.deps },
      { nodeId: one, caretPara: null, requestId: 'r-4', observe: (event) => events.push(event) }
    )
    expect(events.map((event) => [event.p, event.slot, event.outcome])).toEqual([
      [0, 'history', 'actor'],
      [1, 'scars', 'subject'],
      [2, 'age', 'valueKind'],
      [3, 'kinship', 'possessed'],
      [3, 'kinship', 'possessed'],
      [2, 'location', 'kind'],
      [4, 'relation', 'notRead'],
      [4, 'relation', 'notRead']
    ])
    expect(ai.requests.filter((request) => requestKind(request) === 'verify')).toEqual([])
    expect(claimsNow()).toEqual([])
  })

  it('refuses the fourth live run’s wrong facts in code, the checker’s pick of another owner included (plan ReaderNarrow.md)', async () => {
    saveDocument(
      db,
      one,
      doc(
        'Mr. Hale had at first scarcely allowed Ada to be pretty.',
        'But soon he found her face rendered intelligent by the expression of her dark eyes.',
        'Hale had been standing near enough for Ada to overhear him.',
        '“Miss Grey was born at Gullhaven,” said Tomas.',
        'Tomas came in. His sisters were fine women.',
        'Ada turned her grey eyes away.'
      )
    )
    record('Mr. Hale', ['Hale'])
    record('Ada Grey', ['Ada', 'Miss Grey'])
    scanNamesFor(db, one, NOW)
    const events: ReadingItemEvent[] = []
    const dark = 'the expression of her dark eyes'
    const plan: PlannedClaim[] = [
      // "her dark eyes" as the man's: refused before any check.
      { p: 1, r: 'Mr. Hale', s: 'eyes', v: 'dark', q: dark },
      // As hers, but the checker gives them to him: refused after it.
      { p: 1, r: 'Ada Grey', s: 'eyes', v: 'dark', q: dark },
      // A clause is no place.
      {
        p: 2,
        r: 'Ada Grey',
        s: 'location',
        v: 'near enough for Ada to overhear him',
        q: 'Hale had been standing near enough for Ada to overhear him'
      },
      // A birthplace is no birth.
      {
        p: 3,
        r: 'Ada Grey',
        s: 'born',
        v: 'at Gullhaven',
        q: 'Miss Grey was born at Gullhaven',
        voice: 'dialogue',
        sp: 'Tomas'
      },
      // His sisters are his relatives, not what he is: no relation word for one person.
      {
        p: 4,
        r: 'Tomas',
        s: 'kinship',
        v: 'his sisters are fine women',
        q: 'His sisters were fine women'
      },
      // Her own eyes, as hers: kept.
      { p: 5, r: 'Ada Grey', s: 'eyes', v: 'grey', q: 'Ada turned her grey eyes away' }
    ]
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        // A gullible checker that gives the dark eyes to Mr. Hale.
        return {
          text: verifyReply(request, (check) =>
            check.text.includes('dark eyes')
              ? { r: check.who[check.names.indexOf('Mr. Hale')] ?? null }
              : null
          )
        }
      }
      return { text: readerReply(request, plan) }
    })
    await runReading(
      db,
      { ai: ai.deps },
      { nodeId: one, caretPara: null, requestId: 'r-6', observe: (event) => events.push(event) }
    )
    expect(events.map((event) => [event.p, event.slot, event.outcome])).toEqual([
      [1, 'eyes', 'subject'],
      [2, 'location', 'where'],
      [3, 'born', 'valueKind'],
      [4, 'kinship', 'value'],
      [1, 'eyes', 'subject'],
      [5, 'eyes', 'verified']
    ])
    expect(claimsNow().map((claim) => [claim.slot, claim.value, claim.state])).toEqual([
      ['eyes', 'grey', 'suggested']
    ])
    expect(invariants()).toEqual([])
  })

  it('pins first person to the speaker of a line of dialogue, and to the typed POV only when the text’s POV agrees', async () => {
    saveDocument(
      db,
      one,
      doc('"I was born in 1790," said Tomas.', 'I was born in the spring, I told myself.')
    )
    scanNamesFor(db, one, NOW)
    setSceneDetails(
      db,
      one,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: [],
        flashback: null
      },
      NOW
    )
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return {
          text: verifyReply(request, (check) =>
            check.label === 'Fact' && check.fact.includes('dialogue') ? { voice: 'dialogue' } : null
          )
        }
      }
      return {
        text: readerReply(request, [
          {
            p: 0,
            r: 'Tomas',
            s: 'born',
            v: 'in 1790',
            q: 'I was born in 1790',
            voice: 'dialogue',
            sp: 'Tomas'
          },
          { p: 1, r: 'Mara Vell', s: 'born', v: 'in the spring', q: 'I was born in the spring' }
        ])
      }
    })
    await read(ai)
    // Tomas's own line is his; the POV's first person waits on the text's POV, which no card verified.
    expect(claimsNow().map((claim) => [claim.recordId, claim.voice, claim.speakerId])).toEqual([
      [tomas, 'dialogue', tomas]
    ])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ subject: 1 })
  })

  it('keeps a new name’s proved facts waiting, asks about the name once, and attaches them on Yes', async () => {
    saveDocument(db, one, doc(...SCENE, 'By then Hesk was a smuggler from the marsh.'))
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: JSON.stringify({
          c: [],
          n: [
            {
              n: 'Hesk',
              p: 3,
              q: 'Hesk was a smuggler',
              c: [
                {
                  p: 3,
                  s: 'detail:occupation',
                  v: 'a smuggler',
                  q: 'Hesk was a smuggler from the marsh',
                  voice: 'narration',
                  mode: 'now'
                }
              ]
            }
          ]
        })
      }
    })
    const outcome = await read(ai)
    if (!outcome.read) throw new Error('not read')
    expect(outcome.names).toEqual(['hesk'])
    const [waiting] = claimsNow()
    expect(waiting).toMatchObject({
      recordId: null,
      state: 'waiting',
      pending: { kind: 'name', norm: 'hesk', text: 'Hesk' },
      subjectText: 'Hesk'
    })
    // Seen once, with a proved fact: asked about.
    expect(listNameQuestions(db).map((q) => [q.kind, q.name])).toContainEqual(['newName', 'Hesk'])
    const { result, settled } = answerNameQuestion(
      db,
      { kind: 'addAs', name: 'Hesk', categoryId: 'character' },
      NOW
    )
    if (result.kind !== 'record') throw new Error('no record')
    expect(settled?.attached).toEqual([waiting?.id])
    expect(claimsNow()[0]).toMatchObject({
      recordId: result.record.id,
      state: 'suggested',
      pending: null
    })
    expect(invariants()).toEqual([])
  })

  it('drops a waiting fact whose sentence changed on Yes (suggested again when read), and deletes them all on No', async () => {
    saveDocument(
      db,
      one,
      doc(...SCENE, 'By then Hesk was a smuggler from the marsh.', 'By then Ry was a boatman.')
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: JSON.stringify({
          n: [
            {
              n: 'Hesk',
              p: 3,
              q: 'Hesk was a smuggler',
              c: [
                {
                  p: 3,
                  s: 'detail:occupation',
                  v: 'a smuggler',
                  q: 'Hesk was a smuggler from the marsh'
                }
              ]
            },
            {
              n: 'Ry',
              p: 4,
              q: 'Ry was a boatman',
              c: [{ p: 4, s: 'detail:occupation', v: 'a boatman', q: 'Ry was a boatman' }]
            }
          ]
        })
      }
    })
    await read(ai)
    expect(claimsNow().map((claim) => claim.state)).toEqual(['waiting', 'waiting'])
    saveDocument(
      db,
      one,
      doc(
        ...SCENE,
        'By then Hesk was a smuggler from the marsh, once.',
        'By then Ry was a boatman.'
      )
    )
    const yes = answerNameQuestion(
      db,
      { kind: 'addAs', name: 'Hesk', categoryId: 'character' },
      NOW
    )
    expect(yes.settled?.restaled).toHaveLength(1)
    const no = answerNameQuestion(db, { kind: 'notAName', name: 'Ry' }, NOW)
    expect(no.settled?.deleted).toHaveLength(1)
    // Plan Suggestions.md: a fact whose sentence no longer stands is dropped, not kept stale.
    expect(claimsNow()).toEqual([])
  })

  it('drops a new name the author dismissed, and one the manuscript does not write there', async () => {
    dismiss(
      db,
      {
        kind: 'name',
        key: dismissedKey({ kind: 'name', name: 'Hesk' }),
        label: 'Hesk: not a name',
        quote: 'Hesk'
      },
      NOW
    )
    saveDocument(db, one, doc(...SCENE, 'By then Hesk was a smuggler from the marsh.'))
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: JSON.stringify({
          n: [
            {
              n: 'Hesk',
              p: 3,
              q: 'Hesk was a smuggler',
              c: [
                {
                  p: 3,
                  s: 'detail:occupation',
                  v: 'a smuggler',
                  q: 'Hesk was a smuggler from the marsh'
                }
              ]
            },
            {
              n: 'Varn',
              p: 3,
              q: 'Hesk was a smuggler',
              c: [
                {
                  p: 3,
                  s: 'detail:occupation',
                  v: 'a smuggler',
                  q: 'Hesk was a smuggler from the marsh'
                }
              ]
            }
          ]
        })
      }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ name: 2 })
  })

  it('drops a fact the author said is not right, by its value and its sentences', async () => {
    const shared = nameScanShared(db)
    dismiss(
      db,
      {
        kind: 'notRight',
        key: dismissedKey({
          kind: 'notRight',
          recordId: tomas,
          slot: 'location',
          value: 'by the nets',
          stating: [gateText('Tomas sat by the nets.', shared.index)]
        }),
        label: 'Tomas: by the nets',
        quote: 'Tomas sat by the nets'
      },
      NOW
    )
    await read(standard())
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes', 'location'])
  })

  it('answers an identical request from the local cache', async () => {
    const ai = standard()
    await read(ai)
    const sent = ai.requests.length
    // Forget the reading's results; the same messages go out again and hit the cache.
    session.connection.sqlite.exec('DELETE FROM claim; DELETE FROM card; DELETE FROM scene_read;')
    await read(ai)
    expect(ai.requests).toHaveLength(sent)
    expect(ai.ledger.filter((entry) => entry.cached)).toHaveLength(2)
    expect(claimsNow()).toHaveLength(3)
  })

  it('pauses on a local model that answers empty at its cap, storing nothing', async () => {
    const ai = fakeAi(() => ({ text: '', finishReason: 'length' }), { providerId: 'local' })
    expect(await read(ai)).toMatchObject({
      read: false,
      reason: 'localCutoff',
      model: 'gpt-5.4-mini'
    })
    expect(claimsNow()).toEqual([])
    expect(getSceneRead(db, one, activeDraftId(db))).toBeNull()
    expect(lastReading(db, one, activeDraftId(db))).toBeNull()
  })

  it('never reads an Idea scene or a node outside the manuscript', async () => {
    const chapter = getNode(db, one)?.parentId ?? ''
    const idea = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Idea'
    }).id
    saveDocument(db, idea, doc('Mara had blue eyes.'))
    setSceneMeta(db, idea, { ...parseStoredSceneMeta(null), status: 'idea' })
    const ai = standard()
    expect(
      await runReading(db, { ai: ai.deps }, { nodeId: idea, caretPara: null, requestId: 'r-3' })
    ).toEqual({ read: false, reason: 'notReadable' })
    expect(
      await runReading(db, { ai: ai.deps }, { nodeId: 'nope', caretPara: null, requestId: 'r-4' })
    ).toEqual({ read: false, reason: 'notReadable' })
    expect(ai.requests).toEqual([])
  })
})

describe('runReading: what changes under it, and what it cannot read (F-16.17, review 2026-10-12)', () => {
  it('drops what an edit saved while the checker was out leaves unproved, instead of suggesting it', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        // The author changes grey to brown mid-reading; the anchors job runs on that save.
        saveDocument(
          db,
          one,
          doc(SCENE[0] ?? '', "Mara's eyes were brown. She walked to the quay.", SCENE[2] ?? '')
        )
        runAnchors(db, one, NOW)
        return { text: verifyReply(request) }
      }
      return { text: readerReply(request, PLAN) }
    })
    await read(ai)
    // Plan Suggestions.md: a suggestion whose sentence changed goes (it is suggested again when
    // read), where a line the author accepted would go stale.
    expect(claimsNow().map((claim) => [claim.slot, claim.value, claim.state])).toEqual([
      ['location', 'by the nets', 'suggested']
    ])
    expect(invariants()).toEqual([])
  })

  it('drops what it suggested when the scene became an Idea while the requests were out', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        setSceneMeta(db, one, { ...parseStoredSceneMeta(null), status: 'idea' })
        return { text: verifyReply(request) }
      }
      return { text: readerReply(request, PLAN) }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
  })

  it('reads nothing from a reply that does not parse: the scene stays unread and is read again', async () => {
    const refusal = fakeAi(() => ({ text: 'Sorry, I cannot help with that.' }))
    const outcome = await read(refusal)
    expect(outcome).toMatchObject({ read: true, yields: { rejections: { unparsed: 1 } } })
    // Not cached: the same request is asked again, not answered with the same refusal.
    await read(refusal)
    expect(refusal.requests).toHaveLength(2)
    // The reading and its cost are kept; nothing counts as read.
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ unparsed: 1 })
    expect(getSceneRead(db, one, activeDraftId(db))).toBeNull()
    expect(claimsNow()).toEqual([])
    const good = standard()
    expect(await read(good)).toMatchObject({ read: true, purpose: 'first' })
    expect(good.requests.map(requestKind)).toContain('reader')
  })

  it('keeps the stale claims of a window whose reply does not parse, and reads the window again', async () => {
    await read(standard())
    acceptAll()
    saveDocument(
      db,
      one,
      doc(SCENE[0] ?? '', "Mara's eyes were brown. She walked to the quay.", SCENE[2] ?? '')
    )
    runAnchors(db, one, NOW)
    expect(claimsNow().filter((claim) => claim.state === 'stale')).toHaveLength(2)
    await read(fakeAi(() => ({ text: '' })))
    expect(claimsNow().filter((claim) => claim.state === 'stale')).toHaveLength(2)
    const again = standard()
    expect(await read(again)).toMatchObject({ read: true, purpose: 'window' })
    expect(again.requests.map(requestKind)).toContain('reader')
  })

  it('leaves the paragraphs of a retry that does not parse unread', async () => {
    let calls = 0
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      calls += 1
      if (calls === 1) {
        const whole = readerReply(request, PLAN)
        return { text: whole.slice(0, whole.indexOf('She walked') + 4), finishReason: 'length' }
      }
      return { text: 'I could not read that.' }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    // ¶1 and ¶2, the retries', stay unread: not a whole read, and read again next time.
    const reading = lastReading(db, one, activeDraftId(db))
    expect(reading?.paras).toEqual([[0, 0]])
    expect(getSceneRead(db, one, activeDraftId(db))?.partials).toBe(1)
  })

  it('reads a cut-off reply’s piece again whole when it listed facts out of paragraph order', async () => {
    let calls = 0
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      calls += 1
      const reordered = [PLAN[2], PLAN[0], PLAN[1]].flatMap((claim) =>
        claim === undefined ? [] : [claim]
      )
      if (calls === 1) {
        const whole = readerReply(request, reordered)
        // Cut inside the third item: ¶2, then ¶1, salvaged.
        return { text: whole.slice(0, whole.indexOf('She walked') + 4), finishReason: 'length' }
      }
      return { text: readerReply(request, PLAN) }
    })
    await read(ai)
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers).toHaveLength(3)
    expect([...sentParagraphs(nth(readers, 1)).keys()]).toEqual([0, 1])
    expect([...sentParagraphs(nth(readers, 2)).keys()]).toEqual([2])
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes', 'location', 'location'])
  })

  it('locates a card field and who is on the page from page 2 in page 2’s own text', async () => {
    const filler = 'The tide ran out across the mudflats and the gulls followed it. '.repeat(20)
    const long = [
      ...SCENE,
      ...Array.from({ length: 8 }, () => filler.trim()),
      'Tomas waited at the harbour wall until dark.'
    ]
    saveDocument(db, one, doc(...long))
    scanNamesFor(db, one, NOW)
    const last = long.length - 1
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      const ids = rosterIds(request)
      const second = sentParagraphs(request).has(last)
      const card = second
        ? {
            ...CARD,
            where: ['the harbour wall', last, 'Tomas waited at the harbour wall'],
            present: [[ids.get('Tomas') ?? '', last, 'Tomas waited at the harbour wall']]
          }
        : { ...CARD, where: null }
      return { text: readerReply(request, PLAN, { card }) }
    })
    await read(ai)
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers.length).toBeGreaterThan(1)
    const card = getCard(db, one, activeDraftId(db))
    expect(card?.line).toBe('Mara walks to the quay.')
    expect(card?.fields.where).toMatchObject({ value: 'the harbour wall', p: last })
    expect(card?.present).toEqual([
      { recordId: tomas, quote: 'Tomas waited at the harbour wall', p: last, verified: true }
    ])
    // The on-page check went in the batch of the page that gave it.
    const checks = ai.requests
      .filter((request) => requestKind(request) === 'verify')
      .flatMap((request) => sentChecks(request))
    expect(checks.find((check) => check.label === 'On the page')?.text).toContain('harbour wall')
  })
})

describe('runReading: the checker’s verdicts (F-16.17, review 2026-10-12)', () => {
  // Three facts code cannot prove, in one batch on the fast tier (every batch since plan
  // ReaderNarrow.md retired the strong one).
  const UNPROVED: PlannedClaim[] = [
    { p: 1, r: 'Mara Vell', s: 'detail:home', v: 'the quay', q: 'She walked to the quay' },
    { p: 1, r: 'Mara Vell', s: 'detail:mark', v: 'grey eyes', q: "Mara's eyes were grey" },
    { p: 2, r: 'Tomas', s: 'detail:home', v: 'the nets', q: 'Tomas sat by the nets' }
  ]

  it('asks again for the verdicts a cut-off reply left out', async () => {
    let calls = 0
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) !== 'verify') return { text: readerReply(request, UNPROVED) }
      calls += 1
      if (calls === 1) {
        const whole = verifyReply(request)
        return { text: whole.slice(0, whole.indexOf('},{"i":2') + 1), finishReason: 'length' }
      }
      return { text: verifyReply(request) }
    })
    await read(ai)
    const checks = ai.requests.filter((request) => requestKind(request) === 'verify')
    expect(checks).toHaveLength(2)
    expect(sentChecks(nth(checks, 1))).toHaveLength(2)
    expect(checks.every((request) => request.tier === 'fast')).toBe(true)
    expect(claimsNow().map((claim) => [claim.slot, claim.state])).toEqual([
      ['detail:mark', 'suggested'],
      ['detail:home', 'suggested'],
      ['detail:home', 'suggested']
    ])
    // Every verdict came on the second ask: a recovered cut, no cut-off of the reading.
    expect(lastReading(db, one, activeDraftId(db))).toMatchObject({
      finishReason: null,
      yields: { cut: 1, verifySent: 3, verified: 3, rejected: 0 }
    })
  })

  it('never counts a fact the checker did not answer against it, and reads its paragraph again', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) !== 'verify') return { text: readerReply(request, UNPROVED) }
      const whole = verifyReply(request)
      // Every reply stops after its first verdict.
      return { text: whole.slice(0, whole.indexOf('},{"i":2') + 1), finishReason: 'length' }
    })
    await read(ai)
    const reading = lastReading(db, one, activeDraftId(db))
    expect(reading?.yields).toMatchObject({
      verifySent: 2,
      verified: 2,
      rejections: { unanswered: 1 },
      cut: 2
    })
    expect(reading?.finishReason).toBe('length')
    // ¶2 (Tomas) was not read through: it is read again.
    expect(reading?.paras).toEqual([[0, 1]])
    const again = standard()
    await read(again)
    const reader = again.requests.find((request) => requestKind(request) === 'reader')
    expect([...sentParagraphs(nth(reader === undefined ? [] : [reader], 0)).keys()]).toContain(2)
  })

  it('refuses a fact only the checker’s refusal of that very fact, not a neighbour on its quote', async () => {
    const dashing: PlannedClaim = {
      p: 2,
      r: 'Tomas',
      s: 'detail:home',
      v: 'the nets',
      q: 'Tomas sat by the nets'
    }
    await read(standard([dashing]))
    expect(claimsNow().map((claim) => [claim.value, claim.state])).toEqual([
      ['the nets', 'suggested']
    ])
    // An edit two paragraphs up (its anchor holds): the window read proposes another value on the
    // same quote and says to drop c1.
    saveDocument(
      db,
      one,
      doc(SCENE[0] ?? '', "Mara's eyes were green. She walked to the quay.", SCENE[2] ?? '')
    )
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ ok: false })) }
      }
      const tail = request.messages.at(-1)?.content ?? ''
      const short = /(c\d+) r\d+ detail:home “the nets”/.exec(tail)?.[1]
      return {
        text: readerReply(request, [{ ...dashing, v: 'nets' }], {
          drop: short === undefined ? [] : [short]
        })
      }
    })
    await runReading(db, { ai: ai.deps }, { nodeId: one, caretPara: null, requestId: 'r-5' })
    expect(
      claimsNow()
        .filter((claim) => claim.slot === 'detail:home')
        .map((claim) => [claim.value, claim.state])
    ).toEqual([['the nets', 'suggested']])
  })

  it('pins first person to a speaker only in what the checker confirms is their line', async () => {
    saveDocument(db, one, doc('Tomas sat down.', '“I was born in 1790,” he said.'))
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      // The checker reads the line as narration: first person then points to nobody.
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: readerReply(request, [
          {
            p: 1,
            r: 'Tomas',
            s: 'born',
            v: 'in 1790',
            q: 'I was born in 1790',
            voice: 'dialogue',
            sp: 'Tomas'
          }
        ])
      }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ subject: 1 })
  })

  it('refuses a pronoun whose one candidate the checker says does not fit', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ r: null })) }
      }
      return { text: readerReply(request, [PLAN[1] ?? PLAN[0] ?? ({} as PlannedClaim)]) }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ unconfirmed: 1 })
  })
})

describe('runReading: who a pronoun may mean (F-16.17, review 2026-10-12)', () => {
  it('refuses a she whose nearest possible antecedent is someone else, before any check (third live run)', async () => {
    record('Clara Pell', ['Clara'])
    saveDocument(
      db,
      one,
      doc('Clara and Lise sat by the window. Tomas brought the tea. She had green eyes.')
    )
    scanNamesFor(db, one, NOW)
    const events: ReadingItemEvent[] = []
    // No title gives Tomas a gender, so the nearest sentence's Tomas may be "She"; Clara is not
    // the one the text points to, whatever a checker would pick.
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: readerReply(request, [
          { p: 0, r: 'Clara Pell', s: 'eyes', v: 'green', q: 'She had green eyes' }
        ])
      }
    })
    await runReading(
      db,
      { ai: ai.deps },
      { nodeId: one, caretPara: null, requestId: 'r-she', observe: (event) => events.push(event) }
    )
    expect(events.map((event) => event.outcome)).toEqual(['subject'])
    expect(ai.requests.filter((request) => requestKind(request) === 'verify')).toEqual([])
    expect(claimsNow()).toEqual([])
  })

  it('offers the checker every candidate when the one woman in reach is the subject', async () => {
    const clara = record('Clara Pell', ['Clara', 'Miss Pell'])
    saveDocument(
      db,
      one,
      doc('Tomas sat by the window. Miss Pell brought the tea. She had green eyes.')
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        return {
          text: verifyReply(request, (check) => ({
            r: check.who[check.names.indexOf('Clara Pell')] ?? null
          }))
        }
      }
      return {
        text: readerReply(request, [
          { p: 0, r: 'Clara Pell', s: 'eyes', v: 'green', q: 'She had green eyes' }
        ])
      }
    })
    await read(ai)
    const [check] = sentChecks(nth(ai.requests, 1))
    expect([...(check?.names ?? [])].sort()).toEqual(['Clara Pell', 'Tomas'])
    const [claim] = claimsNow()
    expect(claim).toMatchObject({ recordId: clara, state: 'suggested', value: 'green' })
  })

  it('refuses a fact whose sentence names someone the roster does not know (the twin rule)', async () => {
    const rynna = record('Rynna Falsire', ['Rynna'])
    saveDocument(db, one, doc('Rynna Falsire came in. Jem Falsire had green eyes.'))
    scanNamesFor(db, one, NOW)
    const ai = standard([
      { p: 0, r: 'Rynna Falsire', s: 'eyes', v: 'green', q: 'Jem Falsire had green eyes' }
    ])
    await read(ai)
    expect(ai.requests.map(requestKind)).toEqual(['reader'])
    expect(claimsNow().filter((claim) => claim.recordId === rynna)).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ subject: 1 })
  })

  it('offers a record the text points to only by a role, marked as not named there', async () => {
    saveDocument(
      db,
      one,
      doc('Tomas could never make his wife understand him. She had a long scar.')
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        // "his wife": the checker picks the marked record.
        return {
          text: verifyReply(request, (check) =>
            check.unnamed.length === 1 ? { r: check.unnamed[0] } : null
          )
        }
      }
      return {
        text: readerReply(request, [
          { p: 0, r: 'Lise', s: 'scars', v: 'a long scar', q: 'She had a long scar' }
        ])
      }
    })
    await read(ai)
    const [check] = sentChecks(nth(ai.requests, 1))
    expect(check?.names).toEqual(['Tomas', 'Lise'])
    expect(check?.unnamed).toHaveLength(1)
    expect(claimsNow().map((claim) => [claim.recordId, claim.slot, claim.state])).toEqual([
      [lise, 'scars', 'suggested']
    ])
    expect(invariants()).toEqual([])
  })
})

describe('runReading: new names (F-16.17, review 2026-10-12)', () => {
  /** A new name's item: the name, where it stands, and one occupation fact on the same quote. */
  const nameItem = (n: string, p: number, q: string, fact: string): Record<string, unknown> => ({
    n,
    p,
    q,
    c: [{ p, s: 'detail:occupation', v: fact, q }]
  })
  const named = (n: string, p: number, q: string, fact: string): string =>
    JSON.stringify({ n: [nameItem(n, p, q, fact)] })

  it('drops a name seen only opening a sentence, and a titled look-alike no question asks about', async () => {
    saveDocument(
      db,
      one,
      doc('Hesk was a smuggler from the marsh.', 'At dusk Captain Vell was a smuggler too.')
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: JSON.stringify({
          n: [
            nameItem('Hesk', 0, 'Hesk was a smuggler from the marsh', 'a smuggler'),
            nameItem('Captain Vell', 1, 'Captain Vell was a smuggler too', 'a smuggler')
          ]
        })
      }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ name: 2 })
  })

  it('makes a name two records share wait on them, for the scan to settle', async () => {
    const owners = ['Mr. Harrow', 'Mrs. Harrow'].map((name) => {
      const made = createRecord(
        db,
        { name, categoryId: 'character', aliases: [{ text: 'Harrow', shared: true }], force: true },
        NOW
      )
      if (!('record' in made)) throw new Error('blocked')
      return made.record.id
    })
    saveDocument(db, one, doc('At noon Harrow was a magistrate again.'))
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return { text: named('Harrow', 0, 'Harrow was a magistrate again', 'a magistrate') }
    })
    await read(ai)
    const [claim] = claimsNow()
    expect(claim).toMatchObject({ recordId: null, state: 'waiting', subjectText: 'Harrow' })
    expect(claim?.pending).toEqual({ kind: 'subject', candidates: [...owners].sort() })
  })

  it('settles facts waiting on a name once a record answers to it, however it was made', async () => {
    saveDocument(db, one, doc(...SCENE, 'By then Hesk was a smuggler from the marsh.'))
    scanNamesFor(db, one, NOW)
    await read(
      fakeAi((request): FakeAnswer => {
        if (requestKind(request) === 'verify') return { text: verifyReply(request) }
        return { text: named('Hesk', 3, 'Hesk was a smuggler from the marsh', 'a smuggler') }
      })
    )
    expect(claimsNow()).toMatchObject([{ state: 'waiting', pending: { kind: 'name' } }])
    // Made in the Story bible, not through the question: the name is on the roster now.
    const hesk = record('Hesk')
    expect(listNameQuestions(db).map((question) => question.name)).not.toContain('Hesk')
    const settled = settleOwnedNames(db, NOW)
    expect(settled.attached).toHaveLength(1)
    expect(claimsNow()).toMatchObject([{ recordId: hesk, state: 'suggested', pending: null }])
  })

  it('drops a waiting fact on Yes when its scene is no longer readable', async () => {
    saveDocument(db, one, doc(...SCENE, 'By then Hesk was a smuggler from the marsh.'))
    scanNamesFor(db, one, NOW)
    await read(
      fakeAi((request): FakeAnswer => {
        if (requestKind(request) === 'verify') return { text: verifyReply(request) }
        return { text: named('Hesk', 3, 'Hesk was a smuggler from the marsh', 'a smuggler') }
      })
    )
    setSceneMeta(db, one, { ...parseStoredSceneMeta(null), status: 'idea' })
    const { settled } = answerNameQuestion(
      db,
      { kind: 'addAs', name: 'Hesk', categoryId: 'character' },
      NOW
    )
    expect(settled?.restaled).toHaveLength(1)
    expect(claimsNow()).toEqual([])
  })
})

describe('runReading: slice 3 purposes and spot checks (F-16.16, F-16.17)', () => {
  it('rides a picked literal claim on the check batch as a fast spot check, counted only', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        // The checker disagrees with code about the eyes: counted, the claim stays.
        return {
          text: verifyReply(request, (check) =>
            check.fact.startsWith('eyes') ? { ok: false } : null
          )
        }
      }
      return { text: readerReply(request, PLAN) }
    })
    await runReading(
      db,
      { ai: ai.deps },
      { nodeId: one, caretPara: null, requestId: 'r-spot', spotEvery: 1 }
    )
    const eyes = claimsNow().find((claim) => claim.slot === 'eyes')
    expect(eyes).toMatchObject({
      proof: 'literal',
      state: 'suggested',
      spot: 'disagree',
      spotTier: 'fast'
    })
    const checked = ai.requests
      .filter((request) => requestKind(request) === 'verify')
      .flatMap((request) => sentChecks(request).map((check) => check.fact))
    expect(checked.some((fact) => fact.startsWith('eyes'))).toBe(true)
    // Its yields are the reader's: a spot check is neither sent nor verified.
    expect(lastReading(db, one, activeDraftId(db))?.yields.literal).toBeGreaterThan(0)
  })

  it('replaces on a rebuild what it does not prove again, and reads a back-fill’s paragraphs whatever the gate says', async () => {
    await read(standard())
    expect(
      claimsNow()
        .map((claim) => claim.slot)
        .sort()
    ).toEqual(['eyes', 'location', 'location'])
    // A rebuild that finds only the eyes: the rest goes (P2a-D25).
    const rebuilt = await runReading(
      db,
      { ai: standard(PLAN.slice(0, 1)).deps },
      { nodeId: one, caretPara: null, requestId: 'r-rebuild', purpose: 'rebuild' }
    )
    expect(rebuilt).toMatchObject({ read: true, purpose: 'rebuild' })
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes'])
    // Up to date for the gate, yet a back-fill reads ¶2 ±2.
    const backfill = standard()
    const outcome = await runReading(
      db,
      { ai: backfill.deps },
      { nodeId: one, caretPara: null, requestId: 'r-backfill', purpose: 'backfill', paras: [2] }
    )
    expect(outcome).toMatchObject({ read: true, purpose: 'backfill' })
    const sent = backfill.requests.find((request) => requestKind(request) === 'reader')
    expect([...sentParagraphs(nth(sent === undefined ? [] : [sent], 0)).keys()]).toEqual([0, 1, 2])
    expect(
      claimsNow()
        .map((claim) => claim.slot)
        .sort()
    ).toEqual(['eyes', 'location', 'location'])
  })
})
